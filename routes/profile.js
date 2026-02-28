const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { applyTenantMatch } = require('../middleware/tenantMatch');
const { body } = require('express-validator');
const { handleValidationErrors } = require('../middleware/validation');
const {
  writeOperationsLimiter,
  readOperationsLimiter
} = require('../middleware/rateLimiter');

// Apply verifyToken middleware to all routes
router.use(verifyToken);
applyTenantMatch(router);

// Validation for company profile update
const validateProfileUpdate = [
  body('company_name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 200 }).withMessage('Company name must be between 2 and 200 characters'),
  body('contact_phone')
    .optional()
    .trim()
    .isLength({ max: 50 }).withMessage('Contact phone must not exceed 50 characters'),
  body('mail_from_email')
    .optional()
    .trim()
    .isEmail().withMessage('Mail from email must be a valid email address')
    .isLength({ max: 100 }).withMessage('Mail from email must not exceed 100 characters'),
  body('company_url_domain')
    .optional()
    .trim()
    .isLength({ max: 255 }).withMessage('Company URL domain must not exceed 255 characters'),
  handleValidationErrors
];

// Get company profile
router.get('/:tenantId/profile', readOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [profiles] = await connection.query('SELECT * FROM company_profile LIMIT 1');

      if (profiles.length === 0) {
        // Create default profile if none exists
        await connection.query(`
          INSERT INTO company_profile (company_name, contact_phone, mail_from_email, company_url_domain)
          VALUES (?, ?, ?, ?)
        `, ['', '', '', '']);

        const [newProfile] = await connection.query('SELECT * FROM company_profile LIMIT 1');
        res.json({ success: true, profile: newProfile[0] });
      } else {
        res.json({ success: true, profile: profiles[0] });
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching company profile:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update company profile
router.put('/:tenantId/profile', requireRole(['admin']), writeOperationsLimiter, validateProfileUpdate, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const {
      company_name,
      contact_phone,
      mail_from_email,
      company_url_domain
    } = req.body;

    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Check if profile exists
      const [profiles] = await connection.query('SELECT id FROM company_profile LIMIT 1');

      if (profiles.length === 0) {
        // Insert new profile
        await connection.query(`
          INSERT INTO company_profile (company_name, contact_phone, mail_from_email, company_url_domain)
          VALUES (?, ?, ?, ?)
        `, [company_name, contact_phone, mail_from_email, company_url_domain]);
      } else {
        // Update existing profile
        await connection.query(`
          UPDATE company_profile SET
            company_name = COALESCE(?, company_name),
            contact_phone = COALESCE(?, contact_phone),
            mail_from_email = COALESCE(?, mail_from_email),
            company_url_domain = COALESCE(?, company_url_domain),
            updated_at = NOW()
          WHERE id = ?
        `, [company_name, contact_phone, mail_from_email, company_url_domain, profiles[0].id]);
      }

      res.json({ success: true, message: 'Company profile updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating company profile:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
