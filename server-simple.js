const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const cors = require('cors');
const nodemailer = require('nodemailer');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

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
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
}));
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// Multi-tenant JSON file-based data storage
const MASTER_DB_FILE = 'master-db.json';
const TENANT_DB_DIR = 'tenant-dbs';

// Ensure tenant directory exists
async function ensureDirectories() {
  try {
    await fs.mkdir(TENANT_DB_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

// Email configuration
const EMAIL_CONFIG = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'demo@example.com',
    pass: process.env.SMTP_PASS || 'demo-password'
  }
};

// Create email transporter
const emailTransporter = nodemailer.createTransport(EMAIL_CONFIG);

// Email notification functions
async function sendEmailNotification(to, subject, html, text) {
  try {
    const mailOptions = {
      from: EMAIL_CONFIG.auth.user,
      to: to,
      subject: subject,
      html: html,
      text: text
    };
    
    // In demo mode, just log the email instead of sending
    if (process.env.NODE_ENV === 'demo' || EMAIL_CONFIG.auth.user.includes('@example.com')) {
      console.log('📧 Email Notification:', {
        to: to,
        subject: subject,
        html: html
      });
      return { success: true, message: 'Email logged (demo mode)' };
    }
    
    const result = await emailTransporter.sendMail(mailOptions);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Email sending failed:', error);
    return { success: false, error: error.message };
  }
}

async function sendTicketNotification(tenantId, ticket, action) {
  try {
    const tenantData = await loadTenantData(tenantId);
    const adminUser = tenantData.users.find(u => u.role === 'admin');
    
    if (!adminUser) return;
    
    const subject = `Ticket #${ticket.id} ${action} - ${ticket.title}`;
    const html = `
      <h2>Ticket ${action}</h2>
      <p><strong>Ticket ID:</strong> ${ticket.id}</p>
      <p><strong>Title:</strong> ${ticket.title}</p>
      <p><strong>Priority:</strong> ${ticket.priority}</p>
      <p><strong>Status:</strong> ${ticket.status}</p>
      <p><strong>Customer:</strong> ${ticket.customer}</p>
      <p><strong>Description:</strong> ${ticket.desc}</p>
      <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
    `;
    
    await sendEmailNotification(adminUser.email || 'admin@' + tenantId + '.com', subject, html);
  } catch (error) {
    console.error('Ticket notification failed:', error);
  }
}

async function sendBillingNotification(tenantId, subscription, action) {
  try {
    const tenantData = await loadTenantData(tenantId);
    const adminUser = tenantData.users.find(u => u.role === 'admin');
    
    if (!adminUser) return;
    
    const subject = `Billing ${action} - ${subscription.plan} Plan`;
    const html = `
      <h2>Billing ${action}</h2>
      <p><strong>Tenant:</strong> ${subscription.tenantName}</p>
      <p><strong>Plan:</strong> ${subscription.plan}</p>
      <p><strong>Amount:</strong> $${subscription.monthlyPrice}/month</p>
      <p><strong>Status:</strong> ${subscription.status}</p>
      <p><strong>Next Billing:</strong> ${new Date(subscription.nextBillingDate).toLocaleString()}</p>
      <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
    `;
    
    await sendEmailNotification(adminUser.email || 'admin@' + tenantId + '.com', subject, html);
  } catch (error) {
    console.error('Billing notification failed:', error);
  }
}

// Email Processing Configuration
const EMAIL_PROCESSING_CONFIG = {
  imap: {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: process.env.IMAP_PORT || 993,
    tls: true,
    tlsOptions: {
      rejectUnauthorized: process.env.IMAP_REJECT_UNAUTHORIZED !== 'false' // Allow self-signed certs in dev
    },
    user: process.env.IMAP_USER || 'support@example.com',
    password: process.env.IMAP_PASSWORD || 'demo-password'
  },
  checkInterval: process.env.EMAIL_CHECK_INTERVAL || 30000, // 30 seconds
  processedFolder: 'Processed',
  errorFolder: 'Error'
};

// Email Processing Functions
async function processIncomingEmails() {
  try {
    // Skip email processing if no real credentials are configured
    if (EMAIL_PROCESSING_CONFIG.imap.user === 'support@example.com' || 
        EMAIL_PROCESSING_CONFIG.imap.password === 'demo-password') {
      console.log('📧 Email processing skipped - using demo credentials');
      return;
    }
    
    console.log('📧 Checking for new emails...');
    
    const imap = new Imap(EMAIL_PROCESSING_CONFIG.imap);
    
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          console.error('Error opening inbox:', err);
          return;
        }
        
        // Search for unread emails
        imap.search(['UNSEEN'], (err, results) => {
          if (err) {
            console.error('Error searching emails:', err);
            return;
          }
          
          if (results.length === 0) {
            console.log('No new emails found');
            imap.end();
            return;
          }
          
          console.log(`Found ${results.length} new emails`);
          
          // Fetch emails
          const fetch = imap.fetch(results, { bodies: '' });
          fetch.on('message', (msg, seqno) => {
            msg.on('body', (stream, info) => {
              simpleParser(stream, (err, parsed) => {
                if (err) {
                  console.error('Error parsing email:', err);
                  return;
                }
                
                processEmail(parsed);
              });
            });
          });
          
          fetch.once('error', (err) => {
            console.error('Error fetching emails:', err);
          });
          
          fetch.once('end', () => {
            imap.end();
          });
        });
      });
    });
    
    imap.once('error', (err) => {
      console.error('IMAP connection error:', err);
    });
    
    imap.once('end', () => {
      console.log('IMAP connection ended');
    });
    
    imap.connect();
    
  } catch (error) {
    console.error('Error processing emails:', error);
  }
}

async function processEmail(email) {
  try {
    const fromEmail = email.from?.value?.[0]?.address || email.from?.text;
    const subject = email.subject || 'No Subject';
    const text = email.text || email.html || 'No content';
    const html = email.html || email.text || 'No content';
    
    console.log(`📧 Processing email from: ${fromEmail}, Subject: ${subject}`);
    
    // Extract domain from email
    const domain = fromEmail.split('@')[1];
    if (!domain) {
      console.log('Invalid email address format');
      return;
    }
    
    // Find customer by domain
    const customer = await findCustomerByDomain(domain);
    if (!customer) {
      console.log(`No customer found for domain: ${domain}`);
      return;
    }
    
    // Find or create user
    const user = await findOrCreateUser(fromEmail, customer.tenantId, subject, text);
    if (!user) {
      console.log('Failed to find or create user');
      return;
    }
    
    // Create ticket
    const ticket = await createTicketFromEmail(customer.tenantId, user, subject, text, html);
    if (!ticket) {
      console.log('Failed to create ticket');
      return;
    }
    
    // Send notifications
    await sendTicketCreatedNotification(customer.tenantId, user, ticket);
    
    console.log(`✅ Successfully processed email and created ticket #${ticket.id}`);
    
  } catch (error) {
    console.error('Error processing email:', error);
  }
}

async function findCustomerByDomain(domain) {
  try {
    const masterData = await loadMasterData();
    const tenants = masterData.tenants || [];
    
    // Look for tenant with matching domain
    for (const tenant of tenants) {
      if (tenant.domain === domain || tenant.adminEmail?.includes(domain)) {
        return tenant;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error finding customer by domain:', error);
    return null;
  }
}

async function findOrCreateUser(email, tenantId, subject, messageBody) {
  try {
    const tenantData = await loadTenantData(tenantId);
    const users = tenantData.users || [];
    
    // Check if user already exists
    let user = users.find(u => u.email === email);
    
    if (user) {
      return user;
    }
    
    // Create new user
    const newUser = {
      id: Date.now(),
      username: email.split('@')[0],
      email: email,
      password: await bcrypt.hash('temp123', 10), // Temporary password
      role: 'customer',
      name: email.split('@')[0],
      phone: '',
      isActive: true,
      needsAccountConfirmation: true,
      createdAt: new Date().toISOString()
    };
    
    users.push(newUser);
    tenantData.users = users;
    
    await saveTenantData(tenantId, tenantData);
    
    // Send account creation notification
    await sendAccountCreationNotification(tenantId, newUser);
    
    console.log(`✅ Created new user: ${email}`);
    return newUser;
    
  } catch (error) {
    console.error('Error finding or creating user:', error);
    return null;
  }
}

async function createTicketFromEmail(tenantId, user, subject, text, html) {
  try {
    // Check usage limits
    const usageCheck = await checkUsageLimits(tenantId, 'tickets', 1);
    if (!usageCheck.allowed) {
      console.log('Ticket limit exceeded for tenant:', tenantId);
      return null;
    }
    
    const tenantData = await loadTenantData(tenantId);
    const tickets = tenantData.tickets || [];
    
    const newTicket = {
      id: Date.now(),
      title: subject,
      description: text,
      priority: determinePriority(subject, text),
      status: 'Open',
      customer: user.name,
      customerEmail: user.email,
      assignee: 'Unassigned',
      source: 'email',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    tickets.push(newTicket);
    tenantData.tickets = tickets;
    
    await saveTenantData(tenantId, tenantData);
    
    // Update usage
    await updateTenantUsage(tenantId, 'tickets', 1);
    
    return newTicket;
    
  } catch (error) {
    console.error('Error creating ticket from email:', error);
    return null;
  }
}

function determinePriority(subject, text) {
  const highPriorityKeywords = ['urgent', 'critical', 'emergency', 'asap', 'immediately'];
  const lowPriorityKeywords = ['question', 'info', 'inquiry', 'general'];
  
  const content = (subject + ' ' + text).toLowerCase();
  
  if (highPriorityKeywords.some(keyword => content.includes(keyword))) {
    return 'High';
  }
  
  if (lowPriorityKeywords.some(keyword => content.includes(keyword))) {
    return 'Low';
  }
  
  return 'Normal';
}

async function sendAccountCreationNotification(tenantId, user) {
  try {
    const subject = 'Account Created - A1 Support Dashboard';
    const html = `
      <h2>Welcome to A1 Support Dashboard!</h2>
      <p>Your account has been created successfully.</p>
      <p><strong>Email:</strong> ${user.email}</p>
      <p><strong>Temporary Password:</strong> temp123</p>
      <p><strong>Login URL:</strong> <a href="${process.env.BASE_URL || 'https://serviflow.app'}">${process.env.BASE_URL || 'https://serviflow.app'}</a></p>
      <p><strong>Important:</strong> Please log in and update your profile with your name and phone number.</p>
      <p>You can now create and track support tickets through our system.</p>
    `;
    
    await sendEmailNotification(user.email, subject, html);
    console.log(`📧 Sent account creation notification to: ${user.email}`);
    
  } catch (error) {
    console.error('Error sending account creation notification:', error);
  }
}

async function sendTicketCreatedNotification(tenantId, user, ticket) {
  try {
    const subject = `Ticket #${ticket.id} Created - ${ticket.title}`;
    const html = `
      <h2>Support Ticket Created</h2>
      <p>Your support ticket has been created successfully.</p>
      <p><strong>Ticket ID:</strong> ${ticket.id}</p>
      <p><strong>Title:</strong> ${ticket.title}</p>
      <p><strong>Priority:</strong> ${ticket.priority}</p>
      <p><strong>Status:</strong> ${ticket.status}</p>
      <p><strong>Description:</strong></p>
      <div style="background:#f8f9fa;padding:12px;border-radius:4px;margin:8px 0;">
        ${ticket.description.replace(/\n/g, '<br>')}
      </div>
      <p><strong>View Ticket:</strong> <a href="${process.env.BASE_URL || 'https://serviflow.app'}">${process.env.BASE_URL || 'https://serviflow.app'}</a></p>
      <p>You will receive updates on this ticket via email.</p>
    `;
    
    await sendEmailNotification(user.email, subject, html);
    console.log(`📧 Sent ticket creation notification to: ${user.email}`);
    
  } catch (error) {
    console.error('Error sending ticket creation notification:', error);
  }
}

// Initialize master database
async function initializeMasterDatabase() {
  try {
    await fs.access(MASTER_DB_FILE);
    // Master DB exists, load it
    return await loadMasterData();
  } catch (error) {
    // Master DB doesn't exist, create it
    const masterData = {
      tenants: [
        {
          id: 'apoyar',
          company_name: 'Apoyar',
          company_code: 'APO',
          status: 'active',
          created_at: new Date().toISOString(),
          admin_user: 'admin',
          admin_password: 'admin123'
        }
      ],
      master_users: [
        { 
          id: 1, 
          username: 'master', 
          password: await bcrypt.hash('master123', 10), 
          role: 'master_admin', 
          name: 'Master Administrator' 
        }
      ]
    };
    
    await fs.writeFile(MASTER_DB_FILE, JSON.stringify(masterData, null, 2));
    return masterData;
  }
}

// Initialize tenant database
async function initializeTenantDatabase(tenantId) {
  const tenantDbFile = path.join(TENANT_DB_DIR, `${tenantId}.json`);
  
  try {
    await fs.access(tenantDbFile);
    // Tenant DB exists, load it
    return await loadTenantData(tenantId);
  } catch (error) {
    // Tenant DB doesn't exist, create it
    const tenantData = {
      company_id: tenantId,
      company_name: tenantId === 'apoyar' ? 'Apoyar' : tenantId,
      users: [
        { 
          id: 1, 
          username: 'admin', 
          password: await bcrypt.hash('admin123', 10), 
          role: 'admin', 
          name: `${tenantId} Admin` 
        },
        { 
          id: 2, 
          username: 'expert', 
          password: await bcrypt.hash('password123', 10), 
          role: 'expert', 
          name: 'Support Expert' 
        },
        { 
          id: 3, 
          username: 'customer', 
          password: await bcrypt.hash('password123', 10), 
          role: 'customer', 
          name: 'Customer User' 
        }
      ],
      tickets: [],
      cmdb_items: []
    };
    
    await fs.writeFile(tenantDbFile, JSON.stringify(tenantData, null, 2));
    return tenantData;
  }
}

// Load master database
async function loadMasterData() {
  try {
    const data = await fs.readFile(MASTER_DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading master database:', error);
    return { tenants: [], master_users: [] };
  }
}

// Load tenant database
async function loadTenantData(tenantId) {
  try {
    const tenantDbFile = path.join(TENANT_DB_DIR, `${tenantId}.json`);
    const data = await fs.readFile(tenantDbFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading tenant database for ${tenantId}:`, error);
    return { users: [], tickets: [], cmdb_items: [] };
  }
}

// Save master database
async function saveMasterData(data) {
  try {
    await fs.writeFile(MASTER_DB_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving master database:', error);
    return false;
  }
}

// Save tenant database
async function saveTenantData(tenantId, data) {
  try {
    const tenantDbFile = path.join(TENANT_DB_DIR, `${tenantId}.json`);
    await fs.writeFile(tenantDbFile, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error(`Error saving tenant database for ${tenantId}:`, error);
    return false;
  }
}

async function deleteTenantData(tenantId) {
  try {
    const tenantDbFile = path.join(TENANT_DB_DIR, `${tenantId}.json`);
    await fs.unlink(tenantDbFile);
    return true;
  } catch (error) {
    // File might not exist, which is fine
    console.log(`Tenant data file ${tenantId}.json not found for deletion`);
    return false;
  }
}

// Usage tracking functions
async function updateTenantUsage(tenantId, usageType, increment = 1) {
  try {
    const masterData = await loadMasterData();
    const subscription = masterData.subscriptions?.find(s => s.tenantId === tenantId);
    
    if (!subscription) {
      console.log(`No subscription found for tenant: ${tenantId}`);
      return false;
    }
    
    // Update usage based on type
    switch (usageType) {
      case 'users':
        subscription.currentUsers = Math.max(0, subscription.currentUsers + increment);
        break;
      case 'tickets':
        subscription.currentTickets = Math.max(0, subscription.currentTickets + increment);
        break;
      case 'storage':
        subscription.currentStorage = Math.max(0, subscription.currentStorage + increment);
        break;
    }
    
    // Recalculate usage percentage
    const maxUsers = subscription.maxUsers === -1 ? subscription.currentUsers : subscription.maxUsers;
    const maxTickets = subscription.maxTickets === -1 ? subscription.currentTickets : subscription.maxTickets;
    const maxStorage = subscription.maxStorage === -1 ? subscription.currentStorage : subscription.maxStorage;
    
    const userPercentage = maxUsers > 0 ? (subscription.currentUsers / maxUsers) * 100 : 0;
    const ticketPercentage = maxTickets > 0 ? (subscription.currentTickets / maxTickets) * 100 : 0;
    const storagePercentage = maxStorage > 0 ? (subscription.currentStorage / maxStorage) * 100 : 0;
    
    subscription.usagePercentage = Math.max(userPercentage, ticketPercentage, storagePercentage);
    
    await saveMasterData(masterData);
    return true;
  } catch (error) {
    console.error(`Error updating usage for tenant ${tenantId}:`, error);
    return false;
  }
}

async function checkUsageLimits(tenantId, usageType, requestedAmount = 1) {
  try {
    const masterData = await loadMasterData();
    const subscription = masterData.subscriptions?.find(s => s.tenantId === tenantId);
    
    if (!subscription) {
      return { allowed: false, reason: 'No subscription found' };
    }
    
    // Check if subscription is active
    if (subscription.status !== 'active') {
      return { allowed: false, reason: 'Subscription is not active' };
    }
    
    // Check specific limits
    switch (usageType) {
      case 'users':
        if (subscription.maxUsers !== -1 && (subscription.currentUsers + requestedAmount) > subscription.maxUsers) {
          return { 
            allowed: false, 
            reason: `User limit exceeded. Current: ${subscription.currentUsers}/${subscription.maxUsers}`,
            current: subscription.currentUsers,
            limit: subscription.maxUsers,
            type: 'users'
          };
        }
        break;
      case 'tickets':
        if (subscription.maxTickets !== -1 && (subscription.currentTickets + requestedAmount) > subscription.maxTickets) {
          return { 
            allowed: false, 
            reason: `Ticket limit exceeded. Current: ${subscription.currentTickets}/${subscription.maxTickets}`,
            current: subscription.currentTickets,
            limit: subscription.maxTickets,
            type: 'tickets'
          };
        }
        break;
      case 'storage':
        if (subscription.maxStorage !== -1 && (subscription.currentStorage + requestedAmount) > subscription.maxStorage) {
          return { 
            allowed: false, 
            reason: `Storage limit exceeded. Current: ${subscription.currentStorage}GB/${subscription.maxStorage}GB`,
            current: subscription.currentStorage,
            limit: subscription.maxStorage,
            type: 'storage'
          };
        }
        break;
    }
    
    return { allowed: true };
  } catch (error) {
    console.error(`Error checking usage limits for tenant ${tenantId}:`, error);
    return { allowed: false, reason: 'Error checking limits' };
  }
}

// Master Admin Login
app.post('/api/master/login', async (req, res) => {
  console.log('Master login attempt:', req.body);
  try {
    const { username, password } = req.body;
    const masterData = await loadMasterData();
    const user = masterData.master_users.find(u => u.username === username);

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, role: 'master_admin', scope: 'master' }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ 
      success: true, 
      message: 'Master login successful', 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        role: 'master_admin', 
        name: user.name 
      } 
    });
  } catch (error) {
    console.error('Master login error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Tenant Login
app.post('/api/tenant/login', async (req, res) => {
  console.log('Tenant login attempt:', req.body);
  try {
    const { username, password, tenant } = req.body;
    
    if (!tenant) {
      return res.status(400).json({ success: false, message: 'Tenant required' });
    }

    const tenantData = await loadTenantData(tenant);
    const user = tenantData.users.find(u => u.username === username);

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, role: user.role, tenant: tenant, scope: 'tenant' }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ 
      success: true, 
      message: 'Tenant login successful', 
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
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get all tenants (Master Admin only)
app.get('/api/master/tenants', async (req, res) => {
  try {
    const masterData = await loadMasterData();
    res.json({ success: true, tenants: masterData.tenants });
  } catch (error) {
    console.error('Error fetching tenants:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create new tenant (Master Admin only)
app.post('/api/master/tenants', async (req, res) => {
  try {
    const { companyName, adminUsername, adminEmail, domain } = req.body;
    
    if (!companyName || !adminUsername || !adminEmail) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const masterData = await loadMasterData();
    
    // Check if tenant already exists
    const tenantId = companyName.toLowerCase().replace(/\s+/g, '-');
    const existingTenant = masterData.tenants.find(t => t.tenantId === tenantId);
    if (existingTenant) {
      return res.status(400).json({ success: false, message: 'Tenant already exists' });
    }

    const newTenant = {
      tenantId: tenantId,
      companyName: companyName,
      status: 'active',
      createdAt: new Date().toISOString(),
      adminUsername: adminUsername,
      adminEmail: adminEmail,
      domain: domain || null, // Email domain for this customer
      emailProcessingEnabled: true
    };

    masterData.tenants.push(newTenant);
    await saveMasterData(masterData);

    // Create tenant database with default admin user
    const tenantData = {
      users: [
        {
          id: 1,
          username: adminUsername,
          password: await bcrypt.hash('admin123', 10), // Default password
          role: 'admin',
          name: 'Admin User',
          email: adminEmail
        }
      ],
      tickets: [],
      cmdb_items: [],
      cis_by_item: {}
    };
    
    await saveTenantData(tenantId, tenantData);

    res.json({ success: true, message: 'Tenant created successfully', tenant: newTenant });
  } catch (error) {
    console.error('Error creating tenant:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update tenant details
app.put('/api/master/tenants/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { companyName, adminUsername, adminEmail, status } = req.body;

    if (!companyName || !adminUsername || !adminEmail) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const masterData = await loadMasterData();
    const tenantIndex = masterData.tenants.findIndex(t => t.tenantId === tenantId);
    
    if (tenantIndex === -1) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    // Check if new company name conflicts with existing tenants (excluding current tenant)
    const newTenantId = companyName.toLowerCase().replace(/\s+/g, '-');
    const existingTenant = masterData.tenants.find(t => t.tenantId === newTenantId && t.tenantId !== tenantId);
    if (existingTenant) {
      return res.status(400).json({ success: false, message: 'Company name already exists' });
    }

    // Update tenant details
    const oldTenant = masterData.tenants[tenantIndex];
    masterData.tenants[tenantIndex] = {
      ...oldTenant,
      tenantId: newTenantId,
      companyName: companyName,
      adminUsername: adminUsername,
      adminEmail: adminEmail,
      status: status || oldTenant.status,
      updatedAt: new Date().toISOString()
    };

    // If tenant ID changed, we need to rename the tenant database file
    if (oldTenant.tenantId !== newTenantId) {
      try {
        const oldTenantData = await loadTenantData(oldTenant.tenantId);
        await saveTenantData(newTenantId, oldTenantData);
        await deleteTenantData(oldTenant.tenantId);
      } catch (error) {
        console.error('Error migrating tenant data:', error);
        // Continue with the update even if migration fails
      }
    }

    await saveMasterData(masterData);

    res.json({ success: true, message: 'Tenant updated successfully', tenant: masterData.tenants[tenantIndex] });
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'A1 Support Build from here .html'));
});

// Helper function to check and handle trial expirations
async function checkTrialExpirations() {
  try {
    const masterData = await loadMasterData();
    const subscriptions = masterData.subscriptions || [];
    let updated = false;
    
    for (const subscription of subscriptions) {
      if (subscription.plan === 'trial' && subscription.trialEndDate) {
        const trialEndDate = new Date(subscription.trialEndDate);
        const now = new Date();
        
        if (now > trialEndDate && subscription.status === 'active') {
          // Trial has expired - suspend the subscription
          subscription.status = 'expired';
          subscription.expiredAt = now.toISOString();
          updated = true;
          console.log(`Trial expired for tenant: ${subscription.tenantName}`);
        }
      }
    }
    
    if (updated) {
      await saveMasterData(masterData);
    }
  } catch (error) {
    console.error('Error checking trial expirations:', error);
  }
}

// Subscription Management APIs
app.get('/api/master/subscriptions', async (req, res) => {
  try {
    // Check for expired trials before returning subscriptions
    await checkTrialExpirations();
    
    const masterData = await loadMasterData();
    const subscriptions = masterData.subscriptions || [];
    res.json({ success: true, subscriptions });
  } catch (error) {
    console.error('Error fetching subscriptions:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/master/subscriptions', async (req, res) => {
  try {
    const { tenantId, plan, billing } = req.body;
    
    if (!tenantId || !plan) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const masterData = await loadMasterData();
    
    // Check if subscription already exists for this tenant
    const existingSubscription = masterData.subscriptions?.find(s => s.tenantId === tenantId);
    if (existingSubscription) {
      return res.status(400).json({ success: false, message: 'Subscription already exists for this tenant' });
    }

    // Get tenant info
    // Handle both old and new tenant formats
    let tenant = masterData.tenants.find(t => t.tenantId === tenantId);
    if (!tenant) {
      // Try old format
      tenant = masterData.tenants.find(t => t.id === tenantId);
      if (tenant) {
        // Convert old format to new format for consistency
        tenant.tenantId = tenant.id;
        tenant.companyName = tenant.company_name;
        tenant.adminUsername = tenant.admin_user;
        tenant.adminEmail = tenant.admin_email || 'admin@' + tenantId + '.com';
      }
    }
    
    if (!tenant) {
      return res.status(400).json({ success: false, message: 'Tenant not found' });
    }

    // Define plan parameters
    const planConfig = {
      trial: { 
        monthlyPrice: 0, 
        maxUsers: 3, 
        maxTickets: 50, 
        maxStorage: 1, 
        features: ['basic_sla', 'email_support'] 
      },
      starter: { 
        monthlyPrice: 29, 
        maxUsers: 10, 
        maxTickets: 500, 
        maxStorage: 10, 
        features: ['standard_sla', 'email_chat_support', 'basic_analytics', '3_integrations'] 
      },
      pro: { 
        monthlyPrice: 99, 
        maxUsers: -1, // unlimited
        maxTickets: -1, // unlimited
        maxStorage: 100, 
        features: ['premium_sla', 'priority_support', 'advanced_analytics', 'unlimited_integrations', 'custom_branding', 'api_access'] 
      }
    };

    const config = planConfig[plan];
    if (!config) {
      return res.status(400).json({ success: false, message: 'Invalid plan type' });
    }

    const subscription = {
      id: 'sub_' + Date.now(),
      tenantId: tenantId,
      tenantName: tenant.companyName,
      plan: plan,
      status: 'active',
      monthlyPrice: config.monthlyPrice,
      billingCycle: billing,
      maxUsers: config.maxUsers,
      maxTickets: config.maxTickets,
      maxStorage: config.maxStorage,
      features: config.features,
      currentUsers: 1, // Start with 1 user (the admin)
      currentTickets: 0,
      currentStorage: 0,
      usagePercentage: 0,
      nextBillingDate: plan === 'trial' ? 
        new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() : // 14 days for trial
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days for paid plans
      trialEndDate: plan === 'trial' ? 
        new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() : null, // Trial expires in 14 days
      createdAt: new Date().toISOString(),
      previousPlan: null
    };

    if (!masterData.subscriptions) {
      masterData.subscriptions = [];
    }
    
    masterData.subscriptions.push(subscription);
    await saveMasterData(masterData);

    // Send email notification
    await sendBillingNotification(tenantId, subscription, 'Created');

    res.json({ success: true, message: 'Subscription created successfully', subscription });
  } catch (error) {
    console.error('Error creating subscription:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Trial Management APIs
app.post('/api/master/subscriptions/:subscriptionId/extend-trial', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { days } = req.body;
    
    const masterData = await loadMasterData();
    const subscription = masterData.subscriptions?.find(s => s.id === subscriptionId);
    
    if (!subscription) {
      return res.status(404).json({ success: false, message: 'Subscription not found' });
    }
    
    if (subscription.plan !== 'trial') {
      return res.status(400).json({ success: false, message: 'Only trial subscriptions can be extended' });
    }
    
    const extensionDays = days || 7; // Default 7 days extension
    const currentTrialEnd = new Date(subscription.trialEndDate);
    const newTrialEnd = new Date(currentTrialEnd.getTime() + (extensionDays * 24 * 60 * 60 * 1000));
    
    subscription.trialEndDate = newTrialEnd.toISOString();
    subscription.nextBillingDate = newTrialEnd.toISOString();
    subscription.status = 'active'; // Reactivate if expired
    
    await saveMasterData(masterData);
    
    res.json({ 
      success: true, 
      message: `Trial extended by ${extensionDays} days`,
      subscription 
    });
  } catch (error) {
    console.error('Error extending trial:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/master/subscriptions/:subscriptionId/convert-trial', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { newPlan, billing } = req.body;
    
    const masterData = await loadMasterData();
    const subscription = masterData.subscriptions?.find(s => s.id === subscriptionId);
    
    if (!subscription) {
      return res.status(404).json({ success: false, message: 'Subscription not found' });
    }
    
    if (subscription.plan !== 'trial') {
      return res.status(400).json({ success: false, message: 'Only trial subscriptions can be converted' });
    }
    
    // Get plan configuration
    const planConfig = {
      trial: { monthlyPrice: 0, maxUsers: 3, maxTickets: 50, maxStorage: 1, features: ['basic_sla', 'email_support'] },
      starter: { monthlyPrice: 29, maxUsers: 10, maxTickets: 500, maxStorage: 10, features: ['standard_sla', 'email_chat_support', 'basic_analytics', '3_integrations'] },
      pro: { monthlyPrice: 99, maxUsers: -1, maxTickets: -1, maxStorage: 100, features: ['premium_sla', 'priority_support', 'advanced_analytics', 'unlimited_integrations', 'custom_branding', 'api_access'] }
    };
    
    const config = planConfig[newPlan];
    if (!config) {
      return res.status(400).json({ success: false, message: 'Invalid plan type' });
    }
    
    // Convert trial to paid plan
    subscription.previousPlan = 'trial';
    subscription.plan = newPlan;
    subscription.monthlyPrice = config.monthlyPrice;
    subscription.maxUsers = config.maxUsers;
    subscription.maxTickets = config.maxTickets;
    subscription.maxStorage = config.maxStorage;
    subscription.features = config.features;
    subscription.billingCycle = billing || 'monthly';
    subscription.trialEndDate = null; // Remove trial end date
    subscription.nextBillingDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    subscription.convertedAt = new Date().toISOString();
    
    await saveMasterData(masterData);
    
    res.json({ 
      success: true, 
      message: `Trial converted to ${newPlan} plan`,
      subscription 
    });
  } catch (error) {
    console.error('Error converting trial:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Usage Management APIs
app.get('/api/tenant/:tenantId/usage', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const masterData = await loadMasterData();
    const subscription = masterData.subscriptions?.find(s => s.tenantId === tenantId);
    
    if (!subscription) {
      return res.status(404).json({ success: false, message: 'Subscription not found' });
    }
    
    const usage = {
      users: {
        current: subscription.currentUsers,
        limit: subscription.maxUsers,
        percentage: subscription.maxUsers > 0 ? (subscription.currentUsers / subscription.maxUsers) * 100 : 0
      },
      tickets: {
        current: subscription.currentTickets,
        limit: subscription.maxTickets,
        percentage: subscription.maxTickets > 0 ? (subscription.currentTickets / subscription.maxTickets) * 100 : 0
      },
      storage: {
        current: subscription.currentStorage,
        limit: subscription.maxStorage,
        percentage: subscription.maxStorage > 0 ? (subscription.currentStorage / subscription.maxStorage) * 100 : 0
      },
      overallPercentage: subscription.usagePercentage
    };
    
    res.json({ success: true, usage });
  } catch (error) {
    console.error('Error fetching usage:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/tenant/:tenantId/usage/check', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { type, amount = 1 } = req.body;
    
    if (!type || !['users', 'tickets', 'storage'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid usage type' });
    }
    
    const result = await checkUsageLimits(tenantId, type, amount);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error checking usage limits:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/tenant/:tenantId/usage/update', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { type, increment = 1 } = req.body;
    
    if (!type || !['users', 'tickets', 'storage'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid usage type' });
    }
    
    // First check if the update is allowed
    const limitCheck = await checkUsageLimits(tenantId, type, increment);
    if (!limitCheck.allowed) {
      return res.status(403).json({ 
        success: false, 
        message: limitCheck.reason,
        limitExceeded: true,
        details: limitCheck
      });
    }
    
    // Update usage
    const success = await updateTenantUsage(tenantId, type, increment);
    
    if (success) {
      res.json({ success: true, message: 'Usage updated successfully' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to update usage' });
    }
  } catch (error) {
    console.error('Error updating usage:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Ticket Management Endpoints
app.get('/api/tenant/:tenantId/tickets', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantData = await loadTenantData(tenantId);
    const tickets = tenantData.tickets || [];
    
    res.json({ success: true, tickets });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/tenant/:tenantId/tickets', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { title, description, priority = 'Normal', customer } = req.body;
    
    if (!title || !description) {
      return res.status(400).json({ success: false, message: 'Title and description are required' });
    }
    
    // Check usage limits before creating ticket
    const usageCheck = await checkUsageLimits(tenantId, 'tickets', 1);
    if (!usageCheck.allowed) {
      return res.status(403).json({ 
        success: false, 
        message: 'Ticket limit exceeded',
        details: usageCheck
      });
    }
    
    const tenantData = await loadTenantData(tenantId);
    const newTicket = {
      id: Date.now(),
      title,
      description,
      priority,
      status: 'Open',
      customer: customer || 'Unknown',
      assignee: 'Unassigned',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    tenantData.tickets = tenantData.tickets || [];
    tenantData.tickets.push(newTicket);
    
    await saveTenantData(tenantId, tenantData);
    
    // Update usage
    await updateTenantUsage(tenantId, 'tickets', 1);
    
    // Send email notification
    await sendTicketNotification(tenantId, newTicket, 'Created');
    
    res.json({ success: true, ticket: newTicket });
  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.put('/api/tenant/:tenantId/tickets/:ticketId', async (req, res) => {
  try {
    const { tenantId, ticketId } = req.params;
    const { status, assignee, priority } = req.body;
    
    const tenantData = await loadTenantData(tenantId);
    const ticket = tenantData.tickets.find(t => t.id == ticketId);
    
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    
    const oldStatus = ticket.status;
    
    if (status) ticket.status = status;
    if (assignee) ticket.assignee = assignee;
    if (priority) ticket.priority = priority;
    
    ticket.updatedAt = new Date().toISOString();
    
    await saveTenantData(tenantId, tenantData);
    
    // Send email notification for status changes
    if (status && status !== oldStatus) {
      await sendTicketNotification(tenantId, ticket, `Status changed to ${status}`);
    }
    
    res.json({ success: true, ticket });
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Email Notification Endpoints
app.post('/api/tenant/:tenantId/notifications/test', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { email, type = 'test' } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email address is required' });
    }
    
    let subject, html;
    
    switch (type) {
      case 'test':
        subject = 'Test Email Notification - A1 Support Dashboard';
        html = `
          <h2>Test Email Notification</h2>
          <p>This is a test email from the A1 Support Dashboard system.</p>
          <p><strong>Tenant:</strong> ${tenantId}</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          <p>If you received this email, the notification system is working correctly!</p>
        `;
        break;
      case 'billing':
        subject = 'Billing Notification Test';
        html = `
          <h2>Billing Notification Test</h2>
          <p>This is a test billing notification.</p>
          <p><strong>Tenant:</strong> ${tenantId}</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
        `;
        break;
      default:
        subject = 'Notification Test';
        html = `<p>Test notification for ${tenantId}</p>`;
    }
    
    const result = await sendEmailNotification(email, subject, html);
    
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error sending test notification:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Email Processing Management APIs
app.get('/api/master/email-settings', async (req, res) => {
  try {
    const isConfigured = EMAIL_PROCESSING_CONFIG.imap.user !== 'support@example.com' && 
                        EMAIL_PROCESSING_CONFIG.imap.password !== 'demo-password';
    
    res.json({ 
      success: true, 
      settings: {
        imap: {
          host: EMAIL_PROCESSING_CONFIG.imap.host,
          port: EMAIL_PROCESSING_CONFIG.imap.port,
          user: EMAIL_PROCESSING_CONFIG.imap.user,
          configured: isConfigured
        },
        checkInterval: EMAIL_PROCESSING_CONFIG.checkInterval,
        status: isConfigured ? 'active' : 'demo',
        needsConfiguration: !isConfigured
      }
    });
  } catch (error) {
    console.error('Error fetching email settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/master/email-settings/test', async (req, res) => {
  try {
    const { email, subject, message } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email address is required' });
    }
    
    const testSubject = subject || 'Email Processing Test';
    const testMessage = message || 'This is a test email to verify the email processing system is working correctly.';
    
    // Simulate email processing
    const mockEmail = {
      from: { value: [{ address: email }] },
      subject: testSubject,
      text: testMessage,
      html: `<p>${testMessage}</p>`
    };
    
    await processEmail(mockEmail);
    
    res.json({ success: true, message: 'Email processing test completed' });
  } catch (error) {
    console.error('Error testing email processing:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.put('/api/master/tenants/:tenantId/email-settings', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { domain, emailProcessingEnabled } = req.body;
    
    const masterData = await loadMasterData();
    const tenant = masterData.tenants.find(t => t.tenantId === tenantId);
    
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }
    
    if (domain !== undefined) tenant.domain = domain;
    if (emailProcessingEnabled !== undefined) tenant.emailProcessingEnabled = emailProcessingEnabled;
    
    tenant.updatedAt = new Date().toISOString();
    
    await saveMasterData(masterData);
    
    res.json({ success: true, message: 'Email settings updated successfully', tenant });
  } catch (error) {
    console.error('Error updating email settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Billing Management APIs
app.get('/api/master/billing', async (req, res) => {
  try {
    const masterData = await loadMasterData();
    const subscriptions = masterData.subscriptions || [];
    
    // Calculate billing metrics
    const activeSubscriptions = subscriptions.filter(s => s.status === 'active');
    const mrr = activeSubscriptions.reduce((sum, s) => sum + s.monthlyPrice, 0);
    const pendingPayments = 0; // Placeholder - would calculate from payment status
    const churnRate = 5; // Placeholder - would calculate from historical data
    const arpu = activeSubscriptions.length > 0 ? mrr / activeSubscriptions.length : 0;
    
    // Mock transaction data
    const transactions = [
      {
        id: 'txn_1',
        date: new Date().toISOString(),
        tenantName: 'Apoyar',
        description: 'Monthly subscription - Pro Plan',
        amount: 99,
        status: 'paid',
        invoiceId: 'inv_001'
      },
      {
        id: 'txn_2',
        date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        tenantName: 'Test Company',
        description: 'Monthly subscription - Starter Plan',
        amount: 29,
        status: 'pending',
        invoiceId: 'inv_002'
      }
    ];

    res.json({ 
      success: true, 
      billing: { mrr, pendingPayments, churnRate, arpu },
      transactions 
    });
  } catch (error) {
    console.error('Error fetching billing data:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Plan Management APIs
app.get('/api/master/plans', async (req, res) => {
  try {
    const masterData = await loadMasterData();
    const plans = masterData.plans || getDefaultPlans();
    res.json({ success: true, plans });
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/master/plans', async (req, res) => {
  try {
    const { name, id, monthlyPrice, maxUsers, maxTickets, maxStorage, status, features } = req.body;
    
    if (!name || !id) {
      return res.status(400).json({ success: false, message: 'Plan name and ID are required' });
    }

    const masterData = await loadMasterData();
    
    // Check if plan already exists
    const existingPlan = masterData.plans?.find(p => p.id === id);
    if (existingPlan) {
      return res.status(400).json({ success: false, message: 'Plan with this ID already exists' });
    }

    const plan = {
      id: id,
      name: name,
      monthlyPrice: monthlyPrice || 0,
      maxUsers: maxUsers || 0,
      maxTickets: maxTickets || 0,
      maxStorage: maxStorage || 0,
      status: status || 'active',
      features: features || [],
      subscriberCount: 0,
      createdAt: new Date().toISOString()
    };

    if (!masterData.plans) {
      masterData.plans = [];
    }
    
    masterData.plans.push(plan);
    await saveMasterData(masterData);

    res.json({ success: true, message: 'Plan created successfully', plan });
  } catch (error) {
    console.error('Error creating plan:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Helper function to get default plans
function getDefaultPlans() {
  return [
    {
      id: 'trial',
      name: 'Trial',
      monthlyPrice: 0,
      maxUsers: 3,
      maxTickets: 50,
      maxStorage: 1,
      status: 'active',
      features: ['basic_sla', 'email_support'],
      subscriberCount: 0,
      createdAt: new Date().toISOString()
    },
    {
      id: 'starter',
      name: 'Starter',
      monthlyPrice: 29,
      maxUsers: 10,
      maxTickets: 500,
      maxStorage: 10,
      status: 'active',
      features: ['standard_sla', 'email_chat_support', 'basic_analytics', '3_integrations'],
      subscriberCount: 0,
      createdAt: new Date().toISOString()
    },
    {
      id: 'pro',
      name: 'Pro',
      monthlyPrice: 99,
      maxUsers: -1,
      maxTickets: -1,
      maxStorage: 100,
      status: 'active',
      features: ['premium_sla', 'priority_support', 'advanced_analytics', 'unlimited_integrations', 'custom_branding', 'api_access'],
      subscriberCount: 0,
      createdAt: new Date().toISOString()
    }
  ];
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    features: [
      'Multi-tenant JSON backend',
      'Master Admin tenant management',
      'Tenant isolation',
      'User authentication',
      'Ticket management',
      'CMDB management'
    ]
  });
});

// Start server
async function startServer() {
  try {
    await ensureDirectories();
    await initializeMasterDatabase();
    await initializeTenantDatabase('apoyar');
    
    app.listen(PORT, () => {
      console.log('🚀 A1 Support Dashboard - Multi-Tenant Backend');
      console.log('==========================================');
      console.log(`📱 Open your browser and go to: http://localhost:${PORT}`);
      console.log(`🔧 Health check: http://localhost:${PORT}/health`);
      console.log('✨ Features available:');
      console.log('   • Multi-tenant architecture');
      console.log('   • Master Admin tenant management');
      console.log('   • Tenant isolation');
      console.log('   • User authentication');
      console.log('   • Ticket management');
      console.log('   • CMDB management');
      console.log('   • Email processing');
      console.log('🔐 Master Admin Credentials:');
      console.log('   Master: master / master123');
      console.log('🔐 Tenant Credentials (Apoyar):');
      console.log('   Admin: admin / admin123');
      console.log('   Expert: expert / password123');
      console.log('   Customer: customer / password123');
      console.log('💡 Press Ctrl+C to stop the server');
      
      // Start email processing
      console.log('📧 Starting email processing...');
      setInterval(processIncomingEmails, EMAIL_PROCESSING_CONFIG.checkInterval);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();