const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

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

// In-memory data storage (for demo purposes)
let masterUsers = [
  {
    id: 1,
    username: 'master',
    password: '$2b$10$JGkYNAmoP8W7J4Yzj/jGF.wvg4r0lL1bu1xwLuDEUC/VbvuBRNd66', // master123
    name: 'Master Administrator',
    email: 'master@example.com',
    role: 'master_admin'
  }
];

let tenants = [
  {
    id: 'apoyar',
    companyName: 'Apoyar',
    domain: 'apoyar.com',
    contactEmail: 'admin@apoyar.com',
    status: 'active',
    emailProcessingEnabled: true
  },
  {
    id: 'testcompany',
    companyName: 'Test Company',
    domain: 'testcompany.com',
    contactEmail: 'admin@testcompany.com',
    status: 'active',
    emailProcessingEnabled: false
  }
];

let tenantUsers = [
  {
    id: 1,
    tenantId: 'apoyar',
    username: 'admin',
    password: '$2b$10$placeholder', // set via env var
    name: 'Administrator',
    email: 'admin@apoyar.com',
    role: 'admin',
    isActive: true
  },
  {
    id: 2,
    tenantId: 'apoyar',
    username: 'expert',
    password: '$2b$10$placeholder', // set via env var
    name: 'Expert User',
    email: 'expert@apoyar.com',
    role: 'expert',
    isActive: true
  },
  {
    id: 3,
    tenantId: 'apoyar',
    username: 'customer',
    password: '$2b$10$placeholder', // set via env var
    name: 'Customer User',
    email: 'customer@apoyar.com',
    role: 'customer',
    isActive: true
  }
];

let tickets = [
  {
    id: 'TICKET-001',
    tenantId: 'apoyar',
    title: 'Sample Support Ticket',
    description: 'This is a sample support ticket for demonstration purposes.',
    priority: 'medium',
    status: 'open',
    customer: 'customer',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: 'In-Memory Demo',
    message: 'A1 Support Dashboard running successfully',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'A1 Support Dashboard API is working!',
    database: 'In-Memory Demo',
    timestamp: new Date().toISOString(),
    features: [
      'Multi-tenant architecture',
      'User authentication',
      'Ticket management',
      'Master admin dashboard'
    ]
  });
});

// Master Admin Routes
app.post('/api/master/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('Master login attempt:', { username, password: '***' });

    const user = masterUsers.find(u => u.username === username);
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, scope: 'master' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      success: true,
      message: 'Master login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.name
      }
    });
  } catch (error) {
    console.error('Master login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// Get master dashboard data
app.get('/api/master/dashboard', authenticateToken, (req, res) => {
  try {
    if (req.user.scope !== 'master') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({
      success: true,
      data: {
        tenantCount: tenants.length,
        subscriptionCount: 2,
        recentTenants: tenants.slice(0, 5)
      }
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to load dashboard data' });
  }
});

// Get all tenants
app.get('/api/master/tenants', authenticateToken, (req, res) => {
  try {
    if (req.user.scope !== 'master') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({
      success: true,
      data: tenants
    });
  } catch (error) {
    console.error('Get tenants error:', error);
    res.status(500).json({ success: false, message: 'Failed to load tenants' });
  }
});

// Create new tenant
app.post('/api/master/tenants', authenticateToken, async (req, res) => {
  try {
    if (req.user.scope !== 'master') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { companyName, domain, contactEmail, contactPhone, address } = req.body;
    const tenantId = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Check if tenant already exists
    const existingTenant = tenants.find(t => t.id === tenantId);
    if (existingTenant) {
      return res.status(400).json({ success: false, message: 'Tenant already exists' });
    }

    // Create tenant
    const newTenant = {
      id: tenantId,
      companyName,
      domain,
      contactEmail,
      contactPhone,
      address,
      status: 'active',
      emailProcessingEnabled: false
    };

    tenants.push(newTenant);

    // Create default admin user
    const hashedPassword = await bcrypt.hash(process.env.DEFAULT_TENANT_PASSWORD || 'changeme', 10);
    const newUser = {
      id: tenantUsers.length + 1,
      tenantId,
      username: 'admin',
      password: hashedPassword,
      name: 'Administrator',
      email: contactEmail || `${tenantId}@example.com`,
      role: 'admin',
      isActive: true
    };

    tenantUsers.push(newUser);

    res.json({
      success: true,
      message: 'Tenant created successfully',
      data: { tenantId, companyName }
    });
  } catch (error) {
    console.error('Create tenant error:', error);
    res.status(500).json({ success: false, message: 'Failed to create tenant' });
  }
});

// Tenant Authentication Routes
app.post('/api/tenant/login', async (req, res) => {
  try {
    const { username, password, tenant } = req.body;
    console.log('Tenant login attempt:', { username, password: '***', tenant });

    const user = tenantUsers.find(u => 
      u.tenantId === tenant && 
      u.username === username && 
      u.isActive
    );

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, tenant: tenant, scope: 'tenant' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.name,
        tenant: tenant
      }
    });
  } catch (error) {
    console.error('Tenant login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// Get tenant dashboard data
app.get('/api/tenant/:tenantId/dashboard', authenticateToken, (req, res) => {
  try {
    const { tenantId } = req.params;
    
    if (req.user.scope !== 'tenant' || req.user.tenant !== tenantId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const tenantTickets = tickets.filter(t => t.tenantId === tenantId);
    const ticketCounts = tenantTickets.reduce((acc, ticket) => {
      acc[ticket.status] = (acc[ticket.status] || 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        ticketCounts: Object.entries(ticketCounts).map(([status, count]) => ({ status, count })),
        recentTickets: tenantTickets.slice(0, 5)
      }
    });
  } catch (error) {
    console.error('Tenant dashboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to load dashboard data' });
  }
});

// Get tickets for tenant
app.get('/api/tenant/:tenantId/tickets', authenticateToken, (req, res) => {
  try {
    const { tenantId } = req.params;
    
    if (req.user.scope !== 'tenant' || req.user.tenant !== tenantId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const tenantTickets = tickets.filter(t => t.tenantId === tenantId);

    res.json({
      success: true,
      data: tenantTickets
    });
  } catch (error) {
    console.error('Get tickets error:', error);
    res.status(500).json({ success: false, message: 'Failed to load tickets' });
  }
});

// Create new ticket
app.post('/api/tenant/:tenantId/tickets', authenticateToken, (req, res) => {
  try {
    const { tenantId } = req.params;
    
    if (req.user.scope !== 'tenant' || req.user.tenant !== tenantId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { title, description, priority = 'medium' } = req.body;
    const ticketId = `TICKET-${Date.now()}`;

    const newTicket = {
      id: ticketId,
      tenantId,
      title,
      description,
      priority,
      status: 'open',
      customer: req.user.username,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    tickets.push(newTicket);

    res.json({
      success: true,
      message: 'Ticket created successfully',
      data: newTicket
    });
  } catch (error) {
    console.error('Create ticket error:', error);
    res.status(500).json({ success: false, message: 'Failed to create ticket' });
  }
});

// Serve static files
app.use(express.static('.'));

// Start server
app.listen(PORT, () => {
  console.log('🚀 A1 Support Dashboard - Heroku Optimized');
  console.log('==========================================');
  console.log(`📱 Open your browser and go to: http://localhost:${PORT}`);
  console.log(`🔧 Health check: http://localhost:${PORT}/health`);
  console.log('✨ Features available:');
  console.log('   • Multi-tenant architecture');
  console.log('   • Master Admin tenant management');
  console.log('   • In-memory data storage');
  console.log('   • User authentication');
  console.log('   • Ticket management');
  console.log('🔐 Credentials set via env vars');
  console.log('💡 Press Ctrl+C to stop the server');
});
