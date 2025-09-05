const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Database configuration
const pool = new Pool({
  user: 'davidhamilton',
  host: 'localhost',
  database: 'a1_support_dashboard',
  password: '',
  port: 5432,
});

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM tenants');
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      database: 'PostgreSQL',
      tenantCount: result.rows[0].count,
      version: '1.0.0'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR', 
      error: error.message 
    });
  }
});

// Test endpoint
app.get('/api/test', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tenants LIMIT 5');
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Serve static files
app.use(express.static('.'));

app.listen(PORT, () => {
  console.log('🚀 A1 Support Dashboard - PostgreSQL Test Server');
  console.log('==============================================');
  console.log(`📱 Open your browser and go to: http://localhost:${PORT}`);
  console.log(`🔧 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Test API: http://localhost:${PORT}/api/test`);
  console.log('💡 Press Ctrl+C to stop the server');
});
