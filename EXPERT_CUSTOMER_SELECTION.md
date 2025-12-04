# Expert Customer Selection for Requests

## Overview
Experts and Admins can now select which customer they're creating a ticket for when raising a request. Once a customer is selected, the CMDB items shown are filtered to only that customer's items.

## Changes Made

### 1. UI - Customer Selection Field
**File:** `/Users/davidhamilton/Dev/Apoyar-A1-Agentic/A1 Support Build from here .html`

Added a customer dropdown field that:
- **Shows** for Experts and Admins
- **Hides** for Customers (they are automatically the request owner)
- Automatically loads customers when the form opens
- Filters CMDB items when a customer is selected

### 2. JavaScript Functions
**File:** `/Users/davidhamilton/Dev/Apoyar-A1-Agentic/A1 Support Build from here .html`

Added three new functions:

1. **`loadRaiseFormOptions()`** - Updated to show/hide customer field based on role
2. **`loadCustomersForRaiseRequest()`** - Fetches list of customers from API
3. **`loadCMDBForCustomer()`** - Loads CMDB items filtered by selected customer

### 3. API Endpoint - List Customers
**File:** `/Users/davidhamilton/Dev/Apoyar-A1-Agentic/routes/auth.js`

Added new endpoint:
- `GET /api/auth/customers` - Returns list of all customers in the tenant
- Requires authentication (token)
- Only returns active customers

### 4. API Endpoint - Filter CMDB by Customer
**File:** `/Users/davidhamilton/Dev/Apoyar-A1-Agentic/routes/cmdb.js`

Updated CMDB items endpoint:
- Now accepts `customer_id` query parameter
- Filters CMDB items by customer when specified
- Example: `GET /api/cmdb/apoyar/items?customer_id=3`

## How It Works

### For Customers
1. Login as customer
2. Navigate to "Raise Request"
3. Customer field is **not shown** (they are automatically the request owner)
4. CMDB items shown are automatically their own items
5. Submit request as themselves

### For Experts/Admins
1. Login as expert or admin
2. Navigate to "Raise Request"
3. **Customer dropdown appears** showing all customers
4. Select a customer from the dropdown
5. CMDB items automatically filter to show only that customer's items
6. Submit request on behalf of the selected customer

## API Flow

```
User clicks "Raise Request"
  ↓
Form loads → For Expert/Admin: Show customer field
  ↓
loadCustomersForRaiseRequest() → Fetches customers via GET /api/auth/customers
  ↓
User selects customer → loadCMDBForCustomer()
  ↓
GET /api/cmdb/apoyar/items?customer_id=3 → Returns filtered CMDB items
  ↓
User completes form and submits
  ↓
submitRequest() → Creates ticket with selected customer_id
```

## Database Query
```sql
-- Get customers for the expert/admin to select from
SELECT id, username, email, full_name, role, phone, department
FROM users
WHERE role = 'customer' AND is_active = TRUE
ORDER BY full_name ASC;

-- Get CMDB items for selected customer
SELECT ci.*, u.full_name as owner_name
FROM cmdb_items ci
LEFT JOIN users u ON ci.owner_id = u.id
WHERE ci.customer_id = 3  -- Selected customer ID
ORDER BY ci.created_at DESC;
```

## Files Modified
- `A1 Support Build from here .html` - Added customer field and functions
- `routes/auth.js` - Added `/customers` endpoint
- `routes/cmdb.js` - Added customer_id query parameter support

## Testing

### As Expert
1. Login as expert (expert / password123)
2. Click "📝 Raise Request"
3. You should see "Select Customer" dropdown
4. Select "customer (david.hamilton@sustentus.com)"
5. CMDB items shown should be filtered to that customer only
6. Submit request

### As Customer
1. Login as customer (customer / password123)
2. Click "📝 Raise Request"
3. Customer field should **NOT** be visible
4. Submit request (automatically for yourself)

## Current Status
✅ Customer selection field added
✅ API endpoints created
✅ CMDB filtering implemented
✅ JavaScript functions added
✅ Server restarted

**Next Step:** Refresh your browser and test!
