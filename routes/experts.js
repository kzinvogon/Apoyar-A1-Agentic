const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { verifyToken, hashPassword } = require('../middleware/auth');
const { getTenantConnection, getMasterConnection } = require('../config/database');
const { sendEmail } = require('../config/email');

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

      // Reactivate expert - clear deleted_at and deleted_by
      await connection.query(
        'UPDATE users SET is_active = TRUE, deleted_at = NULL, deleted_by = NULL WHERE id = ?',
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
    const deletedBy = req.user?.userId || null;
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

      // Soft delete expert - set is_active = FALSE and deleted_at timestamp
      await connection.query(
        'UPDATE users SET is_active = FALSE, deleted_at = NOW(), deleted_by = ? WHERE id = ?',
        [deletedBy, expertId]
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

// Invite expert - send invitation email
router.post('/:tenantId/invite', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { salutation, first_name, last_name, email } = req.body;

    // Validate required fields
    if (!email || !first_name || !last_name) {
      return res.status(400).json({
        success: false,
        message: 'Email, first name, and last name are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email address format'
      });
    }

    const connection = await getTenantConnection(tenantId);

    try {
      // Check if email already exists
      const [existing] = await connection.query(
        'SELECT id, is_active, deleted_at, full_name FROM users WHERE email = ?',
        [email]
      );

      if (existing.length > 0) {
        const existingUser = existing[0];

        // If user is active (not deleted), reject
        if (!existingUser.deleted_at) {
          return res.status(409).json({
            success: false,
            message: 'An account with this email already exists'
          });
        }

        // User was soft-deleted - offer to reactivate
        return res.status(409).json({
          success: false,
          message: `This email belongs to a deleted expert (${existingUser.full_name}). Please restore them from the deleted experts list or permanently erase them first.`,
          deletedExpert: {
            id: existingUser.id,
            name: existingUser.full_name
          }
        });
      }

      // Generate invitation token
      const invitationToken = crypto.randomBytes(32).toString('hex');
      const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      // Create full name
      const fullName = salutation
        ? `${salutation} ${first_name} ${last_name}`
        : `${first_name} ${last_name}`;

      // Insert new expert with pending status (no password yet)
      const [result] = await connection.query(
        `INSERT INTO users (
          username, email, password_hash, full_name, role, is_active,
          invitation_token, invitation_expires, invitation_sent_at
        ) VALUES (?, ?, '', ?, 'expert', FALSE, ?, ?, NOW())`,
        [email, email, fullName, invitationToken, tokenExpiry]
      );

      const expertId = result.insertId;

      // Get tenant company name
      let tenantName = tenantId;
      try {
        const masterConn = await getMasterConnection();
        const [tenantInfo] = await masterConn.query(
          'SELECT company_name FROM tenants WHERE tenant_code = ?',
          [tenantId]
        );
        masterConn.release();
        if (tenantInfo.length > 0 && tenantInfo[0].company_name) {
          tenantName = tenantInfo[0].company_name;
        }
      } catch (e) {
        console.log('Could not fetch tenant name:', e.message);
      }

      // Build invitation URL
      const baseUrl = process.env.BASE_URL || 'https://serviflow.app';
      const invitationUrl = `${baseUrl}/accept-invite?token=${invitationToken}&tenant=${tenantId}`;

      // Send invitation email
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f8f9fa; border-radius: 8px;">
          <div style="background: #003366; color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">You're Invited!</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 8px 8px;">
            <p style="font-size: 16px; color: #333;">Dear ${salutation ? salutation + ' ' : ''}${first_name} ${last_name},</p>

            <p style="font-size: 16px; color: #333; line-height: 1.6;">
              You have been invited to join the expert pool of <strong>${tenantName}'s</strong> ServiFlow Support Platform.
            </p>

            <p style="font-size: 16px; color: #333; line-height: 1.6;">
              As an expert, you'll be able to manage support tickets, help customers, and collaborate with the team.
            </p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${invitationUrl}"
                 style="display: inline-block; background: #003366; color: white; padding: 14px 32px;
                        text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: bold;">
                Accept Invitation & Set Password
              </a>
            </div>

            <p style="font-size: 14px; color: #666; line-height: 1.6;">
              This invitation link will expire in 7 days. If the button above doesn't work,
              copy and paste this link into your browser:
            </p>
            <p style="font-size: 12px; color: #888; word-break: break-all; background: #f5f5f5; padding: 10px; border-radius: 4px;">
              ${invitationUrl}
            </p>

            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">

            <p style="font-size: 12px; color: #999; text-align: center;">
              If you did not expect this invitation, please ignore this email.
            </p>
          </div>
        </div>
      `;

      const emailResult = await sendEmail(tenantId, {
        to: email,
        subject: `You're invited to join ${tenantName}'s ServiFlow Support Team`,
        html: emailHtml,
        emailType: 'experts',
        skipUserCheck: true // New user doesn't have account yet
      });

      if (!emailResult.success) {
        // Still created the user, but email failed
        console.log('⚠️ Expert created but invitation email failed:', emailResult.message);
        return res.status(201).json({
          success: true,
          message: 'Expert created but invitation email could not be sent. Please try resending.',
          expertId,
          emailSent: false,
          emailError: emailResult.message
        });
      }

      console.log(`✉️ Invitation sent to ${email} for tenant ${tenantId}`);

      res.status(201).json({
        success: true,
        message: 'Invitation sent successfully',
        expertId,
        emailSent: true
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error inviting expert:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Resend invitation email
router.post('/:tenantId/:expertId/resend-invite', async (req, res) => {
  try {
    const { tenantId, expertId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      // Get expert with pending invitation
      const [experts] = await connection.query(
        `SELECT id, email, full_name, invitation_token, invitation_expires
         FROM users WHERE id = ? AND role IN ('admin', 'expert') AND is_active = FALSE`,
        [expertId]
      );

      if (experts.length === 0) {
        return res.status(404).json({ success: false, message: 'Pending expert not found' });
      }

      const expert = experts[0];

      // Generate new token if expired
      let invitationToken = expert.invitation_token;
      const now = new Date();
      if (!invitationToken || new Date(expert.invitation_expires) < now) {
        invitationToken = crypto.randomBytes(32).toString('hex');
        const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await connection.query(
          'UPDATE users SET invitation_token = ?, invitation_expires = ?, invitation_sent_at = NOW() WHERE id = ?',
          [invitationToken, tokenExpiry, expertId]
        );
      }

      // Get tenant name
      let tenantName = tenantId;
      try {
        const masterConn = await getMasterConnection();
        const [tenantInfo] = await masterConn.query(
          'SELECT company_name FROM tenants WHERE tenant_code = ?',
          [tenantId]
        );
        masterConn.release();
        if (tenantInfo.length > 0) tenantName = tenantInfo[0].company_name;
      } catch (e) {}

      // Build invitation URL
      const baseUrl = process.env.BASE_URL || 'https://serviflow.app';
      const invitationUrl = `${baseUrl}/accept-invite?token=${invitationToken}&tenant=${tenantId}`;

      // Parse name for salutation
      const nameParts = (expert.full_name || '').split(' ');
      const firstName = nameParts[0] || 'Expert';

      // Send email
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f8f9fa; border-radius: 8px;">
          <div style="background: #003366; color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">Invitation Reminder</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 8px 8px;">
            <p style="font-size: 16px; color: #333;">Dear ${firstName},</p>

            <p style="font-size: 16px; color: #333; line-height: 1.6;">
              This is a reminder that you have been invited to join <strong>${tenantName}'s</strong> ServiFlow Support Team.
            </p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${invitationUrl}"
                 style="display: inline-block; background: #003366; color: white; padding: 14px 32px;
                        text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: bold;">
                Accept Invitation & Set Password
              </a>
            </div>

            <p style="font-size: 14px; color: #666;">
              This link will expire in 7 days.
            </p>
          </div>
        </div>
      `;

      const emailResult = await sendEmail(tenantId, {
        to: expert.email,
        subject: `Reminder: You're invited to join ${tenantName}'s ServiFlow Team`,
        html: emailHtml,
        emailType: 'experts',
        skipUserCheck: true // Pending user doesn't have full account yet
      });

      if (!emailResult.success) {
        return res.status(500).json({
          success: false,
          message: 'Failed to send invitation email',
          error: emailResult.message
        });
      }

      res.json({ success: true, message: 'Invitation resent successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error resending invitation:', error);
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

      // Clean up all foreign key references before deletion
      // Helper to run query and ignore "table doesn't exist" errors
      const safeQuery = async (sql, params) => {
        try {
          await connection.query(sql, params);
        } catch (err) {
          if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
        }
      };

      // Unassign from tickets
      await safeQuery('UPDATE tickets SET assignee_id = NULL WHERE assignee_id = ?', [expertId]);
      await safeQuery('UPDATE tickets SET created_by = NULL WHERE created_by = ?', [expertId]);

      // Clear KB references
      await safeQuery('UPDATE kb_articles SET created_by = NULL WHERE created_by = ?', [expertId]);
      await safeQuery('UPDATE kb_articles SET updated_by = NULL WHERE updated_by = ?', [expertId]);
      await safeQuery('UPDATE kb_categories SET created_by = NULL WHERE created_by = ?', [expertId]);

      // Clear CMDB references
      await safeQuery('UPDATE cmdb_items SET created_by = NULL WHERE created_by = ?', [expertId]);
      await safeQuery('UPDATE ticket_cmdb SET created_by = NULL WHERE created_by = ?', [expertId]);

      // Clear ticket rules references
      await safeQuery('UPDATE ticket_processing_rules SET created_by = NULL WHERE created_by = ?', [expertId]);

      // Delete related records (these are user-specific, not shared)
      await safeQuery('DELETE FROM expert_ticket_permissions WHERE expert_id = ?', [expertId]);
      await safeQuery('DELETE FROM ticket_activity WHERE user_id = ?', [expertId]);
      await safeQuery('DELETE FROM kb_article_feedback WHERE user_id = ?', [expertId]);
      await safeQuery('DELETE FROM kb_article_views WHERE user_id = ?', [expertId]);

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
