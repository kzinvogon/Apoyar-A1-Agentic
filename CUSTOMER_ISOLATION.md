# Customer Isolation Implementation

## Changes Made

### 1. Database Schema Update
**File:** MySQL database  
**Change:** Added `customer_id` column to `cmdb_items` table

```sql
ALTER TABLE cmdb_items ADD COLUMN customer_id INT DEFAULT NULL;
```

### 2. Tickets API - Role-Based Filtering
**File:** `/Users/davidhamilton/Dev/Apoyar-A1-Agentic/routes/tickets.js`

**Change:** Updated GET endpoint to filter tickets based on user role

- **Customers:** Can only see their own tickets (filtered by customer_id)
- **Admins:** Can see all tickets
- **Experts:** Can see all tickets

```javascript
// Filter by customer if role is 'customer'
if (req.user.role === 'customer') {
  query += ` WHERE t.customer_id = ${req.user.userId}`;
}
```

### 3. CMDB API - New Route
**File:** `/Users/davidhamilton/Dev/Apoyar-A1-Agentic/routes/cmdb.js` (NEW)

**Created:** New CMDB API endpoint with role-based filtering

- **Customers:** Can only see their own CMDB items
- **Admins:** Can see all CMDB items
- **Experts:** Can see all CMDB items

### 4. Server Integration
**File:** `/Users/davidhamilton/Dev/Apoyar-A1-Agentic/server.js`

**Change:** Added CMDB routes to the server

```javascript
const cmdbRoutes = require('./routes/cmdb');
app.use('/api/cmdb', cmdbRoutes);
```

## How It Works

### Customer View
- Login as customer
- See only your own tickets
- See only your own CMDB items
- Cannot access other customers' data

### Admin View
- Login as admin
- See all tickets (all customers)
- See all CMDB items (all customers)
- Full access to all data

### Expert View
- Login as expert
- See all tickets (all customers)
- See all CMDB items (all customers)
- Full access to all data

## Testing

1. **As Customer:**
   - Login as a customer user
   - You should only see your own tickets
   - You should only see your own CMDB items

2. **As Admin:**
   - Login as an admin user
   - You should see all tickets from all customers
   - You should see all CMDB items from all customers

3. **As Expert:**
   - Login as an expert user
   - You should see all tickets from all customers
   - You should see all CMDB items from all customers

## API Endpoints

### Tickets
- `GET /api/tickets/:tenantId` - Get tickets (filtered by role)
- `GET /api/tickets/:tenantId/:ticketId` - Get specific ticket
- `POST /api/tickets/:tenantId` - Create ticket
- `PUT /api/tickets/:tenantId/:ticketId` - Update ticket

### CMDB
- `GET /api/cmdb/:tenantId/items` - Get CMDB items (filtered by role)

## Database Structure

### tickets table
- `requester_id` or `customer_id` - Links to customer user
- Already has customer relationship

### cmdb_items table
- `customer_id` - Links to customer user (NEW)
- Filters items by customer

## Next Steps

1. Refresh your browser (Cmd+Shift+R)
2. Test customer login - should only see own data
3. Test admin/expert login - should see all data
