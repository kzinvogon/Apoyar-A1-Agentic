# ServiFlow - ITSM SaaS Platform

## Project Overview
ServiFlow is a multi-tenant ITSM (IT Service Management) SaaS platform with AI-powered ticket management, SLA tracking, CMDB, and knowledge base features.

## Architecture

### Multi-Tenant Database Structure
- **Master DB:** `a1_master` (Railway) / `a1_master` (localhost)
  - Stores: tenants, master_users, plans, subscriptions, billing
- **Tenant DBs:** `a1_tenant_{tenant_code}` (one per tenant)
  - Stores: users, tickets, cmdb_items, sla_definitions, etc.

### Key Files
- `server.js` - Main Express server entry point
- `config/database.js` - Database connection management
- `services/tenant-provisioning.js` - New tenant creation logic
- `routes/auth.js` - Authentication endpoints
- `routes/master.js` - Master admin API
- `routes/signup.js` - Public signup flow
- `services/sla-notifier.js` - SLA notification scheduler
- `A1 Support Build from here .html` - Main SPA frontend

## Environments & Deployment Workflow

### CRITICAL: Deployment Process
**ALWAYS follow this workflow - no exceptions:**
1. **Commit changes locally** (do NOT push to git yet)
2. **Deploy to UAT:** `railway up --detach` (CLI defaults to UAT)
3. **Test on UAT:** https://web-uat-uat.up.railway.app
4. **Wait for user approval**
5. **After approval, deploy to production:**
   ```bash
   source railway-env.sh prod   # Switch to production
   railway redeploy --yes       # Deploy
   source railway-env.sh uat    # Switch back to UAT default
   ```
6. **Push to git:** `git push` (only after production is approved)

### Railway CLI Setup
The CLI is configured to default to UAT. Use the helper script:
```bash
source railway-env.sh uat      # Switch to UAT (default)
source railway-env.sh prod     # Switch to Production
source railway-env.sh status   # Show current environment
```

### Railway UAT (User Acceptance Testing)
- **App URL:** https://web-uat-uat.up.railway.app
- **Service:** web-uat
- **This is the DEFAULT environment**

### Railway Production
- **App URL:** https://app.serviflow.app
- **Service:** web
- **MySQL Host:** tramway.proxy.rlwy.net:19355
- **Only deploy here AFTER UAT approval**

### Localhost (Development)
- **App URL:** http://localhost:3000
- **MySQL:** localhost with root user (no password)
- **Start:** `npm start`

## Login Credentials

### Railway
- **Tenant Code:** `apoyar`
- **Admin:** `admin` / `password123`
- **Master Admin:** `admin` / `admin123` (role: Master Admin)

### Localhost
- **Tenant Code:** `apoyar`
- **Admin:** `admin` / `password123`
- **Master Admin:** `admin` / `admin123`

## Database Schema Notes

### CRITICAL: Column Naming Conventions

1. **Tenants table uses `status` NOT `is_active`**
   ```sql
   -- CORRECT
   WHERE status = 'active'
   -- WRONG (will cause errors)
   WHERE is_active = 1
   ```

2. **Tickets table column: `first_responded_at`**
   - NOT `first_response_at`
   - Set when ticket moves from 'Open' to any other status

3. **CMDB Items - New Schema**
   ```sql
   cmdb_id, asset_name, asset_category, category_field_value,
   brand_name, model_name, customer_name, employee_of,
   asset_location, status, sla_definition_id
   ```
   - Old schema had `name`, `type` - don't use these

### SLA Ticket Columns
All tenant ticket tables must have:
```sql
sla_definition_id, sla_applied_at, response_due_at, resolve_due_at,
first_responded_at, notified_response_near_at, notified_response_breached_at,
notified_response_past_at, notified_resolve_near_at, notified_resolve_breached_at,
notified_resolve_past_at, sla_source
```

## Recent Issues Fixed (Jan 2026)

### APO-11: Tenant Management Issues
- Dashboard showed 0 tenants, values appeared after navigation
- **Root cause:** Queries used `is_active` but table has `status` column
- **Fixed in:** routes/master.js, config/database.js, server.js, routes/signup.js, services/sla-notifier.js

### APO-12: Welcome Email Bugs
- Step 2 referenced non-existent "Team Management" menu
- Step 1 missing login credentials explanation
- **Fixed in:** services/tenant-provisioning.js (welcome email template)

### APO-13: Deployment Crash
- Missing `sla_definitions` table, `response_due_at`, `asset_name` columns
- **Root cause:** Tenant provisioning created old schema
- **Fixed in:** services/tenant-provisioning.js (updated all CREATE TABLE statements)

### APO-14: Localhost Doesn't List Tenants
- Missing `tenant_subscriptions` table locally
- Created table and synced to Railway

## Common Issues & Solutions

### Server Hangs on Login
- Usually MySQL connection pool exhaustion
- **Fix:** Kill stale connections and restart
```bash
# Kill node processes
pkill -f "node.*server"
lsof -ti:3000 | xargs kill -9

# Clean MySQL connections (localhost)
mysql -u root -e "SELECT CONCAT('KILL ', id, ';') FROM information_schema.processlist WHERE user='root' AND command='Sleep' AND time > 60;" -N | mysql -u root

# Restart
npm start
```

### Railway Deployment Not Updating
- Changes must be committed to git before `railway up`
- Railway deploys from git, not local files
```bash
git add .
git commit -m "Your message"
git push
railway up --detach
```

### Adding Columns to Existing Tenant DBs
When adding new columns, update ALL tenant databases:
```bash
# Get Railway MySQL password
railway variables | grep MYSQLPASSWORD

# Run migration on all tenant DBs
mysql -h tramway.proxy.rlwy.net -P 19355 -u root -p{PASSWORD} -e "
ALTER TABLE a1_tenant_{code}.tickets ADD COLUMN new_col TYPE;
"
```

## Linear Integration
- Project uses Linear for issue tracking
- MCP server available for Linear API access
- Issues prefixed with APO- (e.g., APO-11, APO-12)

## Testing Checklist
After changes, verify:
1. [ ] Login works on localhost (all roles)
2. [ ] Login works on Railway
3. [ ] Master admin can list tenants
4. [ ] New tenant provisioning creates correct schema
5. [ ] SLA notifier runs without errors (`railway logs`)
