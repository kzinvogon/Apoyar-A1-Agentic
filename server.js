// APP_MODE routing - must be at the very top before any other requires
if (process.env.APP_MODE === 'teams') {
  console.log('🤖 APP_MODE=teams detected, starting Teams Connector...');
  require('./teams-connector/server.js');
} else {
// Main ServiFlow app starts here
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Trust proxy for Railway (needed for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Track database status for health check
let dbStatus = { initialized: false, error: null };

// Database initialization
const { 
  initializeMasterDatabase, 
  initializeTenantDatabase, 
  closeAllConnections 
} = require('./config/database');

// Import routes
const authRoutes = require('./routes/auth');
const masterRoutes = require('./routes/master');
const ticketRoutes = require('./routes/tickets');
const cmdbRoutes = require('./routes/cmdb');
const cmdbTypesRoutes = require('./routes/cmdb-types');
const cmdbCustomFieldsRoutes = require('./routes/cmdb-custom-fields');
const cmdbRelationshipsRoutes = require('./routes/cmdb-relationships');
const cmdbHistoryRoutes = require('./routes/cmdb-history');
const profileRoutes = require('./routes/profile');
const emailIngestRoutes = require('./routes/email-ingest');
const usageRoutes = require('./routes/usage');
const analyticsRoutes = require('./routes/analytics');
const chatbotRoutes = require('./routes/chatbot');
const publicTicketRoutes = require('./routes/public-ticket');
const expertsRoutes = require('./routes/experts');
const customersRoutes = require('./routes/customers');
const customerCompaniesRoutes = require('./routes/customer-companies');
const ticketRulesRoutes = require('./routes/ticket-rules');
const expertPermissionsRoutes = require('./routes/expert-permissions');
const aiSuggestionsRoutes = require('./routes/ai-suggestions');
const knowledgeBaseRoutes = require('./routes/knowledge-base');
const rawVariablesRoutes = require('./routes/raw-variables');
const integrationsTeamsRoutes = require('./routes/integrations-teams');
const integrationsSlackRoutes = require('./routes/integrations-slack');
const slaRoutes = require('./routes/sla');
const adminRoutes = require('./routes/admin');
const notificationsRoutes = require('./routes/notifications');
const tenantSettingsRoutes = require('./routes/tenant-settings');
const companyAdminRoutes = require('./routes/company-admin');
const featureFlagsRoutes = require('./routes/feature-flags');
const plansPublicRoutes = require('./routes/plans-public');
const marketingRoutes = require('./routes/marketing');
const signupRoutes = require('./routes/signup');
const billingRoutes = require('./routes/billing');
const chatRoutes = require('./routes/chat');

// Import email processor service
const { startEmailProcessing } = require('./services/email-processor');

// Import housekeeping service
const housekeeping = require('./services/housekeeping');

// Import chat socket service
const { initializeChatSocket } = require('./services/chat-socket');

// Import rate limiter
const { apiLimiter } = require('./middleware/rateLimiter');

// Middleware - Disable CSP and some policies for Safari compatibility
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
// Save raw body for Stripe webhook verification
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl === '/api/billing/webhook') {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true }));

// Apply global rate limiting to all API routes
app.use('/api', apiLimiter);

// Marketing site routes (must be BEFORE static middleware to take precedence)
app.use('/marketing', marketingRoutes);

// Serve uploaded files (chat attachments, etc.)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve static files from the current directory with no-cache for HTML
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/master', masterRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/cmdb', cmdbRoutes);
app.use('/api/cmdb-types', cmdbTypesRoutes);
app.use('/api/cmdb', cmdbCustomFieldsRoutes);
app.use('/api/cmdb', cmdbRelationshipsRoutes);
app.use('/api/cmdb', cmdbHistoryRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/email-ingest', emailIngestRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/experts', expertsRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/customer-companies', customerCompaniesRoutes);
app.use('/api/ticket-rules', ticketRulesRoutes);
app.use('/api/expert-permissions', expertPermissionsRoutes);
app.use('/api/ai', aiSuggestionsRoutes);
app.use('/api/kb', knowledgeBaseRoutes);
app.use('/api/raw-variables', rawVariablesRoutes);
app.use('/api/integrations', integrationsTeamsRoutes);
app.use('/api/integrations', integrationsSlackRoutes);
app.use('/api/sla', slaRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/tenant-settings', tenantSettingsRoutes);
app.use('/api/company-admin', companyAdminRoutes);
app.use('/api/features', featureFlagsRoutes);
app.use('/api/plans', plansPublicRoutes);
app.use('/api/signup', signupRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/chat', chatRoutes);

// Public routes (no authentication required) - Must be before authenticated routes
app.use('/ticket', publicTicketRoutes);

// Teams app manifest download
app.get('/teams-manifest.zip', (req, res) => {
  const manifestPath = path.join(__dirname, 'teams-connector', 'manifest.zip');
  res.download(manifestPath, 'serviflow-teams-app.zip', (err) => {
    if (err) {
      console.error('Teams manifest download error:', err);
      res.status(404).json({ error: 'Teams app manifest not found. Please run "npm run manifest" in the teams-connector folder.' });
    }
  });
});

// Main route - serve the HTML file
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'A1 Support Build from here .html'));
});

// Login route - redirect to main app (login screen is shown by default in SPA)
app.get('/login', (req, res) => {
  res.redirect('/');
});

// Accept invitation route - for invited experts to set their password
app.get('/accept-invite', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'accept-invite.html'));
});

// Tickets list route - deep link from Teams bot
app.get('/tickets', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'A1 Support Build from here .html'));
});

// Ticket view route - serves HTML for email links
app.get('/ticket/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'A1 Support Build from here .html'));
});

// Settings/integrations route - for Teams OAuth callback redirect
app.get('/settings/integrations', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'A1 Support Build from here .html'));
});

// Health check endpoint - always returns 200 so Railway health checks pass
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'ServiFlow Support Platform is running',
    timestamp: new Date().toISOString(),
    version: '2.2.0-fullscreen',
    deployedAt: process.env.RAILWAY_DEPLOYMENT_ID || 'local',
    database: dbStatus.initialized ? 'connected' : (dbStatus.error || 'initializing'),
    authRequired: true,
    features: [
      'Multi-tenant MySQL backend',
      'Master admin system',
      'Role-based authentication',
      'Tenant isolation',
      'Real-time SLA tracking',
      'Rate limiting protection',
      'Input validation'
    ]
  });
});

/**
 * GET /api/runtime-info
 * Returns runtime environment info for debugging environment confusion
 * Read-only, no authentication required
 */
app.get('/api/runtime-info', (req, res) => {
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // Git not available or not a repo
  }

  res.json({
    environment: process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || 'local',
    service: process.env.RAILWAY_SERVICE_NAME || 'web',
    appMode: process.env.APP_MODE || 'web',
    dbHost: process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost',
    dbPort: process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306',
    gitCommit,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || 'local',
    emailProcessingDisabled: process.env.DISABLE_EMAIL_PROCESSING === 'true',
    timestamp: new Date().toISOString()
  });
});

// Version endpoint with git SHA and build info
const BUILD_TIME = new Date().toISOString();
const GIT_SHA = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'unknown';
const ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || 'development';

app.get('/api/version', (req, res) => {
  res.json({
    success: true,
    version: {
      app: '2.1.0',
      git_sha: GIT_SHA,
      git_sha_short: GIT_SHA.substring(0, 7),
      build_time: BUILD_TIME,
      environment: ENVIRONMENT,
      node_version: process.version,
      deployment_id: process.env.RAILWAY_DEPLOYMENT_ID || null
    }
  });
});

// Database status endpoint (enhanced with pool stats)
app.get('/api/db/status', async (req, res) => {
  try {
    const { masterQuery, getPoolStats, healthCheck } = require('./config/database');

    // Get basic counts using the new query method
    const tenantCount = await masterQuery("SELECT COUNT(*) as count FROM tenants WHERE status = 'active'");
    const userCount = await masterQuery('SELECT COUNT(*) as count FROM master_users WHERE is_active = TRUE');

    // Get pool statistics
    const poolStats = getPoolStats();

    // Get health check results
    const health = await healthCheck();

    res.json({
      success: true,
      master_db: 'connected',
      active_tenants: tenantCount[0].count,
      master_users: userCount[0].count,
      pool: {
        stats: poolStats,
        health: health,
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      master_db: 'error',
      error: error.message,
      isSchemaError: error.isSchemaError || false,
      isFatalConnectionError: error.isFatalConnectionError || false,
      timestamp: new Date().toISOString()
    });
  }
});

// Pool status endpoint for monitoring/alerting (protected)
app.get('/api/pool/status', async (req, res) => {
  // Security: require POOL_STATUS_KEY to be configured
  const expectedKey = process.env.POOL_STATUS_KEY;
  if (!expectedKey) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Validate header matches configured key
  if (req.headers['x-pool-status-key'] !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { getPoolStats, healthCheck } = require('./config/database');

    const stats = getPoolStats();
    const health = await healthCheck();

    // Calculate if pool is healthy
    const isHealthy = health.master === true &&
      Object.values(health.tenants).every(v => v === true);

    // Sanitize stats - remove sensitive info (hostnames, DB names, credentials)
    const sanitizedStats = {
      masterPool: stats.masterPool ? {
        queries: stats.masterPool.queries,
        errors: stats.masterPool.errors,
        reconnects: stats.masterPool.reconnects,
        schemaErrors: stats.masterPool.schemaErrors,
        queueWarnings: stats.masterPool.queueWarnings,
        created: stats.masterPool.created,
        lastQuery: stats.masterPool.lastQuery,
        lastError: stats.masterPool.lastError,
      } : null,
      tenantCount: Object.keys(stats.tenantPools).length,
      tenants: Object.fromEntries(
        Object.entries(stats.tenantPools).map(([key, val]) => [
          key,
          {
            queries: val.queries,
            errors: val.errors,
            reconnects: val.reconnects,
            schemaErrors: val.schemaErrors,
            queueWarnings: val.queueWarnings,
            created: val.created,
            lastQuery: val.lastQuery,
            lastError: val.lastError,
          }
        ])
      ),
    };

    // Sanitize health - just boolean status, no error messages with paths
    const sanitizedHealth = {
      master: health.master === true,
      tenants: Object.fromEntries(
        Object.entries(health.tenants).map(([key, val]) => [key, val === true])
      ),
    };

    res.json({
      success: true,
      healthy: isHealthy,
      stats: sanitizedStats,
      health: sanitizedHealth,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      healthy: false,
      error: 'Internal error',
      timestamp: new Date().toISOString()
    });
  }
});

// Run all tenant migrations (only when RUN_MIGRATIONS=true)
async function runAllMigrations(tenantCode) {
  console.log(`📋 Running migrations for tenant: ${tenantCode}...`);

  const migrations = [
    { name: 'CMDB schema', fn: async () => { const { runCMDBMigration } = require('./scripts/migrate-cmdb-inline'); await runCMDBMigration(tenantCode); }},
    { name: 'Ticket-CMDB relations', fn: async () => { const { runMigration } = require('./migrations/add-ticket-cmdb-relations'); await runMigration(tenantCode); }},
    { name: 'Knowledge Base', fn: async () => { const { runMigration } = require('./migrations/add-knowledge-base'); await runMigration(tenantCode); }},
    { name: 'Email notifications column', fn: async () => { const { runMigration } = require('./migrations/add-email-notifications-column'); await runMigration(tenantCode); }},
    { name: 'Must reset password', fn: async () => { const { runMigration } = require('./migrations/add-must-reset-password'); await runMigration(tenantCode); }},
    { name: 'Invitation columns', fn: async () => { const { runMigration } = require('./migrations/add-invitation-columns'); await runMigration(tenantCode); }},
    { name: 'Soft delete columns', fn: async () => { const { runMigration } = require('./migrations/add-soft-delete-columns'); await runMigration(tenantCode); }},
    { name: 'Teams user preferences', fn: async () => { const { runMigration } = require('./migrations/add-teams-user-preferences'); await runMigration(tenantCode); }},
    { name: 'SLA definitions', fn: async () => { const { runMigration } = require('./migrations/add-sla-definitions'); await runMigration(tenantCode); }},
    { name: 'Resolve after response', fn: async () => { const { runMigration } = require('./migrations/add-resolve-after-response'); await runMigration(tenantCode); }},
    { name: 'SLA ticket fields', fn: async () => { const { runMigration } = require('./migrations/add-sla-ticket-fields'); await runMigration(tenantCode); }},
    { name: 'SLA notification fields', fn: async () => { const { runMigration } = require('./migrations/add-sla-notification-fields'); await runMigration(tenantCode); }},
    { name: 'SLA source fields', fn: async () => { const { runMigration } = require('./migrations/add-sla-source-fields'); await runMigration(tenantCode); }},
    { name: 'Ticket SLA source', fn: async () => { const { runMigration } = require('./migrations/add-ticket-sla-source'); await runMigration(tenantCode); }},
    { name: 'Category SLA mappings', fn: async () => { const { runMigration } = require('./migrations/add-category-sla-mappings'); await runMigration(tenantCode); }},
    { name: 'Tenant settings', fn: async () => { const { migrate } = require('./migrations/add-tenant-settings'); await migrate(tenantCode); }},
    { name: 'Customer SLA override', fn: async () => { const { migrate } = require('./migrations/add-customer-sla-override'); await migrate(tenantCode); }},
    { name: 'Last login column', fn: async () => { const { migrate } = require('./migrations/add-last-login-column'); await migrate(tenantCode); }},
    { name: 'Tenant features', fn: async () => { const { migrate } = require('./migrations/add-tenant-features'); await migrate(tenantCode, 'professional'); }},
    { name: 'CMDB V2', fn: async () => { const { runMigration } = require('./migrations/add-cmdb-v2-tables'); await runMigration(tenantCode); }},
    { name: 'Chat system', fn: async () => { const { runMigration } = require('./migrations/add-chat-system'); await runMigration(tenantCode); }},
  ];

  let successCount = 0;
  let failCount = 0;

  for (const migration of migrations) {
    try {
      await migration.fn();
      successCount++;
    } catch (error) {
      failCount++;
      console.warn(`⚠️  Migration "${migration.name}" failed:`, error.message);
    }
  }

  console.log(`✅ Migrations complete: ${successCount} succeeded, ${failCount} failed`);
}

// Initialize database and start server
async function startServer() {
  console.log('🚀 Starting ServiFlow Support Platform...');

  // Check if migrations should run
  const shouldRunMigrations = process.env.RUN_MIGRATIONS === 'true';
  if (shouldRunMigrations) {
    console.log('📋 RUN_MIGRATIONS=true - migrations will run at startup');
  } else {
    console.log('ℹ️  Migrations disabled (set RUN_MIGRATIONS=true to enable)');
  }

  // Check if email processing should run in this process
  const shouldRunEmailProcessing = process.env.DISABLE_EMAIL_PROCESSING !== 'true';
  if (!shouldRunEmailProcessing) {
    console.log('ℹ️  Email processing disabled (DISABLE_EMAIL_PROCESSING=true)');
  }

  // Initialize Socket.io for live chat
  initializeChatSocket(server);

  // Start the HTTP server FIRST so health checks work
  server.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 ServiFlow Support Platform is running!`);
    console.log(`📱 Open your browser and go to: http://localhost:${PORT}`);
    console.log(`🔧 Health check: http://localhost:${PORT}/health`);
    console.log(`📊 Database status: http://localhost:${PORT}/api/db/status`);

    // Now initialize database in background
    console.log('📊 Initializing database connections...');

    try {
      // Initialize master database (creates tables if needed - idempotent)
      await initializeMasterDatabase();
      console.log('✅ Master database initialized');
      dbStatus.initialized = true;

      // Initialize default tenant database
      try {
        await initializeTenantDatabase('apoyar');
        console.log('✅ Tenant database "apoyar" initialized');

        // Run migrations only if explicitly enabled
        if (shouldRunMigrations) {
          await runAllMigrations('apoyar');
        }

        // Start email processing only if not disabled
        if (shouldRunEmailProcessing) {
          try {
            await startEmailProcessing('apoyar');
            console.log('✅ Email processing service started for tenant "apoyar"');
          } catch (emailError) {
            console.warn(`⚠️  Warning: Could not start email processing:`, emailError.message);
          }
        }

        // Start SLA notification scheduler (unless disabled for separate worker deployment)
        if (process.env.DISABLE_SLA_SCHEDULER === 'true') {
          console.log('ℹ️  SLA scheduler disabled (DISABLE_SLA_SCHEDULER=true) - use sla-worker.js separately');
        } else {
          try {
            const { startScheduler } = require('./services/sla-notifier');
            startScheduler(5 * 60 * 1000); // Every 5 minutes
            console.log('✅ SLA notification scheduler started (set DISABLE_SLA_SCHEDULER=true to use separate worker)');
          } catch (schedulerError) {
            console.warn(`⚠️  Warning: Could not start SLA scheduler:`, schedulerError.message);
          }
        }
      } catch (error) {
        console.warn(`⚠️  Warning: Could not initialize tenant 'apoyar':`, error.message);
      }

      // Start housekeeping scheduler (daily at 3 AM)
      try {
        housekeeping.startScheduler();
      } catch (hkError) {
        console.warn(`⚠️  Warning: Could not start housekeeping scheduler:`, hkError.message);
      }

      console.log(`\n✨ Features available:`);
      console.log(`   • Multi-tenant MySQL backend`);
      console.log(`   • Master admin system`);
      console.log(`   • Role-based authentication`);
      console.log(`   • Tenant isolation`);
      console.log(`   • Real-time SLA tracking`);
      console.log(`   • CMDB management`);
      console.log(`   • Email ingest and ticket automation`);
      console.log(`   • Interactive chatbot`);
      console.log(`\n🏗️  Architecture:`);
      console.log(`   • Master DB: a1_master (system management)`);
      console.log(`   • Tenant DB: a1_tenant_apoyar (Demo company)`);
      console.log(`\n🔐 Default Credentials:`);
      console.log(`   Master Admin: admin / admin123`);
      console.log(`   Tenant Users: admin / password123, expert / password123, customer / password123`);
      console.log(`   Customer Users: othercompany / customer123`);
      console.log(`\n💡 Press Ctrl+C to stop the server`);

    } catch (error) {
      console.error('❌ Database initialization failed:', error.message);
      dbStatus.error = error.message;
      // Don't exit - keep server running for health checks
    }
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  try {
    // Stop SLA notification scheduler
    try {
      const { stopScheduler } = require('./services/sla-notifier');
      stopScheduler();
    } catch (e) {
      // Ignore if not loaded
    }
    // Stop housekeeping scheduler
    housekeeping.stopScheduler();
    await closeAllConnections();
    console.log('✅ Database connections closed');
  } catch (error) {
    console.error('❌ Error closing database connections:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down...');
  try {
    housekeeping.stopScheduler();
    await closeAllConnections();
    console.log('✅ Database connections closed');
  } catch (error) {
    console.error('❌ Error closing database connections:', error);
  }
  process.exit(0);
});

// Start the server
startServer();
} // End of else block for APP_MODE check
