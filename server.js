const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database initialization
const { 
  initializeMasterDatabase, 
  initializeTenantDatabase, 
  closeAllConnections 
} = require('./config/database');

// Import routes
const authRoutes = require('./routes/auth');
const masterRoutes = require('./routes/master');

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the current directory
app.use(express.static(__dirname));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/master', masterRoutes);

// Main route - serve the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'A1 Support Build from here .html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'A1 Support Dashboard Prototype is running',
    timestamp: new Date().toISOString(),
    features: [
      'Multi-tenant MySQL backend',
      'Master admin system',
      'Role-based authentication',
      'Tenant isolation',
      'Real-time SLA tracking'
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
  try {
    console.log('🚀 Starting A1 Support Dashboard Prototype...');
    console.log('📊 Initializing database connections...');
    
    // Initialize master database
    await initializeMasterDatabase();
    console.log('✅ Master database initialized');
    
    // Initialize Apoyar tenant database (Bleckmann is a customer within this tenant)
    try {
      await initializeTenantDatabase('apoyar');
      console.log('✅ Tenant database "apoyar" initialized');
      console.log('🏢 Bleckmann configured as a customer within Apoyar tenant');
    } catch (error) {
      console.warn(`⚠️  Warning: Could not initialize tenant 'apoyar':`, error.message);
    }
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`🚀 A1 Support Dashboard Prototype is running!`);
      console.log(`📱 Open your browser and go to: http://localhost:${PORT}`);
      console.log(`🔧 Health check: http://localhost:${PORT}/health`);
      console.log(`📊 Database status: http://localhost:${PORT}/api/db/status`);
      console.log(`\n✨ Features available:`);
      console.log(`   • Multi-tenant MySQL backend`);
      console.log(`   • Master admin system`);
      console.log(`   • Role-based authentication`);
      console.log(`   • Tenant isolation`);
      console.log(`   • Real-time SLA tracking`);
      console.log(`   • CMDB management`);
      console.log(`   • Interactive chatbot`);
      console.log(`\n🏗️  Architecture:`);
      console.log(`   • Master DB: a1_master (system management)`);
      console.log(`   • Tenant DB: a1_tenant_apoyar (Apoyar company)`);
      console.log(`   • Customer: Bleckmann (within Apoyar tenant)`);
      console.log(`\n🔐 Default Credentials:`);
      console.log(`   Master Admin: admin / admin123`);
      console.log(`   Tenant Users: admin / password123, expert / password123, customer / password123`);
      console.log(`   Customer Users: bleckmann / customer123, othercompany / customer123`);
      console.log(`\n💡 Press Ctrl+C to stop the server`);
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
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
