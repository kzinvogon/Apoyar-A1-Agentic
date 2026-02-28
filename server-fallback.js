const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: 'Fallback Mode',
    message: 'Server is running but database connection failed',
    version: '1.0.0'
  });
});

// Simple API endpoints for testing
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'A1 Support Dashboard is running!',
    database: 'Fallback Mode',
    timestamp: new Date().toISOString()
  });
});

// Master login (mock)
app.post('/api/master/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === 'master' && password === 'master123') {
    res.json({
      success: true,
      message: 'Master login successful (Fallback Mode)',
      token: 'fallback-token',
      user: {
        id: 1,
        username: 'master',
        role: 'master_admin',
        name: 'Master Administrator'
      }
    });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

// Tenant login (mock)
app.post('/api/tenant/login', (req, res) => {
  const { username, password, tenant } = req.body;
  
  if (username === 'admin' && password === (process.env.DEFAULT_TENANT_PASSWORD || 'changeme') && tenant === 'apoyar') {
    res.json({
      success: true,
      message: 'Login successful (Fallback Mode)',
      token: 'fallback-token',
      user: {
        id: 1,
        username: 'admin',
        role: 'admin',
        name: 'Administrator',
        tenant: 'apoyar'
      }
    });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

// Serve static files
app.use(express.static('.'));

// Start server
app.listen(PORT, () => {
  console.log('🚀 A1 Support Dashboard - Fallback Mode');
  console.log('=====================================');
  console.log(`📱 Open your browser and go to: http://localhost:${PORT}`);
  console.log(`🔧 Health check: http://localhost:${PORT}/health`);
  console.log('⚠️  Running in fallback mode - database connection failed');
  console.log('✨ Features available:');
  console.log('   • Basic server functionality');
  console.log('   • Static file serving');
  console.log('   • Mock authentication');
  console.log('🔐 Test Credentials:');
  console.log('   Credentials set via env vars');
  console.log('💡 Press Ctrl+C to stop the server');
});
