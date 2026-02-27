# 🚀 Quick Setup Guide - MySQL Multi-Tenant Backend

## ⚡ **5-Minute Setup**

### **1. Prerequisites Check**
```bash
# Check Node.js version (needs 14+)
node --version

# Check if MySQL is running
mysql --version
# or
sudo systemctl status mysql
```

### **2. Install Dependencies**
```bash
npm install
```

### **3. Setup MySQL Databases**
```bash
npm run setup-db
```
**Follow the prompts:**
- MySQL Host: `localhost` (default)
- MySQL Port: `3306` (default) 
- MySQL Username: `root` (default)
- MySQL Password: `[your_mysql_password]`

### **4. Start the Prototype**
```bash
npm start
```

### **5. Open Your Browser**
Navigate to: `http://localhost:3000`

---

## 🔐 **Login Credentials**

Default passwords are set via environment variables (`DEFAULT_MASTER_PASSWORD`, `DEFAULT_TENANT_PASSWORD`).
See your `.env` file or ask the team lead for current credentials.

---

## 🏗️ **What Gets Created**

### **Databases**
- `a1_master` - System management
- `a1_tenant_apoyar` - Apoyar company
- `a1_tenant_bleckmann` - Bleckmann company

### **Users**
- **Master Admin**: Full system access
- **Tenant Admins**: Company management
- **Experts**: Ticket handling
- **Customers**: Self-service portal

### **Sample Data**
- CMDB items and configuration items
- Sample tickets with SLA tracking
- User profiles and skills

---

## 🧪 **Test the System**

### **Master Admin Functions**
1. Login as master admin
2. View tenant overview: `GET /api/master/overview`
3. Check tenant list: `GET /api/master/tenants`
4. View audit logs: `GET /api/master/audit-logs`

### **Tenant Operations**
1. Login as tenant user
2. Access company-specific data
3. Create tickets and manage CMDB
4. Test SLA tracking

### **API Testing**
```bash
# Health check
curl http://localhost:3000/health

# Database status
curl http://localhost:3000/api/db/status

# Available tenants
curl http://localhost:3000/api/auth/tenants
```

---

## 🚨 **Troubleshooting**

### **MySQL Connection Issues**
```bash
# Check MySQL service
sudo systemctl start mysql
sudo systemctl enable mysql

# Reset root password if needed
sudo mysql_secure_installation
```

### **Database Setup Errors**
```bash
# Ensure root has privileges
mysql -u root -p
GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### **Port Conflicts**
```bash
# Use different port
PORT=3001 npm start
```

---

## 📊 **System Architecture**

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Master DB     │    │  Tenant DB      │    │  Tenant DB      │
│   a1_master     │    │  a1_tenant_     │    │  a1_tenant_     │
│                 │    │  apoyar         │    │  bleckmann      │
│ • master_users  │    │                 │    │                 │
│ • tenants       │    │ • users         │    │ • users         │
│ • audit_log     │    │ • tickets       │    │ • tickets       │
│                 │    │ • cmdb_items    │    │ • cmdb_items    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │   Web App       │
                    │   Frontend      │
                    │                 │
                    │ • Role-based    │
                    │ • Multi-tenant  │
                    │ • Real-time SLA │
                    └─────────────────┘
```

---

## 🎯 **Next Steps**

1. **Explore the UI** - Test different roles and features
2. **Add New Tenants** - Use master admin to create companies
3. **Customize Schemas** - Modify database structures as needed
4. **Integrate APIs** - Connect to your existing systems
5. **Scale Up** - Add more tenants and features

---

**🎉 You're all set! Your multi-tenant MySQL backend is ready to use.**

