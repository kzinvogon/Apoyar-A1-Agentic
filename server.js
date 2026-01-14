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
require('dotenv').config();

const app = express();
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
const slaRoutes = require('./routes/sla');
const adminRoutes = require('./routes/admin');
const notificationsRoutes = require('./routes/notifications');
const tenantSettingsRoutes = require('./routes/tenant-settings');
const companyAdminRoutes = require('./routes/company-admin');
const marketingRoutes = require('./routes/marketing');

// Import email processor service
const { startEmailProcessing } = require('./services/email-processor');

// Import rate limiter
const { apiLimiter } = require('./middleware/rateLimiter');

// Middleware - Disable CSP for development
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply global rate limiting to all API routes
app.use('/api', apiLimiter);

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
app.use('/api/sla', slaRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/tenant-settings', tenantSettingsRoutes);
app.use('/api/company-admin', companyAdminRoutes);

// Public routes (no authentication required) - Must be before authenticated routes
app.use('/ticket', publicTicketRoutes);

// Marketing site routes (no auth required)
app.use('/marketing', marketingRoutes);

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

// Health check endpoint - always returns 200 so Railway health checks pass
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'ServiFlow Support Platform is running',
    timestamp: new Date().toISOString(),
    version: '2.1.0-auth-fix',
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

// Database status endpoint
app.get('/api/db/status', async (req, res) => {
  try {
    const { getMasterConnection } = require('./config/database');
    const connection = await getMasterConnection();
    
    try {
      const [tenantCount] = await connection.query('SELECT COUNT(*) as count FROM tenants WHERE is_active = 1');
      const [userCount] = await connection.query('SELECT COUNT(*) as count FROM master_users WHERE is_active = TRUE');
      
      res.json({
        success: true,
        master_db: 'connected',
        active_tenants: tenantCount[0].count,
        master_users: userCount[0].count,
        timestamp: new Date().toISOString()
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      master_db: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Initialize database and start server
async function startServer() {
  console.log('🚀 Starting ServiFlow Support Platform...');

  // Start the HTTP server FIRST so health checks work
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 ServiFlow Support Platform is running!`);
    console.log(`📱 Open your browser and go to: http://localhost:${PORT}`);
    console.log(`🔧 Health check: http://localhost:${PORT}/health`);
    console.log(`📊 Database status: http://localhost:${PORT}/api/db/status`);

    // Now initialize database in background
    console.log('📊 Initializing database connections...');

    try {
      // Initialize master database
      await initializeMasterDatabase();
      console.log('✅ Master database initialized');
      dbStatus.initialized = true;

      // Initialize default tenant database
      try {
        await initializeTenantDatabase('apoyar');
        console.log('✅ Tenant database "apoyar" initialized');

        // Run CMDB migration to ensure schema is up to date
        try {
          const { runCMDBMigration } = require('./scripts/migrate-cmdb-inline');
          await runCMDBMigration('apoyar');
          console.log('✅ CMDB schema migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: CMDB migration:`, migrationError.message);
        }

        // Run ticket-CMDB relations migration
        try {
          const { runMigration: runTicketCMDBMigration } = require('./migrations/add-ticket-cmdb-relations');
          await runTicketCMDBMigration('apoyar');
          console.log('✅ Ticket-CMDB relations migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Ticket-CMDB migration:`, migrationError.message);
        }

        // Run Knowledge Base migration
        try {
          const { runMigration: runKBMigration } = require('./migrations/add-knowledge-base');
          await runKBMigration('apoyar');
          console.log('✅ Knowledge Base migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Knowledge Base migration:`, migrationError.message);
        }

        // Run email notifications column migration
        try {
          const { runMigration: runEmailNotificationsMigration } = require('./migrations/add-email-notifications-column');
          await runEmailNotificationsMigration('apoyar');
          console.log('✅ Email notifications column migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Email notifications migration:`, migrationError.message);
        }

        // Run must_reset_password column migration
        try {
          const { runMigration: runMustResetPasswordMigration } = require('./migrations/add-must-reset-password');
          await runMustResetPasswordMigration('apoyar');
          console.log('✅ Must reset password column migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Must reset password migration:`, migrationError.message);
        }

        // Run invitation columns migration
        try {
          const { runMigration: runInvitationMigration } = require('./migrations/add-invitation-columns');
          await runInvitationMigration('apoyar');
          console.log('✅ Invitation columns migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Invitation columns migration:`, migrationError.message);
        }

        // Run soft delete columns migration
        try {
          const { runMigration: runSoftDeleteMigration } = require('./migrations/add-soft-delete-columns');
          await runSoftDeleteMigration('apoyar');
          console.log('✅ Soft delete columns migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Soft delete columns migration:`, migrationError.message);
        }

        // Run Teams user preferences migration
        try {
          const { runMigration: runTeamsUserPrefsMigration } = require('./migrations/add-teams-user-preferences');
          await runTeamsUserPrefsMigration('apoyar');
          console.log('✅ Teams user preferences migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Teams user preferences migration:`, migrationError.message);
        }

        // Run SLA definitions migration
        try {
          const { runMigration: runSLAMigration } = require('./migrations/add-sla-definitions');
          await runSLAMigration('apoyar');
          console.log('✅ SLA definitions migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: SLA definitions migration:`, migrationError.message);
        }

        // Run resolve_after_response_minutes migration
        try {
          const { runMigration: runResolveAfterResponseMigration } = require('./migrations/add-resolve-after-response');
          await runResolveAfterResponseMigration('apoyar');
          console.log('✅ Resolve after response migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Resolve after response migration:`, migrationError.message);
        }

        // Run SLA ticket fields migration
        try {
          const { runMigration: runSLATicketFieldsMigration } = require('./migrations/add-sla-ticket-fields');
          await runSLATicketFieldsMigration('apoyar');
          console.log('✅ SLA ticket fields migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: SLA ticket fields migration:`, migrationError.message);
        }

        // Run SLA notification fields migration
        try {
          const { runMigration: runSLANotificationFieldsMigration } = require('./migrations/add-sla-notification-fields');
          await runSLANotificationFieldsMigration('apoyar');
          console.log('✅ SLA notification fields migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: SLA notification fields migration:`, migrationError.message);
        }

        // Run SLA source fields migration (customer_companies, cmdb_items)
        try {
          const { runMigration: runSLASourceFieldsMigration } = require('./migrations/add-sla-source-fields');
          await runSLASourceFieldsMigration('apoyar');
          console.log('✅ SLA source fields migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: SLA source fields migration:`, migrationError.message);
        }

        // Run ticket sla_source migration
        try {
          const { runMigration: runTicketSLASourceMigration } = require('./migrations/add-ticket-sla-source');
          await runTicketSLASourceMigration('apoyar');
          console.log('✅ Ticket SLA source migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Ticket SLA source migration:`, migrationError.message);
        }

        // Run category SLA mappings migration
        try {
          const { runMigration: runCategorySLAMigration } = require('./migrations/add-category-sla-mappings');
          await runCategorySLAMigration('apoyar');
          console.log('✅ Category SLA mappings migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Category SLA mappings migration:`, migrationError.message);
        }

        // Run tenant settings migration
        try {
          const { migrate: runTenantSettingsMigration } = require('./migrations/add-tenant-settings');
          await runTenantSettingsMigration('apoyar');
          console.log('✅ Tenant settings migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Tenant settings migration:`, migrationError.message);
        }

        // Run customer SLA override migration
        try {
          const { migrate: runCustomerSLAOverrideMigration } = require('./migrations/add-customer-sla-override');
          await runCustomerSLAOverrideMigration('apoyar');
          console.log('✅ Customer SLA override migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Customer SLA override migration:`, migrationError.message);
        }

        // Run last_login column migration
        try {
          const { migrate: runLastLoginMigration } = require('./migrations/add-last-login-column');
          await runLastLoginMigration('apoyar');
          console.log('✅ Last login column migration completed');
        } catch (migrationError) {
          console.warn(`⚠️  Warning: Last login column migration:`, migrationError.message);
        }

        // Start email processing for apoyar tenant
        try {
          await startEmailProcessing('apoyar');
          console.log('✅ Email processing service started for tenant "apoyar"');
        } catch (emailError) {
          console.warn(`⚠️  Warning: Could not start email processing:`, emailError.message);
        }

        // Start SLA notification scheduler
        try {
          const { startScheduler } = require('./services/sla-notifier');
          startScheduler(5 * 60 * 1000); // Every 5 minutes
          console.log('✅ SLA notification scheduler started');
        } catch (schedulerError) {
          console.warn(`⚠️  Warning: Could not start SLA scheduler:`, schedulerError.message);
        }
      } catch (error) {
        console.warn(`⚠️  Warning: Could not initialize tenant 'apoyar':`, error.message);
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
