const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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

// Serve static files from the current directory
app.use(express.static(__dirname));

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

// Public routes (no authentication required) - Must be before authenticated routes
app.use('/ticket', publicTicketRoutes);

// Main route - serve the HTML file
app.get('/', (req, res) => {
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
    message: 'A1 Support Dashboard Prototype is running',
    timestamp: new Date().toISOString(),
    database: dbStatus.initialized ? 'connected' : (dbStatus.error || 'initializing'),
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
  console.log('🚀 Starting A1 Support Dashboard Prototype...');

  // Start the HTTP server FIRST so health checks work
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 A1 Support Dashboard Prototype is running!`);
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

      // Initialize Apoyar tenant database
      try {
        await initializeTenantDatabase('apoyar');
        console.log('✅ Tenant database "apoyar" initialized');

        // Start email processing for apoyar tenant
        try {
          await startEmailProcessing('apoyar');
          console.log('✅ Email processing service started for tenant "apoyar"');
        } catch (emailError) {
          console.warn(`⚠️  Warning: Could not start email processing:`, emailError.message);
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
      console.log(`   • Tenant DB: a1_tenant_apoyar (Apoyar company)`);
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
