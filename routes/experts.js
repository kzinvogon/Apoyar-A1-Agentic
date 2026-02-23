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
          u.created_at, u.updated_at, u.last_login,
          COUNT(CASE WHEN t.status IN ('open', 'in_progress', 'paused') THEN 1 END) as open_tickets
         FROM users u
         LEFT JOIN tickets t ON u.id = t.assignee_id
         WHERE u.role IN ('admin', 'expert') AND u.is_active = TRUE
         GROUP BY u.id, u.username, u.email, u.full_name, u.role, u.is_active,
                  u.created_at, u.updated_at, u.last_login
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
          u.created_at, u.updated_at, u.last_login
         FROM users u
         WHERE u.role IN ('admin', 'expert') AND u.is_active = FALSE
           AND u.invitation_token IS NULL
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

// Get invited (pending) experts for a tenant - MUST come before /:tenantId/:expertId
router.get('/:tenantId/invited', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      const now = new Date();
      const [experts] = await connection.query(
        `SELECT
          u.id, u.username, u.email, u.full_name, u.role, u.is_active,
          u.invitation_sent_at, u.invitation_expires,
          u.created_at, u.updated_at
         FROM users u
         WHERE u.role IN ('admin', 'expert')
           AND u.is_active = FALSE
           AND u.invitation_token IS NOT NULL
         ORDER BY u.invitation_sent_at DESC`
      );

      // Add status field based on expiry
      const expertsWithStatus = experts.map(expert => ({
        ...expert,
        status: new Date(expert.invitation_expires) > now ? 'pending' : 'expired'
      }));

      res.json({ success: true, experts: expertsWithStatus });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching invited experts:', error);
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
          u.phone, u.department, u.rating, u.reference_code,
          u.first_name, u.middle_name, u.last_name, u.screen_name,
          u.location, u.street_address, u.city, u.state, u.postcode, u.country,
          u.timezone, u.language, u.interface_language, u.security_level,
          u.receive_email_updates AS email_updates,
          u.created_at, u.updated_at, u.last_login,
          COUNT(CASE WHEN t.status IN ('open', 'in_progress', 'paused') THEN 1 END) as open_tickets
         FROM users u
         LEFT JOIN tickets t ON u.id = t.assignee_id
         WHERE u.id = ? AND u.role IN ('admin', 'expert')
         GROUP BY u.id`,
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
      location, street_address, city, state, postcode, country, timezone, language,
      email_updates, rating, reference_code, first_name, middle_name, last_name,
      screen_name, interface_language, security_level
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
      if (email_updates !== undefined) { updates.push('receive_email_updates = ?'); values.push(email_updates ? 1 : 0); }
      if (rating !== undefined) { updates.push('rating = ?'); values.push(rating); }
      if (reference_code !== undefined) { updates.push('reference_code = ?'); values.push(reference_code); }
      if (first_name !== undefined) { updates.push('first_name = ?'); values.push(first_name); }
      if (middle_name !== undefined) { updates.push('middle_name = ?'); values.push(middle_name); }
      if (last_name !== undefined) { updates.push('last_name = ?'); values.push(last_name); }
      if (screen_name !== undefined) { updates.push('screen_name = ?'); values.push(screen_name); }
      if (interface_language !== undefined) { updates.push('interface_language = ?'); values.push(interface_language); }
      if (security_level !== undefined) { updates.push('security_level = ?'); values.push(security_level); }

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
      const tokenExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

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
              This invitation link will expire in 14 days. If the button above doesn't work,
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

// Bulk invite experts
router.post('/:tenantId/bulk-invite', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { experts: expertsList } = req.body;

    if (!Array.isArray(expertsList) || expertsList.length === 0) {
      return res.status(400).json({ success: false, message: 'experts array is required' });
    }

    if (expertsList.length > 100) {
      return res.status(400).json({ success: false, message: 'Maximum 100 experts per batch' });
    }

    const connection = await getTenantConnection(tenantId);
    const masterConn = await getMasterConnection();

    try {
      // Get tenant name for emails
      const [tenants] = await masterConn.query(
        'SELECT company_name FROM tenants WHERE tenant_code = ?',
        [tenantId]
      );
      const tenantName = tenants[0]?.company_name || tenantId;
      const baseUrl = process.env.BASE_URL || 'https://serviflow.app';

      const results = [];

      for (const expert of expertsList) {
        const { email, first_name, last_name, salutation } = expert;

        // Validate required fields
        if (!email || !first_name || !last_name) {
          results.push({
            email: email || 'unknown',
            status: 'error',
            message: 'Missing required fields (email, first_name, last_name)'
          });
          continue;
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          results.push({ email, status: 'error', message: 'Invalid email format' });
          continue;
        }

        // Check if email exists
        const [existing] = await connection.query(
          'SELECT id, is_active, invitation_token, deleted_at, full_name FROM users WHERE email = ?',
          [email.toLowerCase()]
        );

        if (existing.length > 0) {
          const user = existing[0];

          if (user.is_active) {
            results.push({ email, status: 'skipped', message: 'Already exists as active expert' });
            continue;
          }

          if (user.invitation_token && !user.deleted_at) {
            results.push({ email, status: 'skipped', message: 'Already has pending invitation' });
            continue;
          }

          if (user.deleted_at) {
            results.push({
              email,
              status: 'skipped',
              message: `Deleted expert exists (${user.full_name}). Restore or erase first.`
            });
            continue;
          }
        }

        // Create invitation
        const fullName = salutation ? `${salutation} ${first_name} ${last_name}` : `${first_name} ${last_name}`;
        const invitationToken = crypto.randomBytes(32).toString('hex');
        const tokenExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

        const [insertResult] = await connection.query(
          `INSERT INTO users (username, email, password_hash, full_name, role, is_active, invitation_token, invitation_expires, invitation_sent_at, created_at, updated_at)
           VALUES (?, ?, '', ?, 'expert', FALSE, ?, ?, NOW(), NOW(), NOW())`,
          [email.toLowerCase(), email.toLowerCase(), fullName, invitationToken, tokenExpiry]
        );

        const expertId = insertResult.insertId;
        const invitationUrl = `${baseUrl}/accept-invite?token=${invitationToken}&tenant=${tenantId}`;

        // Send email
        const emailHtml = `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;">
            <div style="background: white; border-radius: 8px; padding: 30px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h1 style="color: #003366; margin-bottom: 20px;">Welcome to ServiFlow!</h1>
              <p style="font-size: 16px; color: #374151; line-height: 1.6;">
                Hi ${first_name},
              </p>
              <p style="font-size: 16px; color: #374151; line-height: 1.6;">
                You've been invited to join <strong>${tenantName}</strong>'s support team as an Expert.
              </p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${invitationUrl}" style="background: #003366; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600;">
                  Accept Invitation
                </a>
              </div>
              <p style="font-size: 14px; color: #666;">
                This invitation link will expire in 14 days.
              </p>
            </div>
          </div>
        `;

        const emailResult = await sendEmail(tenantId, {
          to: email,
          subject: `You're invited to join ${tenantName}'s ServiFlow Support Team`,
          html: emailHtml,
          emailType: 'experts',
          skipUserCheck: true
        });

        results.push({
          email,
          status: 'invited',
          message: emailResult.success ? 'Invitation sent' : 'Created but email failed',
          expertId,
          emailSent: emailResult.success
        });
      }

      // Summary
      const invited = results.filter(r => r.status === 'invited').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      const errors = results.filter(r => r.status === 'error').length;

      res.json({
        success: true,
        message: `Processed ${results.length} experts: ${invited} invited, ${skipped} skipped, ${errors} errors`,
        summary: { total: results.length, invited, skipped, errors },
        results
      });
    } finally {
      connection.release();
      masterConn.release();
    }
  } catch (error) {
    console.error('Error bulk inviting experts:', error);
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
        const tokenExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

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
              This link will expire in 14 days.
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

// Revoke invitation (permanently delete pending invite)
router.delete('/:tenantId/:expertId/revoke-invite', async (req, res) => {
  try {
    const { tenantId, expertId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      // Check if expert exists and has pending invitation
      const [existing] = await connection.query(
        'SELECT id, email, full_name, is_active, invitation_token FROM users WHERE id = ? AND role IN ("admin", "expert")',
        [expertId]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Expert not found' });
      }

      const expert = existing[0];

      if (expert.is_active) {
        return res.status(400).json({
          success: false,
          message: 'Cannot revoke invitation for an active expert'
        });
      }

      if (!expert.invitation_token) {
        return res.status(400).json({
          success: false,
          message: 'Expert does not have a pending invitation'
        });
      }

      // Permanently delete the user record (they never activated)
      await connection.query('DELETE FROM users WHERE id = ?', [expertId]);

      console.log(`🗑️ Revoked invitation and deleted pending expert: ${expert.email} (ID: ${expertId})`);

      res.json({
        success: true,
        message: 'Invitation revoked and user removed',
        revoked: {
          id: expertId,
          email: expert.email,
          fullName: expert.full_name
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error revoking invitation:', error);
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
      // Helper to run query and ignore missing table/column errors
      const safeQuery = async (sql, params) => {
        try {
          await connection.query(sql, params);
        } catch (err) {
          // Ignore missing table or column errors
          if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        }
      };

      // Reassign any tickets where this expert is the requester to the admin performing the erase
      const adminId = req.user.userId;
      const [requestedTickets] = await connection.query(
        'SELECT COUNT(*) as count FROM tickets WHERE requester_id = ?',
        [expertId]
      );
      if (requestedTickets[0].count > 0) {
        await connection.query(
          'UPDATE tickets SET requester_id = ? WHERE requester_id = ?',
          [adminId, expertId]
        );
        console.log(`Reassigned ${requestedTickets[0].count} tickets from erased expert ${expertId} to admin ${adminId}`);
      }

      // Unassign from tickets (handle nullable user reference columns)
      await safeQuery('UPDATE tickets SET assignee_id = NULL WHERE assignee_id = ?', [expertId]);
      await safeQuery('UPDATE tickets SET created_by = NULL WHERE created_by = ?', [expertId]);
      await safeQuery('UPDATE tickets SET customer_id = NULL WHERE customer_id = ?', [expertId]);
      await safeQuery('UPDATE tickets SET previous_assignee_id = NULL WHERE previous_assignee_id = ?', [expertId]);

      // Clear KB references
      await safeQuery('UPDATE kb_articles SET created_by = NULL WHERE created_by = ?', [expertId]);
      await safeQuery('UPDATE kb_articles SET updated_by = NULL WHERE updated_by = ?', [expertId]);
      await safeQuery('UPDATE kb_categories SET created_by = NULL WHERE created_by = ?', [expertId]);
      await safeQuery('UPDATE kb_article_reviews SET reviewed_by = NULL WHERE reviewed_by = ?', [expertId]);
      await safeQuery('UPDATE kb_suggested_articles SET created_by = NULL WHERE created_by = ?', [expertId]);

      // Clear CMDB references
      await safeQuery('UPDATE cmdb_items SET created_by = NULL WHERE created_by = ?', [expertId]);
      await safeQuery('UPDATE cmdb_items SET owner_id = NULL WHERE owner_id = ?', [expertId]);
      await safeQuery('UPDATE ticket_cmdb SET created_by = NULL WHERE created_by = ?', [expertId]);
      await safeQuery('UPDATE cmdb_relationships SET created_by = NULL WHERE created_by = ?', [expertId]);

      // Clear ticket rules references
      await safeQuery('UPDATE ticket_processing_rules SET created_by = NULL WHERE created_by = ?', [expertId]);

      // Clear AI references
      await safeQuery('UPDATE ai_suggestions SET user_id = NULL WHERE user_id = ?', [expertId]);
      await safeQuery('UPDATE ai_suggestions SET acknowledged_by = NULL WHERE acknowledged_by = ?', [expertId]);

      // Clear customer companies admin reference
      await safeQuery('UPDATE customer_companies SET admin_user_id = NULL WHERE admin_user_id = ?', [expertId]);

      // Delete related records (these are user-specific, not shared)
      await safeQuery('DELETE FROM expert_ticket_permissions WHERE expert_id = ?', [expertId]);
      await safeQuery('DELETE FROM expert_ticket_permissions WHERE customer_id = ?', [expertId]);
      await safeQuery('DELETE FROM ticket_activity WHERE user_id = ?', [expertId]);
      await safeQuery('DELETE FROM kb_article_feedback WHERE user_id = ?', [expertId]);
      await safeQuery('DELETE FROM kb_article_views WHERE user_id = ?', [expertId]);
      await safeQuery('DELETE FROM tenant_audit_log WHERE user_id = ?', [expertId]);
      await safeQuery('DELETE FROM customers WHERE user_id = ?', [expertId]);

      // Permanently delete the expert
      await connection.query('DELETE FROM users WHERE id = ?', [expertId]);

      console.log(`🗑️ Permanently erased expert: ${existing[0].email} (ID: ${expertId})`);

      const ticketsReassigned = requestedTickets[0].count;
      res.json({
        success: true,
        message: ticketsReassigned > 0
          ? `Expert permanently erased. ${ticketsReassigned} ticket(s) were reassigned to you.`
          : 'Expert permanently erased',
        erased: {
          id: expertId,
          email: existing[0].email,
          fullName: existing[0].full_name,
          ticketsReassigned
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
