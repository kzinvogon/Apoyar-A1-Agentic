const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');

// Configure multer for CSV file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Public route - CSV template (no auth required)
router.get('/:tenantCode/template/items', (req, res) => {
  // Template matches the denormalized format from inventory exports
  // Multiple rows per asset with different field name/value pairs are supported
  const template = `Username,AssetName,Asset Category,Asset Category FieldName,Field Value,Brand Name,Model Name,Customer Name,Employee of,Asset Location,Comment,CreatedDateTime,Software Inventory
admin,Example Server,Windows server,External IP Address,192.168.1.100,Dell,PowerEdge R740,Acme Corp,IT Department,Data Center A,Production web server,01/01/2024 12:00:00,
admin,Example Server,Windows server,Host name,webserver01.local,Dell,PowerEdge R740,Acme Corp,IT Department,Data Center A,Production web server,01/01/2024 12:00:00,
admin,Example Server,Windows server,Memory MB,16384,Dell,PowerEdge R740,Acme Corp,IT Department,Data Center A,Production web server,01/01/2024 12:00:00,
admin,Example Laptop,Hardware,Username,jsmith,Lenovo,ThinkPad X1,John Smith,Sales,Office Building B,Sales team laptop,01/01/2024 12:00:00,`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=cmdb_template.csv');
  res.send(template);
});

// Apply verifyToken middleware to all protected CMDB routes
router.use(verifyToken);

// ============================================================================
// CMDB ITEMS ROUTES
// ============================================================================

// Get all CMDB items for a tenant
router.get('/:tenantCode/items', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { customer_name, asset_category, search } = req.query;
    const connection = await getTenantConnection(tenantCode);

    try {
      let query = `
        SELECT
          ci.*,
          u.full_name as created_by_name,
          (SELECT COUNT(*) FROM configuration_items WHERE cmdb_item_id = ci.id) as ci_count
        FROM cmdb_items ci
        LEFT JOIN users u ON ci.created_by = u.id
      `;

      const conditions = [];
      const params = [];

      // Filter by customer name
      if (customer_name) {
        conditions.push('ci.customer_name = ?');
        params.push(customer_name);
      }

      // Filter by asset category
      if (asset_category) {
        conditions.push('ci.asset_category = ?');
        params.push(asset_category);
      }

      // Search filter
      if (search) {
        conditions.push('(ci.asset_name LIKE ? OR ci.customer_name LIKE ? OR ci.asset_location LIKE ?)');
        const searchParam = `%${search}%`;
        params.push(searchParam, searchParam, searchParam);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ' ORDER BY ci.created_at DESC';

      const [items] = await connection.query(query, params);

      res.json({ success: true, items });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching CMDB items:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get single CMDB item with its CIs
router.get('/:tenantCode/items/:cmdbId', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get CMDB item
      const [items] = await connection.query(
        `SELECT ci.*, u.full_name as created_by_name
         FROM cmdb_items ci
         LEFT JOIN users u ON ci.created_by = u.id
         WHERE ci.cmdb_id = ?`,
        [cmdbId]
      );

      if (items.length === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      const item = items[0];

      // Get associated Configuration Items
      const [cis] = await connection.query(
        `SELECT ci.*, u.full_name as created_by_name
         FROM configuration_items ci
         LEFT JOIN users u ON ci.created_by = u.id
         WHERE ci.cmdb_item_id = ?
         ORDER BY ci.created_at DESC`,
        [item.id]
      );

      item.configuration_items = cis;

      res.json({ success: true, item });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching CMDB item:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create new CMDB item
router.post('/:tenantCode/items', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const {
      asset_name,
      asset_category,
      category_field_value,
      brand_name,
      model_name,
      customer_name,
      employee_of,
      asset_location,
      comment,
      status
    } = req.body;

    // Validation
    if (!asset_name || !asset_category) {
      return res.status(400).json({
        success: false,
        message: 'Asset name and category are required'
      });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      // Generate unique CMDB ID
      const cmdb_id = `CMDB-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const [result] = await connection.query(
        `INSERT INTO cmdb_items (
          cmdb_id, asset_name, asset_category, category_field_value,
          brand_name, model_name, customer_name, employee_of,
          asset_location, comment, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cmdb_id, asset_name, asset_category, category_field_value,
          brand_name, model_name, customer_name, employee_of,
          asset_location, comment, status || 'active', req.user.userId
        ]
      );

      // Fetch the created item
      const [items] = await connection.query(
        'SELECT * FROM cmdb_items WHERE id = ?',
        [result.insertId]
      );

      res.json({ success: true, message: 'CMDB item created successfully', item: items[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating CMDB item:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update CMDB item
router.put('/:tenantCode/items/:cmdbId', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const {
      asset_name,
      asset_category,
      category_field_value,
      brand_name,
      model_name,
      customer_name,
      employee_of,
      asset_location,
      comment,
      status
    } = req.body;

    const connection = await getTenantConnection(tenantCode);

    try {
      const [result] = await connection.query(
        `UPDATE cmdb_items SET
          asset_name = COALESCE(?, asset_name),
          asset_category = COALESCE(?, asset_category),
          category_field_value = ?,
          brand_name = ?,
          model_name = ?,
          customer_name = ?,
          employee_of = ?,
          asset_location = ?,
          comment = ?,
          status = COALESCE(?, status)
        WHERE cmdb_id = ?`,
        [
          asset_name, asset_category, category_field_value,
          brand_name, model_name, customer_name, employee_of,
          asset_location, comment, status, cmdbId
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      const [items] = await connection.query('SELECT * FROM cmdb_items WHERE cmdb_id = ?', [cmdbId]);

      res.json({ success: true, message: 'CMDB item updated successfully', item: items[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating CMDB item:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Delete CMDB item (and cascade delete CIs)
router.delete('/:tenantCode/items/:cmdbId', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      const [result] = await connection.query('DELETE FROM cmdb_items WHERE cmdb_id = ?', [cmdbId]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      res.json({ success: true, message: 'CMDB item deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting CMDB item:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ============================================================================
// CONFIGURATION ITEMS (CI) ROUTES
// ============================================================================

// Get all CIs for a specific CMDB item
router.get('/:tenantCode/items/:cmdbId/cis', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      const [cmdbItems] = await connection.query('SELECT id FROM cmdb_items WHERE cmdb_id = ?', [cmdbId]);

      if (cmdbItems.length === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      const [cis] = await connection.query(
        `SELECT ci.*, u.full_name as created_by_name
         FROM configuration_items ci
         LEFT JOIN users u ON ci.created_by = u.id
         WHERE ci.cmdb_item_id = ?
         ORDER BY ci.created_at DESC`,
        [cmdbItems[0].id]
      );

      res.json({ success: true, cis });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching CIs:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create new CI
router.post('/:tenantCode/items/:cmdbId/cis', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const {
      ci_name,
      asset_category,
      category_field_value,
      brand_name,
      model_name,
      serial_number,
      asset_location,
      employee_of,
      comment,
      status
    } = req.body;

    if (!ci_name) {
      return res.status(400).json({ success: false, message: 'CI name is required' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      // Get CMDB item ID
      const [cmdbItems] = await connection.query('SELECT id FROM cmdb_items WHERE cmdb_id = ?', [cmdbId]);

      if (cmdbItems.length === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      // Generate unique CI ID
      const ci_id = `CI-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const [result] = await connection.query(
        `INSERT INTO configuration_items (
          ci_id, cmdb_item_id, ci_name, asset_category, category_field_value,
          brand_name, model_name, serial_number, asset_location, employee_of,
          comment, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ci_id, cmdbItems[0].id, ci_name, asset_category, category_field_value,
          brand_name, model_name, serial_number, asset_location, employee_of,
          comment, status || 'active', req.user.userId
        ]
      );

      const [cis] = await connection.query('SELECT * FROM configuration_items WHERE id = ?', [result.insertId]);

      res.json({ success: true, message: 'CI created successfully', ci: cis[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating CI:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update CI
router.put('/:tenantCode/cis/:ciId', async (req, res) => {
  try {
    const { tenantCode, ciId } = req.params;
    const {
      ci_name,
      asset_category,
      category_field_value,
      brand_name,
      model_name,
      serial_number,
      asset_location,
      employee_of,
      comment,
      status
    } = req.body;

    const connection = await getTenantConnection(tenantCode);

    try {
      const [result] = await connection.query(
        `UPDATE configuration_items SET
          ci_name = COALESCE(?, ci_name),
          asset_category = ?,
          category_field_value = ?,
          brand_name = ?,
          model_name = ?,
          serial_number = ?,
          asset_location = ?,
          employee_of = ?,
          comment = ?,
          status = COALESCE(?, status)
        WHERE ci_id = ?`,
        [
          ci_name, asset_category, category_field_value, brand_name,
          model_name, serial_number, asset_location, employee_of,
          comment, status, ciId
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'CI not found' });
      }

      const [cis] = await connection.query('SELECT * FROM configuration_items WHERE ci_id = ?', [ciId]);

      res.json({ success: true, message: 'CI updated successfully', ci: cis[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating CI:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Delete CI
router.delete('/:tenantCode/cis/:ciId', async (req, res) => {
  try {
    const { tenantCode, ciId } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      const [result] = await connection.query('DELETE FROM configuration_items WHERE ci_id = ?', [ciId]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'CI not found' });
      }

      res.json({ success: true, message: 'CI deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting CI:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ============================================================================
// CSV IMPORT ROUTES
// ============================================================================

// Import CMDB items from CSV
// Supports denormalized format where multiple rows can represent the same asset
// with different field name/value pairs stored as Configuration Items (CIs)
router.post('/:tenantCode/import/items', upload.single('file'), async (req, res) => {
  try {
    const { tenantCode } = req.params;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const connection = await getTenantConnection(tenantCode);
    const errors = [];
    let lineNumber = 1;

    // Map to consolidate rows by asset name
    // Key: AssetName, Value: { asset info, fields: [{field_name, field_value}] }
    const assetMap = new Map();

    try {
      // Parse CSV
      const stream = Readable.from(req.file.buffer.toString());

      await new Promise((resolve, reject) => {
        stream
          .pipe(csv())
          .on('data', (row) => {
            lineNumber++;

            // Support both old format (asset_name) and new format (AssetName)
            const assetName = row['AssetName'] || row['AssetName*'] || row.asset_name;
            const assetCategory = row['Asset Category'] || row['Asset Category*'] || row.asset_category;
            const fieldName = row['Asset Category FieldName'] || row['Asset Category FieldName*'];
            const fieldValue = row['Field Value'] || row.category_field_value;
            const brandName = row['Brand Name'] || row.brand_name;
            const modelName = row['Model Name'] || row.model_name;
            const customerName = row['Customer Name'] || row.customer_name;
            const employeeOf = row['Employee of'] || row.employee_of;
            const assetLocation = row['Asset Location'] || row.asset_location;
            const comment = row['Comment'] || row.comment;
            const createdDateTime = row['CreatedDateTime'];
            const softwareInventory = row['Software Inventory'];

            // Validate required fields
            if (!assetName || !assetCategory) {
              errors.push({
                line: lineNumber,
                error: 'Missing required fields: AssetName and Asset Category'
              });
              return;
            }

            // Create unique key for the asset (combining name and category)
            const assetKey = `${assetName}|||${assetCategory}`;

            if (!assetMap.has(assetKey)) {
              // First row for this asset - create the base record
              assetMap.set(assetKey, {
                asset_name: assetName,
                asset_category: assetCategory,
                brand_name: brandName && brandName !== 'N/A' ? brandName : null,
                model_name: modelName && modelName !== 'N/A' ? modelName : null,
                customer_name: customerName ? customerName.trim() : null,
                employee_of: employeeOf && employeeOf !== 'N/A' ? employeeOf.trim() : null,
                asset_location: assetLocation && assetLocation !== 'N/A' ? assetLocation : null,
                comment: comment && comment !== 'N/A' ? comment : null,
                created_date: createdDateTime || null,
                software_inventory: softwareInventory || null,
                fields: []
              });
            }

            const asset = assetMap.get(assetKey);

            // Add field name/value pair if present
            if (fieldName && fieldValue && fieldValue !== 'N/A') {
              asset.fields.push({
                field_name: fieldName,
                field_value: fieldValue
              });
            }
          })
          .on('end', resolve)
          .on('error', reject);
      });

      // Insert or update consolidated assets and their field values as CIs
      let assetCount = 0;
      let assetUpdated = 0;
      let ciCount = 0;

      for (const [, asset] of assetMap) {
        try {
          // Check if asset already exists (by name and category)
          const [existing] = await connection.query(
            'SELECT id, cmdb_id FROM cmdb_items WHERE asset_name = ? AND asset_category = ?',
            [asset.asset_name, asset.asset_category]
          );

          let cmdbItemId;
          let cmdb_id;

          if (existing.length > 0) {
            // Update existing item
            cmdbItemId = existing[0].id;
            cmdb_id = existing[0].cmdb_id;

            await connection.query(
              `UPDATE cmdb_items SET
                brand_name = COALESCE(?, brand_name),
                model_name = COALESCE(?, model_name),
                customer_name = COALESCE(?, customer_name),
                employee_of = COALESCE(?, employee_of),
                asset_location = COALESCE(?, asset_location),
                comment = COALESCE(?, comment)
              WHERE id = ?`,
              [
                asset.brand_name,
                asset.model_name,
                asset.customer_name,
                asset.employee_of,
                asset.asset_location,
                asset.comment,
                cmdbItemId
              ]
            );

            // Delete existing CIs for this item (will be replaced with new ones)
            await connection.query('DELETE FROM configuration_items WHERE cmdb_item_id = ?', [cmdbItemId]);
            assetUpdated++;
          } else {
            // Insert new CMDB item
            cmdb_id = `CMDB-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            const [result] = await connection.query(
              `INSERT INTO cmdb_items (
                cmdb_id, asset_name, asset_category, category_field_value,
                brand_name, model_name, customer_name, employee_of,
                asset_location, comment, status, created_by
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                cmdb_id,
                asset.asset_name,
                asset.asset_category,
                null,
                asset.brand_name,
                asset.model_name,
                asset.customer_name,
                asset.employee_of,
                asset.asset_location,
                asset.comment,
                'active',
                req.user.userId
              ]
            );

            cmdbItemId = result.insertId;
            assetCount++;
          }

          // Insert each field name/value pair as a Configuration Item
          for (const field of asset.fields) {
            try {
              const ci_id = `CI-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

              await connection.query(
                `INSERT INTO configuration_items (
                  ci_id, cmdb_item_id, ci_name, asset_category, category_field_value,
                  brand_name, model_name, serial_number, asset_location, employee_of,
                  comment, status, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  ci_id,
                  cmdbItemId,
                  field.field_name, // Field name becomes CI name
                  asset.asset_category,
                  field.field_value, // Field value stored in category_field_value
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  'active',
                  req.user.userId
                ]
              );
              ciCount++;
            } catch (ciErr) {
              errors.push({
                asset: asset.asset_name,
                field: field.field_name,
                error: ciErr.message
              });
            }
          }
        } catch (err) {
          errors.push({
            asset: asset.asset_name,
            error: err.message
          });
        }
      }

      res.json({
        success: true,
        message: `Imported ${assetCount} new assets, updated ${assetUpdated} existing assets, with ${ciCount} configuration items`,
        assets_imported: assetCount,
        assets_updated: assetUpdated,
        configuration_items_imported: ciCount,
        total_csv_rows: lineNumber - 1,
        errors: errors.length > 0 ? errors : undefined
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error importing CSV:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

module.exports = router;
