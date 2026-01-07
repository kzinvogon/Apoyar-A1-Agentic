const express = require('express');
const router = express.Router();
const { verifyToken, hashPassword } = require('../middleware/auth');
const { getTenantConnection } = require('../config/database');

// Apply verifyToken middleware to all expert routes
router.use(verifyToken);

// Get all experts for a tenant
router.get('/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      // Get active experts with open ticket count
      const [experts] = await connection.query(
        `SELECT
          u.id, u.username, u.email, u.full_name, u.role, u.is_active,
          u.created_at, u.updated_at,
          COUNT(CASE WHEN t.status IN ('open', 'in_progress', 'paused') THEN 1 END) as open_tickets
         FROM users u
         LEFT JOIN tickets t ON u.id = t.assignee_id
         WHERE u.role IN ('admin', 'expert') AND u.is_active = TRUE
         GROUP BY u.id, u.username, u.email, u.full_name, u.role, u.is_active,
                  u.created_at, u.updated_at
         ORDER BY u.full_name ASC, u.username ASC`
      );

      res.json({ success: true, experts });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching experts:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Get deleted (inactive) experts for a tenant - MUST come before /:tenantId/:expertId
router.get('/:tenantId/deleted', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      const [experts] = await connection.query(
        `SELECT
          u.id, u.username, u.email, u.full_name, u.role, u.is_active,
          u.created_at, u.updated_at
         FROM users u
         WHERE u.role IN ('admin', 'expert') AND u.is_active = FALSE
         ORDER BY u.full_name ASC, u.username ASC`
      );

      res.json({ success: true, experts });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching deleted experts:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Get single expert by ID
router.get('/:tenantId/:expertId', async (req, res) => {
  try {
    const { tenantId, expertId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      // Get expert with open ticket count
      const [experts] = await connection.query(
        `SELECT
          u.id, u.username, u.email, u.full_name, u.role, u.is_active,
          u.created_at, u.updated_at,
          COUNT(CASE WHEN t.status IN ('open', 'in_progress', 'paused') THEN 1 END) as open_tickets
         FROM users u
         LEFT JOIN tickets t ON u.id = t.assignee_id
         WHERE u.id = ? AND u.role IN ('admin', 'expert')
         GROUP BY u.id, u.username, u.email, u.full_name, u.role, u.is_active,
                  u.created_at, u.updated_at`,
        [expertId]
      );

      if (experts.length === 0) {
        return res.status(404).json({ success: false, message: 'Expert not found' });
      }

      res.json({ success: true, expert: experts[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching expert:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Create new expert
router.post('/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const {
      username, email, password, full_name, role, phone, department
    } = req.body;

    // Validate required fields
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username, email, and password are required'
      });
    }

    // Validate role
    if (!role || !['admin', 'expert'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Role must be either "admin" or "expert"'
      });
    }

    const connection = await getTenantConnection(tenantId);

    try {
      // Check if username or email already exists
      const [existing] = await connection.query(
        'SELECT id FROM users WHERE (username = ? OR email = ?)',
        [username, email]
      );

      if (existing.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Username or email already exists'
        });
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Insert new expert
      const [result] = await connection.query(
        `INSERT INTO users (
          username, email, password_hash, full_name, role, phone, department, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
        [username, email, passwordHash, full_name, role, phone, department]
      );

      res.status(201).json({
        success: true,
        message: 'Expert created successfully',
        expertId: result.insertId
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating expert:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Update expert
router.put('/:tenantId/:expertId', async (req, res) => {
  try {
    const { tenantId, expertId } = req.params;
    const {
      username, email, full_name, role, phone, department, is_active, status,
      location, street_address, city, state, postcode, country, timezone, language
    } = req.body;

    const connection = await getTenantConnection(tenantId);

    try {
      // Check if expert exists
      const [existing] = await connection.query(
        'SELECT id FROM users WHERE id = ? AND role IN ("admin", "expert")',
        [expertId]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Expert not found' });
      }

      // Check for duplicate username/email (excluding current expert)
      if (username || email) {
        const [duplicates] = await connection.query(
          'SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?',
          [username, email, expertId]
        );

        if (duplicates.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'Username or email already exists'
          });
        }
      }

      // Build update query dynamically
      const updates = [];
      const values = [];

      if (username !== undefined) { updates.push('username = ?'); values.push(username); }
      if (email !== undefined) { updates.push('email = ?'); values.push(email); }
      if (full_name !== undefined) { updates.push('full_name = ?'); values.push(full_name); }
      if (role !== undefined) { updates.push('role = ?'); values.push(role); }
      if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
      if (department !== undefined) { updates.push('department = ?'); values.push(department); }
      if (location !== undefined) { updates.push('location = ?'); values.push(location); }
      if (street_address !== undefined) { updates.push('street_address = ?'); values.push(street_address); }
      if (city !== undefined) { updates.push('city = ?'); values.push(city); }
      if (state !== undefined) { updates.push('state = ?'); values.push(state); }
      if (postcode !== undefined) { updates.push('postcode = ?'); values.push(postcode); }
      if (country !== undefined) { updates.push('country = ?'); values.push(country); }
      if (timezone !== undefined) { updates.push('timezone = ?'); values.push(timezone); }
      if (language !== undefined) { updates.push('language = ?'); values.push(language); }

      // Handle is_active - accept both is_active boolean and status string
      if (is_active !== undefined) {
        updates.push('is_active = ?');
        values.push(is_active);
      } else if (status !== undefined) {
        // Convert status string to is_active boolean
        const isActiveValue = status === 'active' || status === true;
        updates.push('is_active = ?');
        values.push(isActiveValue);
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      // Add expertId for WHERE clause
      values.push(expertId);

      await connection.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
        values
      );

      res.json({ success: true, message: 'Expert updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating expert:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Restore expert (reactivate)
router.post('/:tenantId/:expertId/restore', async (req, res) => {
  try {
    const { tenantId, expertId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      // Check if expert exists and is inactive
      const [existing] = await connection.query(
        'SELECT id, email, full_name FROM users WHERE id = ? AND role IN ("admin", "expert") AND is_active = FALSE',
        [expertId]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Deleted expert not found' });
      }

      // Reactivate expert
      await connection.query(
        'UPDATE users SET is_active = TRUE WHERE id = ?',
        [expertId]
      );

      console.log(`✅ Restored expert: ${existing[0].email}`);
      res.json({ success: true, message: 'Expert restored successfully', expert: existing[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error restoring expert:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Delete expert (deactivate)
router.delete('/:tenantId/:expertId', async (req, res) => {
  try {
    const { tenantId, expertId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      // Check if expert exists
      const [existing] = await connection.query(
        'SELECT id FROM users WHERE id = ? AND role IN ("admin", "expert")',
        [expertId]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Expert not found' });
      }

      // Deactivate expert
      await connection.query(
        'UPDATE users SET is_active = FALSE WHERE id = ?',
        [expertId]
      );

      res.json({ success: true, message: 'Expert deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting expert:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Permanently erase expert (hard delete) - only for inactive experts
router.delete('/:tenantId/:expertId/erase', async (req, res) => {
  try {
    const { tenantId, expertId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      // Check if expert exists and is inactive
      const [existing] = await connection.query(
        'SELECT id, email, full_name, is_active FROM users WHERE id = ? AND role IN ("admin", "expert")',
        [expertId]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Expert not found' });
      }

      if (existing[0].is_active) {
        return res.status(400).json({
          success: false,
          message: 'Cannot permanently delete an active expert. Deactivate first.'
        });
      }

      // Check for assigned tickets
      const [assignedTickets] = await connection.query(
        'SELECT COUNT(*) as count FROM tickets WHERE assignee_id = ?',
        [expertId]
      );

      if (assignedTickets[0].count > 0) {
        // Unassign tickets before deletion
        await connection.query(
          'UPDATE tickets SET assignee_id = NULL WHERE assignee_id = ?',
          [expertId]
        );
        console.log(`Unassigned ${assignedTickets[0].count} tickets from expert ${expertId}`);
      }

      // Delete related records first (due to foreign keys)
      await connection.query('DELETE FROM expert_ticket_permissions WHERE expert_id = ?', [expertId]);
      await connection.query('DELETE FROM ticket_activity WHERE user_id = ?', [expertId]);

      // Permanently delete the expert
      await connection.query('DELETE FROM users WHERE id = ?', [expertId]);

      console.log(`🗑️ Permanently erased expert: ${existing[0].email} (ID: ${expertId})`);

      res.json({
        success: true,
        message: 'Expert permanently erased',
        erased: {
          id: expertId,
          email: existing[0].email,
          fullName: existing[0].full_name
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error permanently erasing expert:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

module.exports = router;
