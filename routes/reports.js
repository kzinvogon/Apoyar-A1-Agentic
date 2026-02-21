/**
 * Reports Routes
 * Monthly report generation, preview, and sending.
 * Accessible by: admin (all companies) and company_admin (own company only).
 */

const express = require('express');
const router = express.Router();
const { tenantQuery } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { sendEmail } = require('../config/email');
const { aggregateMonthlyData, renderReportHTML } = require('../services/report-generator');

router.use(verifyToken);

// ---------------------------------------------------------------------------
// Middleware: allow admin OR company admin, attach company context
// ---------------------------------------------------------------------------
async function requireReportAccess(req, res, next) {
  const tenantCode = req.params.tenantCode;
  const role = req.user.role;

  // Admin — full access, optional company filter
  if (role === 'admin') {
    req.reportAccess = { isAdmin: true, companyId: null, companyName: null };
    return next();
  }

  // Customer — check if company admin
  if (role === 'customer') {
    try {
      const rows = await tenantQuery(tenantCode, `
        SELECT c.is_company_admin, c.customer_company_id, cc.company_name
        FROM customers c
        LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
        WHERE c.user_id = ?
      `, [req.user.userId]);

      if (rows.length > 0 && rows[0].is_company_admin && rows[0].customer_company_id) {
        req.reportAccess = {
          isAdmin: false,
          companyId: rows[0].customer_company_id,
          companyName: rows[0].company_name,
        };
        return next();
      }
    } catch (err) {
      console.error('[Reports] Company admin check failed:', err.message);
    }
  }

  return res.status(403).json({ error: 'Admin or company admin access required' });
}

router.use('/:tenantCode', requireReportAccess);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parsePeriod(query) {
  if (query.month && query.month.includes('-')) {
    const [y, m] = query.month.split('-').map(Number);
    return { month: m, year: y };
  }
  const month = parseInt(query.month, 10) || new Date().getMonth();
  const year = parseInt(query.year, 10) || new Date().getFullYear();
  return { month, year };
}

function periodDates(month, year) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 1);
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

/**
 * Resolve the effective company filter.
 * Company admins are always locked to their own company.
 * Admins can optionally filter by company.
 */
function resolveCompanyFilter(req) {
  if (!req.reportAccess.isAdmin) {
    // Company admin — always locked to own company
    return req.reportAccess.companyId;
  }
  // Admin — use query/body param if provided
  const param = req.query.company || req.body?.companyFilter;
  return param ? parseInt(param, 10) : null;
}

async function getTenantName(tenantCode) {
  try {
    const rows = await tenantQuery(tenantCode,
      `SELECT setting_value FROM tenant_settings WHERE setting_key = 'company_name'`);
    if (rows.length > 0 && rows[0].setting_value) return rows[0].setting_value;
  } catch { /* ignore */ }
  return tenantCode;
}

async function getCompanyName(tenantCode, companyId) {
  if (!companyId) return null;
  try {
    const rows = await tenantQuery(tenantCode,
      `SELECT company_name FROM customer_companies WHERE id = ?`, [companyId]);
    if (rows.length > 0) return rows[0].company_name;
  } catch { /* ignore */ }
  return null;
}

async function getIncludeSystem(tenantCode) {
  try {
    const rows = await tenantQuery(tenantCode,
      `SELECT setting_value FROM tenant_settings WHERE setting_key = 'monthly_report_include_system_tickets'`);
    return rows.length > 0 && rows[0].setting_value === 'true';
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// GET /:tenantCode/monthly/preview
// ---------------------------------------------------------------------------
router.get('/:tenantCode/monthly/preview', async (req, res) => {
  try {
    const tenantCode = req.params.tenantCode;
    const { month, year } = parsePeriod(req.query);
    const companyId = resolveCompanyFilter(req);
    const { start, end } = periodDates(month, year);

    const includeSystem = await getIncludeSystem(tenantCode);
    const companyName = await getCompanyName(tenantCode, companyId) || req.reportAccess.companyName;
    const tenantName = await getTenantName(tenantCode);

    const data = await aggregateMonthlyData(tenantCode, start, end, companyId, includeSystem);
    const html = renderReportHTML(data, {
      tenantName, month, year, companyName,
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
    const { month, year, recipients } = req.body;

    if (!month || !year) {
      return res.status(400).json({ error: 'month and year are required' });
    }
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'recipients array is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of recipients) {
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: `Invalid email address: ${email}` });
      }
    }

    const companyId = resolveCompanyFilter(req);
    const { start, end } = periodDates(month, year);

    const includeSystem = await getIncludeSystem(tenantCode);
    const companyName = await getCompanyName(tenantCode, companyId) || req.reportAccess.companyName;
    const tenantName = await getTenantName(tenantCode);

    const data = await aggregateMonthlyData(tenantCode, start, end, companyId, includeSystem);
    const html = renderReportHTML(data, {
      tenantName, month, year, companyName,
      generatedAt: new Date().toISOString(),
    });

    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthName = monthNames[month - 1] || `Month ${month}`;
    const subject = `${tenantName} — Monthly Service Report: ${monthName} ${year}${companyName ? ` (${companyName})` : ''}`;

    const results = [];
    for (const to of recipients) {
      const result = await sendEmail(tenantCode, {
        to, subject, html,
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
// GET /:tenantCode/monthly/config  (admin only)
// ---------------------------------------------------------------------------
router.get('/:tenantCode/monthly/config', async (req, res) => {
  try {
    if (!req.reportAccess.isAdmin) {
      return res.status(403).json({ error: 'Admin access required for config' });
    }
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
          `SELECT setting_value FROM tenant_settings WHERE setting_key = ?`, [key]);
        config[key] = rows.length > 0 ? rows[0].setting_value : null;
      } catch { config[key] = null; }
    }

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
// POST /:tenantCode/monthly/config  (admin only)
// ---------------------------------------------------------------------------
router.post('/:tenantCode/monthly/config', async (req, res) => {
  try {
    if (!req.reportAccess.isAdmin) {
      return res.status(403).json({ error: 'Admin access required for config' });
    }
    const tenantCode = req.params.tenantCode;
    const { enabled, recipients, sendDay, includeSystemTickets } = req.body;

    const day = parseInt(sendDay, 10);
    if (day && (day < 1 || day > 28)) {
      return res.status(400).json({ error: 'sendDay must be between 1 and 28' });
    }

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

    // Company admins only see reports for their company
    const companyFilter = !req.reportAccess.isAdmin ? req.reportAccess.companyName : null;

    let history = [];
    try {
      if (companyFilter) {
        history = await tenantQuery(tenantCode, `
          SELECT rh.*, u.full_name as generated_by_name
          FROM report_history rh
          LEFT JOIN users u ON rh.generated_by = u.id
          WHERE rh.company_filter = ?
          ORDER BY rh.generated_at DESC LIMIT ?
        `, [companyFilter, limit]);
      } else {
        history = await tenantQuery(tenantCode, `
          SELECT rh.*, u.full_name as generated_by_name
          FROM report_history rh
          LEFT JOIN users u ON rh.generated_by = u.id
          ORDER BY rh.generated_at DESC LIMIT ?
        `, [limit]);
      }
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
      throw err;
    }

    res.json(history);
  } catch (error) {
    console.error('[Reports] History error:', error);
    res.status(500).json({ error: 'Failed to fetch report history' });
  }
});

// ---------------------------------------------------------------------------
// GET /:tenantCode/monthly/access  — returns caller's access level
// ---------------------------------------------------------------------------
router.get('/:tenantCode/monthly/access', (req, res) => {
  res.json({
    isAdmin: req.reportAccess.isAdmin,
    companyId: req.reportAccess.companyId,
    companyName: req.reportAccess.companyName,
  });
});

module.exports = router;
