# CMDB Items Management

## Where is the CMDB UI?

The CMDB management interface is in the main dashboard navigation:

1. **Login** as Admin or Expert
2. Click **"My CMDB"** in the navigation (left sidebar)
3. You'll see:
   - List of all CMDB items
   - Search functionality
   - Customer filter dropdown
   - **"+ Add CMDB Item"** button
   - **"📥 Import CMDB Items"** button

## How to View CMDB Items

### As Customer
- Login as customer (customer / password123)
- Click "My CMDB" in navigation
- You'll only see your own CMDB items (isolated view)

### As Admin or Expert
- Login as admin/expert (admin / password123)
- Click "My CMDB" in navigation
- You'll see all CMDB items from all customers

## Adding CMDB Items

### Option 1: Through Database (Direct)
```bash
# Connect to database
mysql -uroot a1_tenant_apoyar

# Insert CMDB item
INSERT INTO cmdb_items (name, type, status, customer_id, description)
VALUES (
  'Production Server 01',
  'server',
  'active',
  3,  -- customer_id (e.g., customer user id)
  'Main production server'
);
```

### Option 2: Through UI (Future Enhancement)
The buttons are in place but currently show informational messages. 
To implement full functionality, you would need to:
1. Create a form dialog for adding items
2. Implement file upload for bulk import
3. Add API endpoints for CRUD operations

## Current CMDB Item Types

Available types (enum):
- `server`
- `network`
- `application`
- `database`
- `other`

Available statuses:
- `active`
- `inactive`
- `maintenance`
- `retired`

## Database Structure

```sql
CREATE TABLE cmdb_items (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  type ENUM('server','network','application','database','other') NOT NULL,
  status ENUM('active','inactive','maintenance','retired') DEFAULT 'active',
  owner_id INT,  -- Links to user
  customer_id INT,  -- Links to customer (NEW - for isolation)
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

## Quick Import Example

```bash
# Create a CSV file: cmdb_import.csv
# Columns: name,type,status,customer_id,description

# Import via MySQL
mysql -uroot a1_tenant_apoyar << 'SQL'
LOAD DATA LOCAL INFILE 'cmdb_import.csv'
INTO TABLE cmdb_items
FIELDS TERMINATED BY ','
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
(name, type, status, customer_id, description);
SQL
```

## Viewing CMDB Items via API

```bash
# Get all CMDB items (filtered by role)
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/cmdb/apoyar/items

# Response includes role-based filtering:
# - Customers see only their items
# - Admins/Experts see all items
```

## Role-Based Access

- **Customer:** Only sees own CMDB items (filtered by customer_id)
- **Admin:** Sees all CMDB items from all customers
- **Expert:** Sees all CMDB items from all customers

## Location in UI

**Navigation Path:**
1. Main Dashboard
2. Left Sidebar → "My CMDB"
3. View shows all items with customer, name, and actions

**URL:** The view switches to `view-cmdb` which is accessible via the CMDB navigation link
