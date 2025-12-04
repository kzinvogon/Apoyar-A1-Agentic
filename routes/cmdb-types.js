const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const {
  validateCmdbItemTypeCreate,
  validateCiTypeCreate
} = require('../middleware/validation');
const {
  writeOperationsLimiter,
  readOperationsLimiter
} = require('../middleware/rateLimiter');

// Apply verifyToken middleware to all routes
router.use(verifyToken);

// Get all CMDB Item Types
router.get('/:tenantId/item-types', readOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);
    
    try {
      const [itemTypes] = await connection.query(
        `SELECT cit.*, 
                (SELECT COUNT(*) FROM ci_types WHERE cmdb_item_type_id = cit.id) as ci_count
         FROM cmdb_item_types cit
         ORDER BY cit.name ASC`
      );
      
      res.json({ success: true, itemTypes });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching item types:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get CI Types for a specific Item Type
router.get('/:tenantId/item-types/:itemTypeId/ci-types', readOperationsLimiter, async (req, res) => {
  try {
    const { tenantId, itemTypeId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);
    
    try {
      const [ciTypes] = await connection.query(
        `SELECT * FROM ci_types 
         WHERE cmdb_item_type_id = ?
         ORDER BY name ASC`,
        [itemTypeId]
      );
      
      res.json({ success: true, ciTypes });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching CI types:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create CMDB Item Type
router.post('/:tenantId/item-types', writeOperationsLimiter, validateCmdbItemTypeCreate, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { name, description } = req.body;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);
    
    try {
      const [result] = await connection.query(
        `INSERT INTO cmdb_item_types (name, description)
         VALUES (?, ?)`,
        [name, description]
      );
      
      res.json({ success: true, itemType: { id: result.insertId, name, description } });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating item type:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create CI Type
router.post('/:tenantId/item-types/:itemTypeId/ci-types', writeOperationsLimiter, validateCiTypeCreate, async (req, res) => {
  try {
    const { tenantId, itemTypeId } = req.params;
    const { name, description } = req.body;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);
    
    try {
      const [result] = await connection.query(
        `INSERT INTO ci_types (cmdb_item_type_id, name, description)
         VALUES (?, ?, ?)`,
        [itemTypeId, name, description]
      );
      
      res.json({ success: true, ciType: { id: result.insertId, name, description } });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating CI type:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
