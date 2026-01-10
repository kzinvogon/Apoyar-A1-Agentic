/**
 * SLA Routes - Business Hours Profiles and SLA Definitions
 * Task 1: CRUD endpoints for SLA data model (admin-only)
 */

const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth');
const { getTenantConnection } = require('../config/database');

// IANA timezone validation (basic check)
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  // Basic IANA format: Region/City or UTC
  return /^[A-Z][a-zA-Z_]+\/[A-Za-z_]+$/.test(tz) || tz === 'UTC';
}

// Time format validation (HH:mm or HH:mm:ss)
function isValidTime(time) {
  if (!time || typeof time !== 'string') return false;
  return /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/.test(time);
}

// Compare times (returns true if start < end)
function isStartBeforeEnd(start, end) {
  const startParts = start.split(':').map(Number);
  const endParts = end.split(':').map(Number);
  const startMinutes = startParts[0] * 60 + startParts[1];
  const endMinutes = endParts[0] * 60 + endParts[1];
  return startMinutes < endMinutes;
}

// ============================================
// BUSINESS HOURS PROFILES
// ============================================

// GET /api/sla/:tenantCode/business-hours - List all business hours profiles
router.get('/:tenantCode/business-hours', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const pool = await getTenantConnection(tenantCode);

    const [profiles] = await pool.query(`
      SELECT id, name, timezone, days_of_week, start_time, end_time, is_24x7, is_active, created_at, updated_at
      FROM business_hours_profiles
      ORDER BY name
    `);

    res.json({ success: true, profiles });
  } catch (error) {
    console.error('Error fetching business hours profiles:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/sla/:tenantCode/business-hours/:id - Get single profile
router.get('/:tenantCode/business-hours/:id', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode, id } = req.params;
    const pool = await getTenantConnection(tenantCode);

    const [profiles] = await pool.query(`
      SELECT id, name, timezone, days_of_week, start_time, end_time, is_24x7, is_active, created_at, updated_at
      FROM business_hours_profiles
      WHERE id = ?
    `, [id]);

    if (profiles.length === 0) {
      return res.status(404).json({ success: false, error: 'Business hours profile not found' });
    }

    res.json({ success: true, profile: profiles[0] });
  } catch (error) {
    console.error('Error fetching business hours profile:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/sla/:tenantCode/business-hours - Create profile
router.post('/:tenantCode/business-hours', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { name, timezone, days_of_week, start_time, end_time, is_24x7 } = req.body;

    // Validation
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    if (!isValidTimezone(timezone)) {
      return res.status(400).json({ success: false, error: 'Invalid timezone format. Use IANA format (e.g., Europe/Madrid, Australia/Sydney)' });
    }

    if (!is_24x7) {
      if (!isValidTime(start_time)) {
        return res.status(400).json({ success: false, error: 'Invalid start_time format. Use HH:mm' });
      }
      if (!isValidTime(end_time)) {
        return res.status(400).json({ success: false, error: 'Invalid end_time format. Use HH:mm' });
      }
      if (!isStartBeforeEnd(start_time, end_time)) {
        return res.status(400).json({ success: false, error: 'start_time must be before end_time' });
      }
    }

    // Validate days_of_week is array of 1-7
    if (days_of_week && !Array.isArray(days_of_week)) {
      return res.status(400).json({ success: false, error: 'days_of_week must be an array' });
    }
    if (days_of_week && !days_of_week.every(d => Number.isInteger(d) && d >= 1 && d <= 7)) {
      return res.status(400).json({ success: false, error: 'days_of_week must contain integers 1-7 (Mon=1, Sun=7)' });
    }

    const pool = await getTenantConnection(tenantCode);

    const [result] = await pool.query(`
      INSERT INTO business_hours_profiles (name, timezone, days_of_week, start_time, end_time, is_24x7)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      name.trim(),
      timezone,
      JSON.stringify(days_of_week || [1, 2, 3, 4, 5]),
      is_24x7 ? '00:00:00' : start_time,
      is_24x7 ? '23:59:59' : end_time,
      is_24x7 ? true : false
    ]);

    res.json({ success: true, id: result.insertId, message: 'Business hours profile created' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'A profile with this name already exists' });
    }
    console.error('Error creating business hours profile:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/sla/:tenantCode/business-hours/:id - Update profile
router.put('/:tenantCode/business-hours/:id', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode, id } = req.params;
    const { name, timezone, days_of_week, start_time, end_time, is_24x7, is_active } = req.body;

    const pool = await getTenantConnection(tenantCode);

    // Check exists
    const [existing] = await pool.query('SELECT id FROM business_hours_profiles WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: 'Business hours profile not found' });
    }

    // Validation
    if (name !== undefined && name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Name cannot be empty' });
    }

    if (timezone !== undefined && !isValidTimezone(timezone)) {
      return res.status(400).json({ success: false, error: 'Invalid timezone format' });
    }

    if (!is_24x7 && start_time !== undefined && end_time !== undefined) {
      if (!isValidTime(start_time) || !isValidTime(end_time)) {
        return res.status(400).json({ success: false, error: 'Invalid time format' });
      }
      if (!isStartBeforeEnd(start_time, end_time)) {
        return res.status(400).json({ success: false, error: 'start_time must be before end_time' });
      }
    }

    // Build update query dynamically
    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name.trim()); }
    if (timezone !== undefined) { updates.push('timezone = ?'); values.push(timezone); }
    if (days_of_week !== undefined) { updates.push('days_of_week = ?'); values.push(JSON.stringify(days_of_week)); }
    if (start_time !== undefined) { updates.push('start_time = ?'); values.push(start_time); }
    if (end_time !== undefined) { updates.push('end_time = ?'); values.push(end_time); }
    if (is_24x7 !== undefined) { updates.push('is_24x7 = ?'); values.push(is_24x7); }
    if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active); }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    values.push(id);
    await pool.query(`UPDATE business_hours_profiles SET ${updates.join(', ')} WHERE id = ?`, values);

    res.json({ success: true, message: 'Business hours profile updated' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'A profile with this name already exists' });
    }
    console.error('Error updating business hours profile:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/sla/:tenantCode/business-hours/:id - Delete profile
router.delete('/:tenantCode/business-hours/:id', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode, id } = req.params;
    const pool = await getTenantConnection(tenantCode);

    // Check if used by any SLA definitions
    const [usedBy] = await pool.query('SELECT COUNT(*) as count FROM sla_definitions WHERE business_hours_profile_id = ?', [id]);
    if (usedBy[0].count > 0) {
      return res.status(400).json({ success: false, error: 'Cannot delete: This profile is used by SLA definitions' });
    }

    const [result] = await pool.query('DELETE FROM business_hours_profiles WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Business hours profile not found' });
    }

    res.json({ success: true, message: 'Business hours profile deleted' });
  } catch (error) {
    console.error('Error deleting business hours profile:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// SLA DEFINITIONS
// ============================================

// GET /api/sla/:tenantCode/definitions - List all SLA definitions
router.get('/:tenantCode/definitions', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const pool = await getTenantConnection(tenantCode);

    const [definitions] = await pool.query(`
      SELECT
        s.id, s.name, s.description, s.business_hours_profile_id,
        s.response_target_minutes, s.resolve_target_minutes,
        s.near_breach_percent, s.past_breach_percent,
        s.is_active, s.created_at, s.updated_at,
        b.name as business_hours_name
      FROM sla_definitions s
      LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
      ORDER BY s.name
    `);

    res.json({ success: true, definitions });
  } catch (error) {
    console.error('Error fetching SLA definitions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/sla/:tenantCode/definitions/:id - Get single SLA definition
router.get('/:tenantCode/definitions/:id', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode, id } = req.params;
    const pool = await getTenantConnection(tenantCode);

    const [definitions] = await pool.query(`
      SELECT
        s.id, s.name, s.description, s.business_hours_profile_id,
        s.response_target_minutes, s.resolve_target_minutes,
        s.near_breach_percent, s.past_breach_percent,
        s.is_active, s.created_at, s.updated_at,
        b.name as business_hours_name
      FROM sla_definitions s
      LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
      WHERE s.id = ?
    `, [id]);

    if (definitions.length === 0) {
      return res.status(404).json({ success: false, error: 'SLA definition not found' });
    }

    res.json({ success: true, definition: definitions[0] });
  } catch (error) {
    console.error('Error fetching SLA definition:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/sla/:tenantCode/definitions - Create SLA definition
router.post('/:tenantCode/definitions', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const {
      name, description, business_hours_profile_id,
      response_target_minutes, resolve_target_minutes,
      near_breach_percent, past_breach_percent
    } = req.body;

    // Validation
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    if (!response_target_minutes || response_target_minutes <= 0) {
      return res.status(400).json({ success: false, error: 'response_target_minutes must be greater than 0' });
    }

    if (!resolve_target_minutes || resolve_target_minutes <= 0) {
      return res.status(400).json({ success: false, error: 'resolve_target_minutes must be greater than 0' });
    }

    if (near_breach_percent !== undefined && (near_breach_percent < 0 || near_breach_percent > 100)) {
      return res.status(400).json({ success: false, error: 'near_breach_percent must be between 0 and 100' });
    }

    if (past_breach_percent !== undefined && past_breach_percent < 100) {
      return res.status(400).json({ success: false, error: 'past_breach_percent must be >= 100' });
    }

    const pool = await getTenantConnection(tenantCode);

    // Verify business hours profile exists if provided
    if (business_hours_profile_id) {
      const [profiles] = await pool.query('SELECT id FROM business_hours_profiles WHERE id = ?', [business_hours_profile_id]);
      if (profiles.length === 0) {
        return res.status(400).json({ success: false, error: 'Business hours profile not found' });
      }
    }

    const [result] = await pool.query(`
      INSERT INTO sla_definitions
        (name, description, business_hours_profile_id, response_target_minutes, resolve_target_minutes, near_breach_percent, past_breach_percent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      name.trim(),
      description || null,
      business_hours_profile_id || null,
      response_target_minutes,
      resolve_target_minutes,
      near_breach_percent || 85,
      past_breach_percent || 120
    ]);

    res.json({ success: true, id: result.insertId, message: 'SLA definition created' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'An SLA definition with this name already exists' });
    }
    console.error('Error creating SLA definition:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/sla/:tenantCode/definitions/:id - Update SLA definition
router.put('/:tenantCode/definitions/:id', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode, id } = req.params;
    const {
      name, description, business_hours_profile_id,
      response_target_minutes, resolve_target_minutes,
      near_breach_percent, past_breach_percent, is_active
    } = req.body;

    const pool = await getTenantConnection(tenantCode);

    // Check exists
    const [existing] = await pool.query('SELECT id FROM sla_definitions WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: 'SLA definition not found' });
    }

    // Validation
    if (name !== undefined && name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Name cannot be empty' });
    }

    if (response_target_minutes !== undefined && response_target_minutes <= 0) {
      return res.status(400).json({ success: false, error: 'response_target_minutes must be > 0' });
    }

    if (resolve_target_minutes !== undefined && resolve_target_minutes <= 0) {
      return res.status(400).json({ success: false, error: 'resolve_target_minutes must be > 0' });
    }

    // Verify business hours profile if changing
    if (business_hours_profile_id !== undefined && business_hours_profile_id !== null) {
      const [profiles] = await pool.query('SELECT id FROM business_hours_profiles WHERE id = ?', [business_hours_profile_id]);
      if (profiles.length === 0) {
        return res.status(400).json({ success: false, error: 'Business hours profile not found' });
      }
    }

    // Build update query
    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name.trim()); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (business_hours_profile_id !== undefined) { updates.push('business_hours_profile_id = ?'); values.push(business_hours_profile_id); }
    if (response_target_minutes !== undefined) { updates.push('response_target_minutes = ?'); values.push(response_target_minutes); }
    if (resolve_target_minutes !== undefined) { updates.push('resolve_target_minutes = ?'); values.push(resolve_target_minutes); }
    if (near_breach_percent !== undefined) { updates.push('near_breach_percent = ?'); values.push(near_breach_percent); }
    if (past_breach_percent !== undefined) { updates.push('past_breach_percent = ?'); values.push(past_breach_percent); }
    if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active); }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    values.push(id);
    await pool.query(`UPDATE sla_definitions SET ${updates.join(', ')} WHERE id = ?`, values);

    res.json({ success: true, message: 'SLA definition updated' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'An SLA definition with this name already exists' });
    }
    console.error('Error updating SLA definition:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/sla/:tenantCode/definitions/:id - Delete SLA definition
router.delete('/:tenantCode/definitions/:id', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode, id } = req.params;
    const pool = await getTenantConnection(tenantCode);

    // TODO: Check if used by any tickets/customer_companies before deletion

    const [result] = await pool.query('DELETE FROM sla_definitions WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'SLA definition not found' });
    }

    res.json({ success: true, message: 'SLA definition deleted' });
  } catch (error) {
    console.error('Error deleting SLA definition:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
