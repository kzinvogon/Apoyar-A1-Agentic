const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { applyTenantMatch } = require('../middleware/tenantMatch');
const {
  writeOperationsLimiter,
  readOperationsLimiter
} = require('../middleware/rateLimiter');

// Apply verifyToken middleware to all routes
router.use(verifyToken);
applyTenantMatch(router);

// Get all asset categories
router.get('/:tenantId/categories', readOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [categories] = await connection.query(
        `SELECT id, name, description, is_active, created_at, updated_at
         FROM asset_categories
         ORDER BY name ASC`
      );

      res.json({ success: true, categories });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching asset categories:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create asset category
router.post('/:tenantId/categories', writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { name, description } = req.body;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ success: false, message: 'Name must not exceed 100 characters' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      const [result] = await connection.query(
        `INSERT INTO asset_categories (name, description) VALUES (?, ?)`,
        [name.trim(), description ? description.trim() : null]
      );

      res.json({ success: true, category: { id: result.insertId, name: name.trim(), description: description || null } });
    } finally {
      connection.release();
    }
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'A category with that name already exists' });
    }
    console.error('Error creating asset category:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update asset category
router.put('/:tenantId/categories/:id', writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantId, id } = req.params;
    const { name, description, is_active } = req.body;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      const updates = ['name = ?', 'description = ?'];
      const params = [name.trim(), description ? description.trim() : null];

      if (typeof is_active === 'boolean' || is_active === 0 || is_active === 1) {
        updates.push('is_active = ?');
        params.push(is_active ? 1 : 0);
      }

      params.push(id);

      const [result] = await connection.query(
        `UPDATE asset_categories SET ${updates.join(', ')} WHERE id = ?`,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Category not found' });
      }

      res.json({ success: true, message: 'Category updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'A category with that name already exists' });
    }
    console.error('Error updating asset category:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Soft-delete asset category (set is_active=false)
router.delete('/:tenantId/categories/:id', writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantId, id } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [result] = await connection.query(
        `UPDATE asset_categories SET is_active = FALSE WHERE id = ?`,
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Category not found' });
      }

      res.json({ success: true, message: 'Category deactivated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting asset category:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
