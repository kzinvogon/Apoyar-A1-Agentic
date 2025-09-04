# A1 Support Dashboard Platform - Multi-Tenant MySQL Backend

A comprehensive support platform prototype featuring **multi-tenant architecture** with separate MySQL databases per company, role-based dashboards, ticket management, SLA tracking, CMDB, and an interactive chatbot assistant.

## 🏗️ **Architecture Overview**

### **Multi-Tenant Design**
- **Master Database** (`a1_master`) - Manages tenant registrations and system-wide configuration
- **Tenant Databases** (`a1_tenant_{company}`) - Separate isolated databases per company
- **Master Admin System** - Super admin access to manage all tenants
- **Tenant Isolation** - Complete data separation between companies

### **Database Structure**
```
a1_master (Master Database)
├── master_users          # Super admins and master users
├── tenants              # Company registrations
├── tenant_admins        # Tenant administrator accounts
└── master_audit_log     # System-wide audit trail

a1_tenant_apoyar (Apoyar Company)
├── users                # Company users (admin/expert/customer)
├── experts              # Expert profiles and skills
├── customers            # Customer information (including Bleckmann)
├── cmdb_items           # Configuration items
├── configuration_items  # Detailed asset information
├── tickets              # Support tickets with SLA tracking
├── ticket_activity      # Ticket history and notes
└── tenant_audit_log     # Company audit trail

Note: Bleckmann is a customer of Apoyar, not a separate tenant
```

## 🚀 **Quick Start**

### **Prerequisites**
- **MySQL 8.0+** (or MariaDB 10.5+) running locally
- **Node.js** (version 14 or higher)
- **npm** or **yarn** package manager

### **Installation & Setup**

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Setup MySQL databases:**
   ```bash
   npm run setup-db
   ```
   This interactive script will:
   - Connect to your MySQL instance
   - Create master and tenant databases
   - Set up all required tables
   - Create default users
   - Generate environment configuration

3. **Start the prototype:**
   ```bash
   npm start
   ```

4. **Open your browser:**
   Navigate to `http://localhost:3000`

## 🔐 **Authentication & Access**

### **Master Admin System**
- **URL**: `http://localhost:3000/api/master/*`
- **Default Credentials**: `admin` / `admin123`
- **Capabilities**: 
  - Create/manage tenant companies
  - Monitor system health
  - View audit logs
  - Manage master users

### **Tenant Access**
- **URL**: `http://localhost:3000/api/tenant/*`
- **Default Credentials**: `admin` / `password123`, `expert` / `password123`, `customer` / `password123`
- **Isolation**: Each tenant has completely separate data

### **Customer Access (within tenants)**
- **Bleckmann**: `bleckmann` / `customer123`
- **Other Company**: `othercompany` / `customer123`
- **Access**: Customer portal within their tenant

## ✨ **Features**

### **🔐 Multi-Tenant Management**
- **Tenant Registration**: Add new companies with isolated databases
- **Resource Limits**: Set user and ticket limits per tenant
- **Subscription Plans**: Basic/Professional/Enterprise tiers
- **Status Management**: Active/Inactive/Suspended states

### **🔐 Role-Based Access Control**
- **Master Admin**: System-wide oversight and tenant management
- **Tenant Admin**: Company-specific user and resource management
- **Expert**: Ticket handling and SLA management
- **Customer**: Self-service portal and request management

### **🎫 Advanced Ticket Management**
- **Real-time SLA Tracking**: Visual countdown timers with risk indicators
- **Status Transitions**: Enforced workflow with validation
- **SLA Pause/Resume**: Compliance management for external dependencies
- **CMDB Integration**: Link tickets to configuration items

### **🗃️ Configuration Management (CMDB)**
- **Asset Categorization**: Windows servers, cloud instances, network devices
- **Detailed CIs**: Comprehensive asset information with custom fields
- **Tenant Isolation**: Each company sees only their assets
- **Search & Filter**: Advanced querying capabilities

### **🤖 AI-Powered Assistant**
- **Guided Request Creation**: Step-by-step ticket submission
- **CMDB Linking**: Intelligent asset association
- **Context Awareness**: Role and tenant-specific assistance

### **📊 Real-Time Monitoring**
- **SLA Compliance**: Live tracking with visual indicators
- **System Health**: Master admin dashboard with tenant overview
- **Audit Logging**: Comprehensive activity tracking
- **Performance Metrics**: User counts, ticket volumes, SLA risks

## 🔧 **Technical Details**

### **Backend Architecture**
- **Framework**: Express.js with middleware stack
- **Database**: MySQL 8.0+ with connection pooling
- **Authentication**: JWT-based with bcrypt password hashing
- **Security**: Helmet.js, CORS, input validation

### **Database Design**
- **Normalized Schema**: Proper foreign key relationships
- **JSON Fields**: Flexible data storage for skills and metadata
- **Indexing**: Optimized queries for performance
- **Audit Trail**: Complete change tracking

### **API Endpoints**
```
/api/auth/*          # Authentication (master/tenant login)
/api/master/*        # Master admin operations
/api/tenant/*        # Tenant-specific operations
/api/db/status       # Database health check
```

## 🚨 **Demo Limitations**

This prototype includes:
- ✅ **Full multi-tenant architecture**
- ✅ **Real MySQL databases**
- ✅ **Complete authentication system**
- ✅ **Role-based permissions**
- ✅ **SLA tracking and management**
- ✅ **CMDB functionality**

**Limitations for production:**
- No persistent file storage (use cloud storage)
- Basic rate limiting (implement Redis for production)
- Simple JWT secrets (use secure key management)
- No email integration (implement SMTP/email service)

## 🛠️ **Development & Customization**

### **Adding New Tenants**
```bash
# Via API (master admin)
POST /api/master/tenants
{
  "tenant_code": "newcompany",
  "company_name": "New Company Ltd",
  "display_name": "New Company",
  "database_user": "newcompany_user",
  "database_password": "secure_password"
}
```

### **Adding Customers to Existing Tenants**
```bash
# Via API (tenant admin)
POST /api/tenant/customers
{
  "username": "newcustomer",
  "email": "contact@newcustomer.com",
  "company": "New Customer Ltd",
  "phone": "+1234567890",
  "address": "Customer Address"
}
```

### **Customizing Tenant Schemas**
- Modify `scripts/setup-database.js`
- Add new tables to tenant database creation
- Update default data insertion

### **Extending Master System**
- Add new master user roles
- Implement additional tenant management features
- Create custom audit log categories

## 📱 **Browser Compatibility**

- **Chrome/Edge** (recommended)
- **Firefox** (full support)
- **Safari** (full support)
- **Mobile responsive** design

## 🆘 **Troubleshooting**

### **Common Issues**

1. **MySQL Connection Failed:**
   ```bash
   # Check MySQL service
   sudo systemctl status mysql
   
   # Verify credentials in .env file
   cat .env
   ```

2. **Database Setup Errors:**
   ```bash
   # Ensure MySQL user has privileges
   GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost';
   FLUSH PRIVILEGES;
   ```

3. **Port Already in Use:**
   ```bash
   # Change port in .env or use:
   PORT=3001 npm start
   ```

### **Health Checks**
- **Server**: `http://localhost:3000/health`
- **Database**: `http://localhost:3000/api/db/status`

## 📄 **License**

MIT License - feel free to use and modify for your needs.

## 🤝 **Production Considerations**

For production deployment, consider:
- **Database Security**: Use dedicated MySQL users with minimal privileges
- **Connection Encryption**: Enable SSL/TLS for database connections
- **Backup Strategy**: Implement automated database backups
- **Monitoring**: Add application performance monitoring (APM)
- **Load Balancing**: Scale horizontally with multiple application instances
- **CDN**: Use content delivery networks for static assets

---

**Happy prototyping with your multi-tenant MySQL backend! 🎉**
# Apoyar-A1-Agentic
