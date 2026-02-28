/**
 * CMDB Custom Fields Routes
 * Manages custom field definitions and values for CMDB items
 */

const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { applyTenantMatch } = require('../middleware/tenantMatch');
const { logCMDBChange, getClientIP, requireAdmin } = require('../utils/cmdb-helpers');

// Apply authentication to all routes
router.use(verifyToken);
applyTenantMatch(router);

// ============================================================================
// CUSTOM FIELD DEFINITIONS
// ============================================================================

/**
 * GET /:tenantCode/custom-fields
 * List all custom field definitions
 */
router.get('/:tenantCode/custom-fields', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { category } = req.query;
    const connection = await getTenantConnection(tenantCode);

    try {
      let query = `
        SELECT * FROM cmdb_custom_field_definitions
        WHERE is_active = TRUE
      `;
      const params = [];

      if (category) {
        query += ' AND asset_category = ?';
        params.push(category);
      }

      query += ' ORDER BY asset_category, display_order, field_name';

      const [fields] = await connection.query(query, params);

      // Parse dropdown_options JSON
      const parsedFields = fields.map(field => ({
        ...field,
        dropdown_options: field.dropdown_options ? JSON.parse(field.dropdown_options) : null
      }));

      res.json({ success: true, fields: parsedFields });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching custom field definitions:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /:tenantCode/custom-fields/:category
 * Get custom fields for a specific asset category
 */
router.get('/:tenantCode/custom-fields/:category', async (req, res) => {
  try {
    const { tenantCode, category } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      const [fields] = await connection.query(
        `SELECT * FROM cmdb_custom_field_definitions
         WHERE asset_category = ? AND is_active = TRUE
         ORDER BY display_order, field_name`,
        [category]
      );

      // Parse dropdown_options JSON
      const parsedFields = fields.map(field => ({
        ...field,
        dropdown_options: field.dropdown_options ? JSON.parse(field.dropdown_options) : null
      }));

      res.json({ success: true, fields: parsedFields });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching custom fields for category:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * POST /:tenantCode/custom-fields
 * Create a new custom field definition (Admin only)
 */
router.post('/:tenantCode/custom-fields', requireAdmin, async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const {
      asset_category,
      field_name,
      field_label,
      field_type = 'text',
      dropdown_options,
      is_required = false,
      display_order = 0
    } = req.body;

    // Validation
    if (!asset_category || !field_name || !field_label) {
      return res.status(400).json({
        success: false,
        message: 'asset_category, field_name, and field_label are required'
      });
    }

    // Validate field_type
    const validTypes = ['text', 'number', 'date', 'dropdown', 'boolean', 'url'];
    if (!validTypes.includes(field_type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid field_type. Must be one of: ${validTypes.join(', ')}`
      });
    }

    // If dropdown type, validate options
    if (field_type === 'dropdown') {
      if (!dropdown_options || !Array.isArray(dropdown_options) || dropdown_options.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'dropdown_options array is required for dropdown field type'
        });
      }
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      const [result] = await connection.query(
        `INSERT INTO cmdb_custom_field_definitions
          (asset_category, field_name, field_label, field_type, dropdown_options, is_required, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          asset_category,
          field_name,
          field_label,
          field_type,
          dropdown_options ? JSON.stringify(dropdown_options) : null,
          is_required,
          display_order
        ]
      );

      const [fields] = await connection.query(
        'SELECT * FROM cmdb_custom_field_definitions WHERE id = ?',
        [result.insertId]
      );

      const field = {
        ...fields[0],
        dropdown_options: fields[0].dropdown_options ? JSON.parse(fields[0].dropdown_options) : null
      };

      res.json({ success: true, message: 'Custom field created successfully', field });
    } finally {
      connection.release();
    }
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({
        success: false,
        message: 'A field with this name already exists for this category'
      });
    }
    console.error('Error creating custom field definition:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * PUT /:tenantCode/custom-fields/:id
 * Update a custom field definition (Admin only)
 */
router.put('/:tenantCode/custom-fields/:id', requireAdmin, async (req, res) => {
  try {
    const { tenantCode, id } = req.params;
    const {
      field_label,
      field_type,
      dropdown_options,
      is_required,
      display_order,
      is_active
    } = req.body;

    const connection = await getTenantConnection(tenantCode);

    try {
      // Build dynamic update query
      const updates = [];
      const params = [];

      if (field_label !== undefined) {
        updates.push('field_label = ?');
        params.push(field_label);
      }
      if (field_type !== undefined) {
        updates.push('field_type = ?');
        params.push(field_type);
      }
      if (dropdown_options !== undefined) {
        updates.push('dropdown_options = ?');
        params.push(dropdown_options ? JSON.stringify(dropdown_options) : null);
      }
      if (is_required !== undefined) {
        updates.push('is_required = ?');
        params.push(is_required);
      }
      if (display_order !== undefined) {
        updates.push('display_order = ?');
        params.push(display_order);
      }
      if (is_active !== undefined) {
        updates.push('is_active = ?');
        params.push(is_active);
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      params.push(id);

      const [result] = await connection.query(
        `UPDATE cmdb_custom_field_definitions SET ${updates.join(', ')} WHERE id = ?`,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Custom field not found' });
      }

      const [fields] = await connection.query(
        'SELECT * FROM cmdb_custom_field_definitions WHERE id = ?',
        [id]
      );

      const field = {
        ...fields[0],
        dropdown_options: fields[0].dropdown_options ? JSON.parse(fields[0].dropdown_options) : null
      };

      res.json({ success: true, message: 'Custom field updated successfully', field });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating custom field definition:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * DELETE /:tenantCode/custom-fields/:id
 * Soft delete a custom field definition (Admin only)
 */
router.delete('/:tenantCode/custom-fields/:id', requireAdmin, async (req, res) => {
  try {
    const { tenantCode, id } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      // Soft delete - set is_active to false
      const [result] = await connection.query(
        'UPDATE cmdb_custom_field_definitions SET is_active = FALSE WHERE id = ?',
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Custom field not found' });
      }

      res.json({ success: true, message: 'Custom field deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting custom field definition:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * PUT /:tenantCode/custom-fields/reorder
 * Reorder custom fields for a category (Admin only)
 */
router.put('/:tenantCode/custom-fields-reorder', requireAdmin, async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { field_orders } = req.body; // Array of { id, display_order }

    if (!field_orders || !Array.isArray(field_orders)) {
      return res.status(400).json({
        success: false,
        message: 'field_orders array is required'
      });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      for (const { id, display_order } of field_orders) {
        await connection.query(
          'UPDATE cmdb_custom_field_definitions SET display_order = ? WHERE id = ?',
          [display_order, id]
        );
      }

      res.json({ success: true, message: 'Field order updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error reordering custom fields:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ============================================================================
// CUSTOM FIELD VALUES
// ============================================================================

/**
 * GET /:tenantCode/items/:cmdbId/custom-values
 * Get custom field values for a specific CMDB item
 */
router.get('/:tenantCode/items/:cmdbId/custom-values', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get the CMDB item to find its category and internal ID
      const [items] = await connection.query(
        'SELECT id, asset_category FROM cmdb_items WHERE cmdb_id = ?',
        [cmdbId]
      );

      if (items.length === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      const item = items[0];

      // Get all active field definitions for this category
      const [definitions] = await connection.query(
        `SELECT * FROM cmdb_custom_field_definitions
         WHERE asset_category = ? AND is_active = TRUE
         ORDER BY display_order, field_name`,
        [item.asset_category]
      );

      // Get existing values for this item
      const [values] = await connection.query(
        `SELECT cfv.*, cfd.field_name, cfd.field_label, cfd.field_type, cfd.dropdown_options, cfd.is_required
         FROM cmdb_custom_field_values cfv
         JOIN cmdb_custom_field_definitions cfd ON cfv.field_definition_id = cfd.id
         WHERE cfv.cmdb_item_id = ? AND cfd.is_active = TRUE`,
        [item.id]
      );

      // Create a map of existing values
      const valueMap = {};
      values.forEach(v => {
        valueMap[v.field_definition_id] = v.field_value;
      });

      // Merge definitions with values
      const fields = definitions.map(def => ({
        id: def.id,
        field_name: def.field_name,
        field_label: def.field_label,
        field_type: def.field_type,
        dropdown_options: def.dropdown_options ? JSON.parse(def.dropdown_options) : null,
        is_required: def.is_required,
        display_order: def.display_order,
        value: valueMap[def.id] || null
      }));

      res.json({ success: true, fields });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching custom field values:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * PUT /:tenantCode/items/:cmdbId/custom-values
 * Update custom field values for a CMDB item
 */
router.put('/:tenantCode/items/:cmdbId/custom-values', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const { values } = req.body; // Array of { field_definition_id, value }

    if (!values || !Array.isArray(values)) {
      return res.status(400).json({
        success: false,
        message: 'values array is required'
      });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      // Get the CMDB item
      const [items] = await connection.query(
        'SELECT id, asset_category FROM cmdb_items WHERE cmdb_id = ?',
        [cmdbId]
      );

      if (items.length === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      const item = items[0];

      // Process each value
      for (const { field_definition_id, value } of values) {
        // Get the field definition to verify it belongs to the correct category
        const [defs] = await connection.query(
          'SELECT * FROM cmdb_custom_field_definitions WHERE id = ? AND asset_category = ?',
          [field_definition_id, item.asset_category]
        );

        if (defs.length === 0) {
          continue; // Skip invalid field definitions
        }

        const def = defs[0];

        // Get current value for change logging
        const [currentValues] = await connection.query(
          'SELECT field_value FROM cmdb_custom_field_values WHERE cmdb_item_id = ? AND field_definition_id = ?',
          [item.id, field_definition_id]
        );
        const oldValue = currentValues.length > 0 ? currentValues[0].field_value : null;

        // Upsert the value
        if (value === null || value === '' || value === undefined) {
          // Delete the value if empty
          await connection.query(
            'DELETE FROM cmdb_custom_field_values WHERE cmdb_item_id = ? AND field_definition_id = ?',
            [item.id, field_definition_id]
          );
        } else {
          await connection.query(
            `INSERT INTO cmdb_custom_field_values (cmdb_item_id, field_definition_id, field_value)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE field_value = VALUES(field_value)`,
            [item.id, field_definition_id, value]
          );
        }

        // Log the change if value changed
        if (oldValue !== value) {
          await logCMDBChange(connection, {
            cmdbItemId: item.id,
            changeType: 'custom_field_updated',
            fieldName: def.field_name,
            oldValue: oldValue,
            newValue: value || null,
            userId: req.user.userId,
            userName: req.user.fullName || req.user.username,
            ipAddress: getClientIP(req)
          });
        }
      }

      res.json({ success: true, message: 'Custom field values updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating custom field values:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
