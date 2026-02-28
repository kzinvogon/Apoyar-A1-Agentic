/**
 * CMDB Relationships Routes
 * Manages relationships and dependencies between CMDB items
 */

const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { applyTenantMatch } = require('../middleware/tenantMatch');
const { logCMDBChange, getClientIP } = require('../utils/cmdb-helpers');

// Apply authentication to all routes
router.use(verifyToken);
applyTenantMatch(router);

// Relationship type labels for display
const RELATIONSHIP_LABELS = {
  depends_on: 'Depends On',
  hosts: 'Hosts',
  connects_to: 'Connects To',
  part_of: 'Part Of',
  uses: 'Uses',
  provides: 'Provides',
  backs_up: 'Backs Up',
  monitors: 'Monitors'
};

// Inverse relationship types for bidirectional display
const INVERSE_RELATIONSHIPS = {
  depends_on: 'depended_by',
  hosts: 'hosted_by',
  connects_to: 'connected_from',
  part_of: 'contains',
  uses: 'used_by',
  provides: 'provided_to',
  backs_up: 'backed_up_by',
  monitors: 'monitored_by'
};

// ============================================================================
// RELATIONSHIPS CRUD
// ============================================================================

/**
 * GET /:tenantCode/items/:cmdbId/relationships
 * Get all relationships for a CMDB item (both directions)
 */
router.get('/:tenantCode/items/:cmdbId/relationships', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get the CMDB item
      const [items] = await connection.query(
        'SELECT id, cmdb_id, asset_name FROM cmdb_items WHERE cmdb_id = ?',
        [cmdbId]
      );

      if (items.length === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      const item = items[0];

      // Get outgoing relationships (this item is source)
      const [outgoing] = await connection.query(
        `SELECT r.*,
                cm.cmdb_id as target_cmdb_id_str,
                cm.asset_name as target_asset_name,
                cm.asset_category as target_asset_category,
                cm.status as target_status,
                u.full_name as created_by_name
         FROM cmdb_relationships r
         JOIN cmdb_items cm ON r.target_cmdb_id = cm.id
         LEFT JOIN users u ON r.created_by = u.id
         WHERE r.source_cmdb_id = ? AND r.is_active = TRUE
         ORDER BY r.relationship_type, cm.asset_name`,
        [item.id]
      );

      // Get incoming relationships (this item is target)
      const [incoming] = await connection.query(
        `SELECT r.*,
                cm.cmdb_id as source_cmdb_id_str,
                cm.asset_name as source_asset_name,
                cm.asset_category as source_asset_category,
                cm.status as source_status,
                u.full_name as created_by_name
         FROM cmdb_relationships r
         JOIN cmdb_items cm ON r.source_cmdb_id = cm.id
         LEFT JOIN users u ON r.created_by = u.id
         WHERE r.target_cmdb_id = ? AND r.is_active = TRUE
         ORDER BY r.relationship_type, cm.asset_name`,
        [item.id]
      );

      // Format outgoing relationships
      const outgoingFormatted = outgoing.map(r => ({
        id: r.id,
        direction: 'outgoing',
        relationship_type: r.relationship_type,
        relationship_label: RELATIONSHIP_LABELS[r.relationship_type] || r.relationship_type,
        related_item: {
          id: r.target_cmdb_id,
          cmdb_id: r.target_cmdb_id_str,
          asset_name: r.target_asset_name,
          asset_category: r.target_asset_category,
          status: r.target_status
        },
        description: r.description,
        created_by_name: r.created_by_name,
        created_at: r.created_at
      }));

      // Format incoming relationships
      const incomingFormatted = incoming.map(r => ({
        id: r.id,
        direction: 'incoming',
        relationship_type: r.relationship_type,
        inverse_type: INVERSE_RELATIONSHIPS[r.relationship_type] || r.relationship_type,
        relationship_label: RELATIONSHIP_LABELS[r.relationship_type] || r.relationship_type,
        related_item: {
          id: r.source_cmdb_id,
          cmdb_id: r.source_cmdb_id_str,
          asset_name: r.source_asset_name,
          asset_category: r.source_asset_category,
          status: r.source_status
        },
        description: r.description,
        created_by_name: r.created_by_name,
        created_at: r.created_at
      }));

      res.json({
        success: true,
        outgoing: outgoingFormatted,
        incoming: incomingFormatted,
        total: outgoingFormatted.length + incomingFormatted.length,
        relationship_types: Object.entries(RELATIONSHIP_LABELS).map(([value, label]) => ({ value, label }))
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching relationships:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * POST /:tenantCode/relationships
 * Create a new relationship between CMDB items
 */
router.post('/:tenantCode/relationships', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const {
      source_cmdb_id, // cmdb_id string (e.g., "CMDB-123...")
      target_cmdb_id, // cmdb_id string
      relationship_type,
      description
    } = req.body;

    // Validation
    if (!source_cmdb_id || !target_cmdb_id || !relationship_type) {
      return res.status(400).json({
        success: false,
        message: 'source_cmdb_id, target_cmdb_id, and relationship_type are required'
      });
    }

    // Validate relationship type
    if (!RELATIONSHIP_LABELS[relationship_type]) {
      return res.status(400).json({
        success: false,
        message: `Invalid relationship_type. Must be one of: ${Object.keys(RELATIONSHIP_LABELS).join(', ')}`
      });
    }

    // Can't create relationship to self
    if (source_cmdb_id === target_cmdb_id) {
      return res.status(400).json({
        success: false,
        message: 'Cannot create a relationship to the same item'
      });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      // Get source item
      const [sourceItems] = await connection.query(
        'SELECT id, cmdb_id, asset_name FROM cmdb_items WHERE cmdb_id = ?',
        [source_cmdb_id]
      );

      if (sourceItems.length === 0) {
        return res.status(404).json({ success: false, message: 'Source CMDB item not found' });
      }

      // Get target item
      const [targetItems] = await connection.query(
        'SELECT id, cmdb_id, asset_name FROM cmdb_items WHERE cmdb_id = ?',
        [target_cmdb_id]
      );

      if (targetItems.length === 0) {
        return res.status(404).json({ success: false, message: 'Target CMDB item not found' });
      }

      const sourceItem = sourceItems[0];
      const targetItem = targetItems[0];

      // Create the relationship
      const [result] = await connection.query(
        `INSERT INTO cmdb_relationships
          (source_cmdb_id, target_cmdb_id, relationship_type, description, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [sourceItem.id, targetItem.id, relationship_type, description, req.user.userId]
      );

      // Log the change for source item
      await logCMDBChange(connection, {
        cmdbItemId: sourceItem.id,
        changeType: 'relationship_added',
        fieldName: relationship_type,
        newValue: `${targetItem.asset_name} (${targetItem.cmdb_id})`,
        userId: req.user.userId,
        userName: req.user.fullName || req.user.username,
        ipAddress: getClientIP(req)
      });

      // Log the change for target item (inverse)
      await logCMDBChange(connection, {
        cmdbItemId: targetItem.id,
        changeType: 'relationship_added',
        fieldName: INVERSE_RELATIONSHIPS[relationship_type] || relationship_type,
        newValue: `${sourceItem.asset_name} (${sourceItem.cmdb_id})`,
        userId: req.user.userId,
        userName: req.user.fullName || req.user.username,
        ipAddress: getClientIP(req)
      });

      // Fetch the created relationship
      const [relationships] = await connection.query(
        `SELECT r.*,
                sm.cmdb_id as source_cmdb_id_str, sm.asset_name as source_asset_name,
                tm.cmdb_id as target_cmdb_id_str, tm.asset_name as target_asset_name
         FROM cmdb_relationships r
         JOIN cmdb_items sm ON r.source_cmdb_id = sm.id
         JOIN cmdb_items tm ON r.target_cmdb_id = tm.id
         WHERE r.id = ?`,
        [result.insertId]
      );

      res.json({
        success: true,
        message: 'Relationship created successfully',
        relationship: relationships[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({
        success: false,
        message: 'This relationship already exists'
      });
    }
    console.error('Error creating relationship:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * DELETE /:tenantCode/relationships/:id
 * Delete (deactivate) a relationship
 */
router.delete('/:tenantCode/relationships/:id', async (req, res) => {
  try {
    const { tenantCode, id } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get relationship details for logging
      const [relationships] = await connection.query(
        `SELECT r.*,
                sm.cmdb_id as source_cmdb_id_str, sm.asset_name as source_asset_name,
                tm.cmdb_id as target_cmdb_id_str, tm.asset_name as target_asset_name
         FROM cmdb_relationships r
         JOIN cmdb_items sm ON r.source_cmdb_id = sm.id
         JOIN cmdb_items tm ON r.target_cmdb_id = tm.id
         WHERE r.id = ?`,
        [id]
      );

      if (relationships.length === 0) {
        return res.status(404).json({ success: false, message: 'Relationship not found' });
      }

      const rel = relationships[0];

      // Soft delete - set is_active to false
      const [result] = await connection.query(
        'UPDATE cmdb_relationships SET is_active = FALSE WHERE id = ?',
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Relationship not found' });
      }

      // Log the change for source item
      await logCMDBChange(connection, {
        cmdbItemId: rel.source_cmdb_id,
        changeType: 'relationship_removed',
        fieldName: rel.relationship_type,
        oldValue: `${rel.target_asset_name} (${rel.target_cmdb_id_str})`,
        userId: req.user.userId,
        userName: req.user.fullName || req.user.username,
        ipAddress: getClientIP(req)
      });

      // Log the change for target item
      await logCMDBChange(connection, {
        cmdbItemId: rel.target_cmdb_id,
        changeType: 'relationship_removed',
        fieldName: INVERSE_RELATIONSHIPS[rel.relationship_type] || rel.relationship_type,
        oldValue: `${rel.source_asset_name} (${rel.source_cmdb_id_str})`,
        userId: req.user.userId,
        userName: req.user.fullName || req.user.username,
        ipAddress: getClientIP(req)
      });

      res.json({ success: true, message: 'Relationship deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting relationship:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ============================================================================
// IMPACT ANALYSIS
// ============================================================================

/**
 * GET /:tenantCode/items/:cmdbId/impact-analysis
 * Get downstream impact tree for a CMDB item
 * Shows all items that depend on this item (directly or indirectly)
 */
router.get('/:tenantCode/items/:cmdbId/impact-analysis', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const { depth = 3 } = req.query; // Max depth to traverse
    const maxDepth = Math.min(parseInt(depth) || 3, 10); // Cap at 10 levels

    const connection = await getTenantConnection(tenantCode);

    try {
      // Get the root CMDB item
      const [items] = await connection.query(
        'SELECT id, cmdb_id, asset_name, asset_category, status FROM cmdb_items WHERE cmdb_id = ?',
        [cmdbId]
      );

      if (items.length === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      const rootItem = items[0];
      const visited = new Set();
      const impactTree = await buildImpactTree(connection, rootItem, 0, maxDepth, visited);

      // Calculate summary statistics
      const allImpactedItems = [];
      const collectItems = (node, level = 0) => {
        if (level > 0) {
          allImpactedItems.push({
            id: node.id,
            cmdb_id: node.cmdb_id,
            asset_name: node.asset_name,
            asset_category: node.asset_category,
            status: node.status,
            impact_level: level,
            relationship_type: node.relationship_type
          });
        }
        if (node.children) {
          node.children.forEach(child => collectItems(child, level + 1));
        }
      };
      collectItems(impactTree);

      // Group by category
      const byCategory = {};
      allImpactedItems.forEach(item => {
        if (!byCategory[item.asset_category]) {
          byCategory[item.asset_category] = [];
        }
        byCategory[item.asset_category].push(item);
      });

      res.json({
        success: true,
        root: {
          id: rootItem.id,
          cmdb_id: rootItem.cmdb_id,
          asset_name: rootItem.asset_name,
          asset_category: rootItem.asset_category,
          status: rootItem.status
        },
        impact_tree: impactTree,
        summary: {
          total_impacted: allImpactedItems.length,
          max_depth_reached: maxDepth,
          by_category: Object.entries(byCategory).map(([category, items]) => ({
            category,
            count: items.length
          })),
          by_level: Array.from({ length: maxDepth }, (_, i) => ({
            level: i + 1,
            count: allImpactedItems.filter(item => item.impact_level === i + 1).length
          })).filter(l => l.count > 0)
        },
        impacted_items: allImpactedItems
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error performing impact analysis:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * Recursively build impact tree
 * Finds items that depend_on the current item
 */
async function buildImpactTree(connection, item, currentDepth, maxDepth, visited) {
  const node = {
    id: item.id,
    cmdb_id: item.cmdb_id,
    asset_name: item.asset_name,
    asset_category: item.asset_category,
    status: item.status,
    relationship_type: item.relationship_type || null,
    children: []
  };

  // Prevent infinite loops
  if (visited.has(item.id)) {
    node.circular_reference = true;
    return node;
  }

  visited.add(item.id);

  // Stop if max depth reached
  if (currentDepth >= maxDepth) {
    return node;
  }

  // Find items that depend on this item
  // depends_on means: source depends on target
  // So we look for relationships where this item is the TARGET
  const [dependents] = await connection.query(
    `SELECT cm.id, cm.cmdb_id, cm.asset_name, cm.asset_category, cm.status,
            r.relationship_type
     FROM cmdb_relationships r
     JOIN cmdb_items cm ON r.source_cmdb_id = cm.id
     WHERE r.target_cmdb_id = ?
       AND r.is_active = TRUE
       AND r.relationship_type IN ('depends_on', 'uses', 'hosted_by')
     ORDER BY cm.asset_name`,
    [item.id]
  );

  // Recursively build children
  for (const dependent of dependents) {
    const childNode = await buildImpactTree(connection, dependent, currentDepth + 1, maxDepth, visited);
    node.children.push(childNode);
  }

  return node;
}

/**
 * GET /:tenantCode/items/:cmdbId/dependency-tree
 * Get upstream dependency tree for a CMDB item
 * Shows all items that this item depends on (directly or indirectly)
 */
router.get('/:tenantCode/items/:cmdbId/dependency-tree', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const { depth = 3 } = req.query;
    const maxDepth = Math.min(parseInt(depth) || 3, 10);

    const connection = await getTenantConnection(tenantCode);

    try {
      const [items] = await connection.query(
        'SELECT id, cmdb_id, asset_name, asset_category, status FROM cmdb_items WHERE cmdb_id = ?',
        [cmdbId]
      );

      if (items.length === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      const rootItem = items[0];
      const visited = new Set();
      const dependencyTree = await buildDependencyTree(connection, rootItem, 0, maxDepth, visited);

      // Calculate summary
      const allDependencies = [];
      const collectItems = (node, level = 0) => {
        if (level > 0) {
          allDependencies.push({
            id: node.id,
            cmdb_id: node.cmdb_id,
            asset_name: node.asset_name,
            asset_category: node.asset_category,
            status: node.status,
            dependency_level: level,
            relationship_type: node.relationship_type
          });
        }
        if (node.children) {
          node.children.forEach(child => collectItems(child, level + 1));
        }
      };
      collectItems(dependencyTree);

      res.json({
        success: true,
        root: {
          id: rootItem.id,
          cmdb_id: rootItem.cmdb_id,
          asset_name: rootItem.asset_name,
          asset_category: rootItem.asset_category,
          status: rootItem.status
        },
        dependency_tree: dependencyTree,
        summary: {
          total_dependencies: allDependencies.length,
          max_depth_reached: maxDepth
        },
        dependencies: allDependencies
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error building dependency tree:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * Recursively build dependency tree
 * Finds items that this item depends_on
 */
async function buildDependencyTree(connection, item, currentDepth, maxDepth, visited) {
  const node = {
    id: item.id,
    cmdb_id: item.cmdb_id,
    asset_name: item.asset_name,
    asset_category: item.asset_category,
    status: item.status,
    relationship_type: item.relationship_type || null,
    children: []
  };

  if (visited.has(item.id)) {
    node.circular_reference = true;
    return node;
  }

  visited.add(item.id);

  if (currentDepth >= maxDepth) {
    return node;
  }

  // Find items that this item depends on
  // depends_on means: source depends on target
  // So we look for relationships where this item is the SOURCE
  const [dependencies] = await connection.query(
    `SELECT cm.id, cm.cmdb_id, cm.asset_name, cm.asset_category, cm.status,
            r.relationship_type
     FROM cmdb_relationships r
     JOIN cmdb_items cm ON r.target_cmdb_id = cm.id
     WHERE r.source_cmdb_id = ?
       AND r.is_active = TRUE
       AND r.relationship_type IN ('depends_on', 'uses', 'hosted_by')
     ORDER BY cm.asset_name`,
    [item.id]
  );

  for (const dependency of dependencies) {
    const childNode = await buildDependencyTree(connection, dependency, currentDepth + 1, maxDepth, visited);
    node.children.push(childNode);
  }

  return node;
}

module.exports = router;
