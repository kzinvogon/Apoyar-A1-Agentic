/**
 * Reports Routes
 * Admin-only endpoints for monthly report generation, preview, and sending.
 */

const express = require('express');
const router = express.Router();
const { tenantQuery } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { sendEmail } = require('../config/email');
const { aggregateMonthlyData, renderReportHTML } = require('../services/report-generator');

// Require admin for all report routes
router.use(verifyToken);
router.use(requireRole(['admin']));

// ---------------------------------------------------------------------------
// Helper: parse month param "YYYY-MM" or separate month/year
// ---------------------------------------------------------------------------
function parsePeriod(query) {
  if (query.month && query.month.includes('-')) {
    const [y, m] = query.month.split('-').map(Number);
    return { month: m, year: y };
  }
  const month = parseInt(query.month, 10) || new Date().getMonth(); // previous month default
  const year = parseInt(query.year, 10) || new Date().getFullYear();
  return { month, year };
}

function periodDates(month, year) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 1); // first of next month
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

// ---------------------------------------------------------------------------
// GET /:tenantCode/monthly/preview
// ---------------------------------------------------------------------------
router.get('/:tenantCode/monthly/preview', async (req, res) => {
  try {
    const tenantCode = req.params.tenantCode;
    const { month, year } = parsePeriod(req.query);
    const companyFilter = req.query.company ? parseInt(req.query.company, 10) : null;
    const { start, end } = periodDates(month, year);

    // Check include_system setting
    let includeSystem = false;
    try {
      const rows = await tenantQuery(tenantCode,
        `SELECT setting_value FROM tenant_settings WHERE setting_key = 'monthly_report_include_system_tickets'`
      );
      if (rows.length > 0 && rows[0].setting_value === 'true') includeSystem = true;
    } catch (e) { /* ignore */ }

    // Get company name if filtered
    let companyName = null;
    if (companyFilter) {
      try {
        const companies = await tenantQuery(tenantCode,
          `SELECT company_name FROM customer_companies WHERE id = ?`, [companyFilter]
        );
        if (companies.length > 0) companyName = companies[0].company_name;
      } catch (e) { /* ignore */ }
    }

    // Get tenant name
    let tenantName = tenantCode;
    try {
      const tenants = await tenantQuery(tenantCode,
        `SELECT setting_value FROM tenant_settings WHERE setting_key = 'company_name'`
      );
      if (tenants.length > 0 && tenants[0].setting_value) tenantName = tenants[0].setting_value;
    } catch (e) { /* ignore */ }

    const data = await aggregateMonthlyData(tenantCode, start, end, companyFilter, includeSystem);
    const html = renderReportHTML(data, {
      tenantName,
      month,
      year,
      companyName,
      generatedAt: new Date().toISOString(),
    });

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('[Reports] Preview error:', error);
    res.status(500).json({ error: 'Failed to generate report preview' });
  }
});

// ---------------------------------------------------------------------------
// POST /:tenantCode/monthly/send
// ---------------------------------------------------------------------------
router.post('/:tenantCode/monthly/send', async (req, res) => {
  try {
    const tenantCode = req.params.tenantCode;
    const { month, year, recipients, companyFilter } = req.body;

    if (!month || !year) {
      return res.status(400).json({ error: 'month and year are required' });
    }
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'recipients array is required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of recipients) {
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: `Invalid email address: ${email}` });
      }
    }

    const companyId = companyFilter ? parseInt(companyFilter, 10) : null;
    const { start, end } = periodDates(month, year);

    // Check include_system setting
    let includeSystem = false;
    try {
      const rows = await tenantQuery(tenantCode,
        `SELECT setting_value FROM tenant_settings WHERE setting_key = 'monthly_report_include_system_tickets'`
      );
      if (rows.length > 0 && rows[0].setting_value === 'true') includeSystem = true;
    } catch (e) { /* ignore */ }

    // Get company name if filtered
    let companyName = null;
    if (companyId) {
      try {
        const companies = await tenantQuery(tenantCode,
          `SELECT company_name FROM customer_companies WHERE id = ?`, [companyId]
        );
        if (companies.length > 0) companyName = companies[0].company_name;
      } catch (e) { /* ignore */ }
    }

    // Get tenant name
    let tenantName = tenantCode;
    try {
      const tenants = await tenantQuery(tenantCode,
        `SELECT setting_value FROM tenant_settings WHERE setting_key = 'company_name'`
      );
      if (tenants.length > 0 && tenants[0].setting_value) tenantName = tenants[0].setting_value;
    } catch (e) { /* ignore */ }

    const data = await aggregateMonthlyData(tenantCode, start, end, companyId, includeSystem);
    const html = renderReportHTML(data, {
      tenantName,
      month,
      year,
      companyName,
      generatedAt: new Date().toISOString(),
    });

    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthName = monthNames[month - 1] || `Month ${month}`;
    const subject = `${tenantName} — Monthly Service Report: ${monthName} ${year}`;

    // Send to each recipient
    const results = [];
    for (const to of recipients) {
      const result = await sendEmail(tenantCode, {
        to,
        subject,
        html,
        skipUserCheck: true,
        skipKillSwitch: true,
      });
      results.push({ to, ...result });
    }

    // Record in report_history
    try {
      await tenantQuery(tenantCode, `
        INSERT INTO report_history (report_type, period_month, period_year, company_filter, generated_by, recipients_json, ticket_count, cmdb_change_count, sla_compliance_pct, status)
        VALUES ('monthly', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        month, year,
        companyName || null,
        req.user.userId,
        JSON.stringify(recipients),
        data.summary.total || 0,
        data.cmdbChanges.total || 0,
        data.sla.compliancePct != null ? data.sla.compliancePct : null,
        results.every(r => r.success) ? 'sent' : 'partial_failure',
      ]);
    } catch (err) {
      console.warn('[Reports] Could not save report_history:', err.message);
    }

    const sent = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    res.json({
      success: failed === 0,
      message: `Report sent to ${sent} recipient(s)${failed > 0 ? `, ${failed} failed` : ''}`,
      results,
    });
  } catch (error) {
    console.error('[Reports] Send error:', error);
    res.status(500).json({ error: 'Failed to send report' });
  }
});

// ---------------------------------------------------------------------------
// GET /:tenantCode/monthly/config
// ---------------------------------------------------------------------------
router.get('/:tenantCode/monthly/config', async (req, res) => {
  try {
    const tenantCode = req.params.tenantCode;
    const keys = [
      'monthly_report_enabled',
      'monthly_report_recipients',
      'monthly_report_send_day',
      'monthly_report_include_system_tickets',
    ];

    const config = {};
    for (const key of keys) {
      try {
        const rows = await tenantQuery(tenantCode,
          `SELECT setting_value FROM tenant_settings WHERE setting_key = ?`, [key]
        );
        config[key] = rows.length > 0 ? rows[0].setting_value : null;
      } catch (e) {
        config[key] = null;
      }
    }

    // Parse JSON/boolean values
    res.json({
      enabled: config.monthly_report_enabled === 'true',
      recipients: (() => { try { return JSON.parse(config.monthly_report_recipients || '[]'); } catch { return []; } })(),
      sendDay: parseInt(config.monthly_report_send_day, 10) || 1,
      includeSystemTickets: config.monthly_report_include_system_tickets === 'true',
    });
  } catch (error) {
    console.error('[Reports] Config fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch report config' });
  }
});

// ---------------------------------------------------------------------------
// POST /:tenantCode/monthly/config
// ---------------------------------------------------------------------------
router.post('/:tenantCode/monthly/config', async (req, res) => {
  try {
    const tenantCode = req.params.tenantCode;
    const { enabled, recipients, sendDay, includeSystemTickets } = req.body;

    // Validate sendDay
    const day = parseInt(sendDay, 10);
    if (day && (day < 1 || day > 28)) {
      return res.status(400).json({ error: 'sendDay must be between 1 and 28' });
    }

    // Validate recipients
    if (recipients && Array.isArray(recipients)) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const email of recipients) {
        if (email && !emailRegex.test(email)) {
          return res.status(400).json({ error: `Invalid email address: ${email}` });
        }
      }
    }

    const settings = {
      monthly_report_enabled: String(!!enabled),
      monthly_report_recipients: JSON.stringify(recipients || []),
      monthly_report_send_day: String(day || 1),
      monthly_report_include_system_tickets: String(!!includeSystemTickets),
    };

    for (const [key, value] of Object.entries(settings)) {
      await tenantQuery(tenantCode, `
        INSERT INTO tenant_settings (setting_key, setting_value, setting_type, description)
        VALUES (?, ?, 'string', ?)
        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
      `, [key, value, `Monthly report setting: ${key}`]);
    }

    res.json({ success: true, message: 'Report configuration saved' });
  } catch (error) {
    console.error('[Reports] Config save error:', error);
    res.status(500).json({ error: 'Failed to save report config' });
  }
});

// ---------------------------------------------------------------------------
// GET /:tenantCode/monthly/history
// ---------------------------------------------------------------------------
router.get('/:tenantCode/monthly/history', async (req, res) => {
  try {
    const tenantCode = req.params.tenantCode;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    let history = [];
    try {
      history = await tenantQuery(tenantCode, `
        SELECT rh.*, u.full_name as generated_by_name
        FROM report_history rh
        LEFT JOIN users u ON rh.generated_by = u.id
        ORDER BY rh.generated_at DESC
        LIMIT ?
      `, [limit]);
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') {
        return res.json([]);
      }
      throw err;
    }

    res.json(history);
  } catch (error) {
    console.error('[Reports] History error:', error);
    res.status(500).json({ error: 'Failed to fetch report history' });
  }
});

module.exports = router;
