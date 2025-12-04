# Manage CMDB Types Feature

## Overview
Added a "Manage CMDB Types" menu item for Admin and Expert users to define CMDB Item Types and CI Types with a one-to-many relationship.

## Database Structure

### cmdb_item_types Table (Parent)
- `id` - Primary key
- `name` - Name of the item type (e.g., 'server', 'network')
- `description` - Description of the item type
- `is_active` - Active status
- `created_at` / `updated_at` - Timestamps

### ci_types Table (Child - One-to-Many)
- `id` - Primary key
- `cmdb_item_type_id` - Foreign key to cmdb_item_types (ONE-TO-MANY)
- `name` - Name of the CI type (e.g., 'physical_server', 'virtual_machine')
- `description` - Description of the CI type
- `is_active` - Active status
- `created_at` / `updated_at` - Timestamps

## Default Data
The system comes pre-loaded with:
- **5 Item Types**: server, network, application, database, other
- **6 CI Types**: physical_server, virtual_machine, router, switch, mysql, postgresql

## Navigation
The "Manage CMDB Types" menu item is available in:
- **Admin Navigation**: ⚙️ Manage CMDB Types
- **Expert Navigation**: ⚙️ Manage CMDB Types
- **NOT available** for Customer role

## Features
1. **View Item Types**: Lists all CMDB Item Types with:
   - Name
   - Description
   - Count of associated CI Types
   - Active status
   - "View CI Types" button

2. **View CI Types**: When you click "View CI Types" on an Item Type, you see:
   - All CI Types belonging to that Item Type
   - One-to-many relationship displayed
   - Each CI Type shows name, description, and status

3. **Add Buttons**: 
   - "+ Add Item Type" button (Admin/Expert only)
   - "+ Add CI Type" button (shown when viewing CI Types)

## API Endpoints
- `GET /api/cmdb-types/:tenantId/item-types` - Get all item types
- `GET /api/cmdb-types/:tenantId/item-types/:itemTypeId/ci-types` - Get CI types for an item type
- `POST /api/cmdb-types/:tenantId/item-types` - Create new item type
- `POST /api/cmdb-types/:tenantId/item-types/:itemTypeId/ci-types` - Create new CI type

## Database Query Examples

### Get all item types with CI count:
```sql
SELECT cit.*, 
       (SELECT COUNT(*) FROM ci_types WHERE cmdb_item_type_id = cit.id) as ci_count
FROM cmdb_item_types cit
ORDER BY cit.name ASC;
```

### Get CI types for a specific item type:
```sql
SELECT * FROM ci_types 
WHERE cmdb_item_type_id = 1  -- e.g., server
ORDER BY name ASC;
```

## How to Access
1. Login as Admin (admin / password123) or Expert (expert / password123)
2. Click "⚙️ Manage CMDB Types" in the left navigation
3. View the list of Item Types
4. Click "View CI Types" on any Item Type to see the one-to-many relationship

## Files Modified
- `database/schema.sql` - Added cmdb_item_types and ci_types tables
- `routes/cmdb-types.js` - NEW file with API endpoints
- `server.js` - Added cmdbTypesRoutes
- `A1 Support Build from here .html` - Added navigation item and UI

## Current Status
✅ Database tables created
✅ Navigation item added
✅ UI view created
✅ API endpoints created
✅ JavaScript functions added

**Next Step:** Refresh your browser and test the feature!
