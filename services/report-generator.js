/**
 * Monthly Report Generator Service
 * Data aggregation + HTML email rendering for monthly customer reports.
 */

const { tenantQuery } = require('../config/database');

// ---------------------------------------------------------------------------
// System ticket exclusion clause (matches ai-analysis-service.js pattern)
// ---------------------------------------------------------------------------
const SYSTEM_EXCLUDE = `AND NOT EXISTS (
  SELECT 1 FROM users u WHERE u.id = t.requester_id
  AND (u.username = 'system' OR u.email = 'system@tenant.local')
)`;

// ---------------------------------------------------------------------------
// Data aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate all monthly report data for a tenant.
 * @param {string} tenantCode
 * @param {string} startDate - YYYY-MM-DD (inclusive)
 * @param {string} endDate - YYYY-MM-DD (exclusive, first of next month)
 * @param {number|null} companyFilter - customer_company_id or null
 * @param {boolean} includeSystem - include system-generated tickets
 * @returns {Promise<Object>} all report sections
 */
async function aggregateMonthlyData(tenantCode, startDate, endDate, companyFilter = null, includeSystem = false) {
  const q = (sql, params) => tenantQuery(tenantCode, sql, params);

  const systemClause = includeSystem ? '' : SYSTEM_EXCLUDE;

  // Optional company filter — joins through customers → users
  let companyJoin = '';
  let companyWhere = '';
  const companyParams = [];
  if (companyFilter) {
    companyJoin = 'JOIN customers c ON c.user_id = t.requester_id';
    companyWhere = 'AND c.customer_company_id = ?';
    companyParams.push(companyFilter);
  }

  // 1. Ticket summary
  const [summaryRow] = await q(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END) as open_count,
      SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) as in_progress_count,
      SUM(CASE WHEN t.status = 'Resolved' THEN 1 ELSE 0 END) as resolved_count,
      SUM(CASE WHEN t.status = 'Closed' THEN 1 ELSE 0 END) as closed_count
    FROM tickets t
    ${companyJoin}
    WHERE t.created_at >= ? AND t.created_at < ?
    ${systemClause}
    ${companyWhere}
  `, [startDate, endDate, ...companyParams]);

  // Priority breakdown
  const priorityBreakdown = await q(`
    SELECT t.priority, COUNT(*) as count
    FROM tickets t
    ${companyJoin}
    WHERE t.created_at >= ? AND t.created_at < ?
    ${systemClause}
    ${companyWhere}
    GROUP BY t.priority
    ORDER BY count DESC
  `, [startDate, endDate, ...companyParams]);

  // Category breakdown
  const categoryBreakdown = await q(`
    SELECT t.category, COUNT(*) as count
    FROM tickets t
    ${companyJoin}
    WHERE t.created_at >= ? AND t.created_at < ?
    ${systemClause}
    ${companyWhere}
    GROUP BY t.category
    ORDER BY count DESC
    LIMIT 10
  `, [startDate, endDate, ...companyParams]);

  // 2. CMDB changes
  let cmdbChanges = { total: 0, byType: [], topAssets: [] };
  try {
    const [cmdbTotal] = await q(`
      SELECT COUNT(*) as total FROM cmdb_change_history
      WHERE created_at >= ? AND created_at < ?
    `, [startDate, endDate]);
    cmdbChanges.total = cmdbTotal.total;

    cmdbChanges.byType = await q(`
      SELECT change_type, COUNT(*) as count
      FROM cmdb_change_history
      WHERE created_at >= ? AND created_at < ?
      GROUP BY change_type ORDER BY count DESC
    `, [startDate, endDate]);

    cmdbChanges.topAssets = await q(`
      SELECT ci.asset_name, ci.asset_category, COUNT(ch.id) as change_count
      FROM cmdb_change_history ch
      JOIN cmdb_items ci ON ch.cmdb_item_id = ci.cmdb_id
      WHERE ch.created_at >= ? AND ch.created_at < ?
      GROUP BY ch.cmdb_item_id, ci.asset_name, ci.asset_category
      ORDER BY change_count DESC LIMIT 10
    `, [startDate, endDate]);
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') console.warn('[Report] CMDB query error:', err.message);
  }

  // 4. SLA performance
  const [slaMetrics] = await q(`
    SELECT
      COUNT(*) as total_with_sla,
      SUM(CASE WHEN t.status IN ('Resolved','Closed') AND t.resolve_due_at IS NOT NULL AND t.updated_at <= t.resolve_due_at THEN 1 ELSE 0 END) as met_sla,
      SUM(CASE WHEN t.status IN ('Resolved','Closed') AND t.resolve_due_at IS NOT NULL AND t.updated_at > t.resolve_due_at THEN 1 ELSE 0 END) as breached_resolve,
      SUM(CASE WHEN t.status NOT IN ('Resolved','Closed') AND t.resolve_due_at IS NOT NULL AND NOW() > t.resolve_due_at THEN 1 ELSE 0 END) as breached_open,
      SUM(CASE WHEN t.status NOT IN ('Resolved','Closed') AND t.resolve_due_at IS NOT NULL AND NOW() <= t.resolve_due_at AND NOW() > DATE_SUB(t.resolve_due_at, INTERVAL 1 HOUR) THEN 1 ELSE 0 END) as at_risk
    FROM tickets t
    ${companyJoin}
    WHERE t.sla_definition_id IS NOT NULL
    AND t.created_at >= ? AND t.created_at < ?
    ${systemClause}
    ${companyWhere}
  `, [startDate, endDate, ...companyParams]);

  const [avgResponse] = await q(`
    SELECT AVG(TIMESTAMPDIFF(MINUTE, t.created_at, t.first_responded_at)) as avg_response_minutes
    FROM tickets t
    ${companyJoin}
    WHERE t.first_responded_at IS NOT NULL
    AND t.created_at >= ? AND t.created_at < ?
    ${systemClause}
    ${companyWhere}
  `, [startDate, endDate, ...companyParams]);

  // Active SLA definitions
  let slaDefinitions = [];
  try {
    slaDefinitions = await q(`
      SELECT name, priority, response_time_minutes, resolve_time_minutes
      FROM sla_definitions WHERE is_active = 1 ORDER BY priority
    `);
  } catch (err) {
    // table may not exist
  }

  const totalWithSla = slaMetrics.total_with_sla || 0;
  const metSla = slaMetrics.met_sla || 0;
  const compliancePct = totalWithSla > 0 ? ((metSla / totalWithSla) * 100) : null;

  // 5. AI Insights
  let aiInsights = [];
  try {
    aiInsights = await q(`
      SELECT insight_type, title, description, severity, status, created_at
      FROM ai_insights
      WHERE created_at >= ? AND created_at < ?
      ORDER BY severity DESC, created_at DESC LIMIT 20
    `, [startDate, endDate]);
  } catch (err) {
    // table may not exist
  }

  // 6. Most active customer
  const topRequesters = await q(`
    SELECT req.full_name, req.username, COUNT(t.id) as ticket_count
    FROM tickets t
    JOIN users req ON t.requester_id = req.id
    ${companyFilter ? 'JOIN customers c ON c.user_id = t.requester_id' : ''}
    WHERE t.created_at >= ? AND t.created_at < ?
    ${systemClause}
    ${companyFilter ? 'AND c.customer_company_id = ?' : ''}
    GROUP BY t.requester_id, req.full_name, req.username
    ORDER BY ticket_count DESC LIMIT 5
  `, [startDate, endDate, ...(companyFilter ? [companyFilter] : [])]);

  // 7. Most active tickets (by activity count)
  let mostActiveTickets = [];
  try {
    mostActiveTickets = await q(`
      SELECT t.id, t.title, t.status, COUNT(ta.id) as activity_count
      FROM tickets t
      JOIN ticket_activity ta ON ta.ticket_id = t.id
      ${companyFilter ? 'JOIN customers c ON c.user_id = t.requester_id' : ''}
      WHERE t.created_at >= ? AND t.created_at < ?
      ${systemClause}
      ${companyFilter ? 'AND c.customer_company_id = ?' : ''}
      GROUP BY t.id, t.title, t.status
      ORDER BY activity_count DESC LIMIT 10
    `, [startDate, endDate, ...(companyFilter ? [companyFilter] : [])]);
  } catch (err) {
    // ticket_activity may not exist
  }

  // 8. Most active CMDB assets (by associated ticket count)
  let mostActiveCmdb = [];
  try {
    mostActiveCmdb = await q(`
      SELECT ci.asset_name, ci.asset_category, COUNT(DISTINCT t.id) as ticket_count
      FROM cmdb_items ci
      JOIN tickets t ON t.cmdb_item_id = ci.cmdb_id
      ${companyFilter ? 'JOIN customers c ON c.user_id = t.requester_id' : ''}
      WHERE t.created_at >= ? AND t.created_at < ?
      ${systemClause}
      ${companyFilter ? 'AND c.customer_company_id = ?' : ''}
      GROUP BY ci.cmdb_id, ci.asset_name, ci.asset_category
      ORDER BY ticket_count DESC LIMIT 10
    `, [startDate, endDate, ...(companyFilter ? [companyFilter] : [])]);
  } catch (err) {
    // cmdb_item_id column may not exist on tickets
  }

  // 9. System monitoring summary
  let systemSummary = { total: 0, autoResolved: 0 };
  try {
    const [sysRow] = await q(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN t.status IN ('Resolved','Closed') THEN 1 ELSE 0 END) as auto_resolved
      FROM tickets t
      JOIN users u ON t.requester_id = u.id
      WHERE (u.username = 'system' OR u.email = 'system@tenant.local')
      AND t.created_at >= ? AND t.created_at < ?
    `, [startDate, endDate]);
    systemSummary.total = sysRow.total || 0;
    systemSummary.autoResolved = sysRow.auto_resolved || 0;
  } catch (err) {
    // ignore
  }

  return {
    summary: summaryRow || { total: 0, open_count: 0, in_progress_count: 0, resolved_count: 0, closed_count: 0 },
    priorityBreakdown,
    categoryBreakdown,
    cmdbChanges,
    sla: {
      totalWithSla,
      metSla,
      breachedResolve: slaMetrics.breached_resolve || 0,
      breachedOpen: slaMetrics.breached_open || 0,
      atRisk: slaMetrics.at_risk || 0,
      compliancePct,
      avgResponseMinutes: avgResponse.avg_response_minutes || null,
      definitions: slaDefinitions,
    },
    aiInsights,
    topRequesters,
    mostActiveTickets,
    mostActiveCmdb,
    systemSummary,
  };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/**
 * Render a full HTML email document for the monthly report.
 * @param {Object} data - from aggregateMonthlyData
 * @param {Object} meta - { tenantName, month, year, companyName, generatedAt }
 * @returns {string} HTML string
 */
function renderReportHTML(data, meta) {
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthName = monthNames[meta.month - 1] || `Month ${meta.month}`;
  const generatedAt = meta.generatedAt || new Date().toISOString();

  const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // Format minutes into human-readable
  const fmtMin = (m) => {
    if (m == null) return 'N/A';
    if (m < 60) return `${Math.round(m)}m`;
    const h = Math.floor(m / 60);
    const rm = Math.round(m % 60);
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  };

  const complianceStr = data.sla.compliancePct != null ? `${data.sla.compliancePct.toFixed(1)}%` : 'N/A';
  const complianceColor = data.sla.compliancePct == null ? '#6b7280' :
    data.sla.compliancePct >= 90 ? '#16a34a' :
    data.sla.compliancePct >= 75 ? '#d97706' : '#dc2626';

  // Priority color map
  const prioColor = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#16a34a', none: '#6b7280' };
  // Status color map
  const statusColor = { 'Open': '#3b82f6', 'In Progress': '#d97706', 'Resolved': '#16a34a', 'Closed': '#6b7280' };
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Monthly Report - ${esc(monthName)} ${meta.year}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:14px;line-height:1.5">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0">
<tr><td align="center">
<table width="700" cellpadding="0" cellspacing="0" style="max-width:700px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">

<!-- Header -->
<tr><td style="background:linear-gradient(135deg,#1e40af,#7c3aed);padding:32px 40px;color:#ffffff">
  <h1 style="margin:0 0 4px 0;font-size:24px;font-weight:700">${esc(meta.tenantName || 'ServiFlow')}</h1>
  <p style="margin:0;font-size:16px;opacity:0.9">Monthly Service Report</p>
  <p style="margin:8px 0 0 0;font-size:20px;font-weight:600">${esc(monthName)} ${meta.year}</p>
  ${meta.companyName ? `<p style="margin:4px 0 0 0;font-size:13px;opacity:0.8">Company: ${esc(meta.companyName)}</p>` : ''}
</td></tr>

<!-- Executive Summary Cards -->
<tr><td style="padding:24px 40px 0">
  <h2 style="margin:0 0 16px 0;font-size:18px;color:#1e293b;border-bottom:2px solid #e2e8f0;padding-bottom:8px">Executive Summary</h2>
  <table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td width="33%" style="padding:0 8px 16px 0">
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#1e40af">${data.summary.total || 0}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Total Tickets</div>
      </div>
    </td>
    <td width="33%" style="padding:0 8px 16px">
      <div style="background:${data.sla.compliancePct != null && data.sla.compliancePct >= 90 ? '#f0fdf4' : data.sla.compliancePct != null && data.sla.compliancePct >= 75 ? '#fffbeb' : '#fef2f2'};border:1px solid ${data.sla.compliancePct != null && data.sla.compliancePct >= 90 ? '#bbf7d0' : data.sla.compliancePct != null && data.sla.compliancePct >= 75 ? '#fde68a' : '#fecaca'};border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:${complianceColor}">${complianceStr}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">SLA Compliance</div>
      </div>
    </td>
    <td width="33%" style="padding:0 0 16px 8px">
      <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#7c3aed">${fmtMin(data.sla.avgResponseMinutes)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Avg Response Time</div>
      </div>
    </td>
  </tr>
  </table>
</td></tr>

<!-- Ticket Status Breakdown -->
<tr><td style="padding:16px 40px 0">
  <h2 style="margin:0 0 12px 0;font-size:16px;color:#1e293b">Ticket Status Breakdown</h2>
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden">
    <tr style="background:#f8fafc">
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Status</th>
      <th style="text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Count</th>
    </tr>
    <tr><td style="border-bottom:1px solid #f1f5f9"><span style="color:${statusColor['Open']}">&#9679;</span> Open</td><td style="text-align:right;border-bottom:1px solid #f1f5f9">${data.summary.open_count || 0}</td></tr>
    <tr><td style="border-bottom:1px solid #f1f5f9"><span style="color:${statusColor['In Progress']}">&#9679;</span> In Progress</td><td style="text-align:right;border-bottom:1px solid #f1f5f9">${data.summary.in_progress_count || 0}</td></tr>
    <tr><td style="border-bottom:1px solid #f1f5f9"><span style="color:${statusColor['Resolved']}">&#9679;</span> Resolved</td><td style="text-align:right;border-bottom:1px solid #f1f5f9">${data.summary.resolved_count || 0}</td></tr>
    <tr><td><span style="color:${statusColor['Closed']}">&#9679;</span> Closed</td><td style="text-align:right">${data.summary.closed_count || 0}</td></tr>
  </table>
</td></tr>

<!-- Priority Breakdown -->
${data.priorityBreakdown.length > 0 ? `
<tr><td style="padding:16px 40px 0">
  <h2 style="margin:0 0 12px 0;font-size:16px;color:#1e293b">By Priority</h2>
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden">
    <tr style="background:#f8fafc">
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Priority</th>
      <th style="text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Count</th>
    </tr>
    ${data.priorityBreakdown.map((r, i) => `<tr><td style="${i < data.priorityBreakdown.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}"><span style="color:${prioColor[(r.priority || 'none').toLowerCase()] || '#6b7280'}">&#9679;</span> ${esc(r.priority || 'None')}</td><td style="text-align:right;${i < data.priorityBreakdown.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${r.count}</td></tr>`).join('')}
  </table>
</td></tr>` : ''}

<!-- Category Breakdown -->
${data.categoryBreakdown.length > 0 ? `
<tr><td style="padding:16px 40px 0">
  <h2 style="margin:0 0 12px 0;font-size:16px;color:#1e293b">By Category</h2>
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden">
    <tr style="background:#f8fafc">
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Category</th>
      <th style="text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Count</th>
    </tr>
    ${data.categoryBreakdown.map((r, i) => `<tr><td style="${i < data.categoryBreakdown.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.category || 'Uncategorised')}</td><td style="text-align:right;${i < data.categoryBreakdown.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${r.count}</td></tr>`).join('')}
  </table>
</td></tr>` : ''}

<!-- CMDB Changes -->
<tr><td style="padding:16px 40px 0">
  <h2 style="margin:0 0 12px 0;font-size:16px;color:#1e293b">CMDB Changes</h2>
  ${data.cmdbChanges.total > 0 ? `
  <p style="margin:0 0 8px 0"><strong>${data.cmdbChanges.total}</strong> change(s) recorded.</p>
  ${data.cmdbChanges.byType.length > 0 ? `
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:12px">
    <tr style="background:#f8fafc">
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Change Type</th>
      <th style="text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Count</th>
    </tr>
    ${data.cmdbChanges.byType.map((r, i) => `<tr><td style="${i < data.cmdbChanges.byType.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.change_type)}</td><td style="text-align:right;${i < data.cmdbChanges.byType.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${r.count}</td></tr>`).join('')}
  </table>` : ''}
  ${data.cmdbChanges.topAssets.length > 0 ? `
  <p style="margin:0 0 8px 0;font-weight:600;font-size:13px">Most Changed Assets</p>
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden">
    <tr style="background:#f8fafc">
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Asset</th>
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Category</th>
      <th style="text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Changes</th>
    </tr>
    ${data.cmdbChanges.topAssets.map((r, i) => `<tr><td style="${i < data.cmdbChanges.topAssets.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.asset_name)}</td><td style="${i < data.cmdbChanges.topAssets.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.asset_category || '—')}</td><td style="text-align:right;${i < data.cmdbChanges.topAssets.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${r.change_count}</td></tr>`).join('')}
  </table>` : ''}
  ` : '<p style="color:#64748b">No CMDB changes recorded during this period.</p>'}
</td></tr>

<!-- SLA Performance -->
<tr><td style="padding:16px 40px 0">
  <h2 style="margin:0 0 12px 0;font-size:16px;color:#1e293b">SLA Performance</h2>
  ${data.sla.totalWithSla > 0 ? `
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:12px">
    <tr><td style="border-bottom:1px solid #f1f5f9">Tickets with SLA</td><td style="text-align:right;border-bottom:1px solid #f1f5f9;font-weight:600">${data.sla.totalWithSla}</td></tr>
    <tr><td style="border-bottom:1px solid #f1f5f9"><span style="color:#16a34a">&#9679;</span> Met SLA</td><td style="text-align:right;border-bottom:1px solid #f1f5f9;font-weight:600">${data.sla.metSla}</td></tr>
    <tr><td style="border-bottom:1px solid #f1f5f9"><span style="color:#dc2626">&#9679;</span> Breached (Resolved)</td><td style="text-align:right;border-bottom:1px solid #f1f5f9;font-weight:600">${data.sla.breachedResolve}</td></tr>
    <tr><td style="border-bottom:1px solid #f1f5f9"><span style="color:#dc2626">&#9679;</span> Breached (Still Open)</td><td style="text-align:right;border-bottom:1px solid #f1f5f9;font-weight:600">${data.sla.breachedOpen}</td></tr>
    <tr><td><span style="color:#d97706">&#9679;</span> At Risk</td><td style="text-align:right;font-weight:600">${data.sla.atRisk}</td></tr>
  </table>
  ` : '<p style="color:#64748b">No SLA-tracked tickets during this period.</p>'}
  ${data.sla.definitions.length > 0 ? `
  <p style="margin:0 0 8px 0;font-weight:600;font-size:13px">Active SLA Definitions</p>
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden">
    <tr style="background:#f8fafc">
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Name</th>
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Priority</th>
      <th style="text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Response</th>
      <th style="text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Resolve</th>
    </tr>
    ${data.sla.definitions.map((d, i) => `<tr><td style="${i < data.sla.definitions.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(d.name)}</td><td style="${i < data.sla.definitions.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(d.priority || '—')}</td><td style="text-align:right;${i < data.sla.definitions.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${fmtMin(d.response_time_minutes)}</td><td style="text-align:right;${i < data.sla.definitions.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${fmtMin(d.resolve_time_minutes)}</td></tr>`).join('')}
  </table>` : ''}
</td></tr>

<!-- AI Insights -->
${data.aiInsights.length > 0 ? `
<tr><td style="padding:16px 40px 0">
  <h2 style="margin:0 0 12px 0;font-size:16px;color:#1e293b">AI Insights</h2>
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;font-size:12px">
    <tr style="background:#f8fafc">
      <th style="text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Type</th>
      <th style="text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Title</th>
      <th style="text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Severity</th>
      <th style="text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Status</th>
    </tr>
    ${data.aiInsights.map((r, i) => `<tr><td style="${i < data.aiInsights.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.insight_type)}</td><td style="${i < data.aiInsights.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.title)}</td><td style="${i < data.aiInsights.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}"><span style="color:${r.severity === 'critical' ? '#dc2626' : r.severity === 'high' ? '#ea580c' : r.severity === 'medium' ? '#d97706' : '#16a34a'}">${esc(r.severity)}</span></td><td style="${i < data.aiInsights.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.status)}</td></tr>`).join('')}
  </table>
</td></tr>` : ''}

<!-- Activity Leaderboards -->
${data.topRequesters.length > 0 ? `
<tr><td style="padding:16px 40px 0">
  <h2 style="margin:0 0 12px 0;font-size:16px;color:#1e293b">Most Active Customers</h2>
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden">
    <tr style="background:#f8fafc">
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Customer</th>
      <th style="text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Tickets</th>
    </tr>
    ${data.topRequesters.map((r, i) => `<tr><td style="${i < data.topRequesters.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.full_name || r.username)}</td><td style="text-align:right;${i < data.topRequesters.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${r.ticket_count}</td></tr>`).join('')}
  </table>
</td></tr>` : ''}

${data.mostActiveTickets.length > 0 ? `
<tr><td style="padding:16px 40px 0">
  <h2 style="margin:0 0 12px 0;font-size:16px;color:#1e293b">Most Active Tickets</h2>
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;font-size:12px">
    <tr style="background:#f8fafc">
      <th style="text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">#</th>
      <th style="text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Title</th>
      <th style="text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Status</th>
      <th style="text-align:right;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Activities</th>
    </tr>
    ${data.mostActiveTickets.map((r, i) => `<tr><td style="${i < data.mostActiveTickets.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${r.id}</td><td style="${i < data.mostActiveTickets.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.title)}</td><td style="${i < data.mostActiveTickets.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}"><span style="color:${statusColor[r.status] || '#6b7280'}">${esc(r.status)}</span></td><td style="text-align:right;${i < data.mostActiveTickets.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${r.activity_count}</td></tr>`).join('')}
  </table>
</td></tr>` : ''}

${data.mostActiveCmdb.length > 0 ? `
<tr><td style="padding:16px 40px 0">
  <h2 style="margin:0 0 12px 0;font-size:16px;color:#1e293b">Most Active CMDB Assets</h2>
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden">
    <tr style="background:#f8fafc">
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Asset</th>
      <th style="text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Category</th>
      <th style="text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">Tickets</th>
    </tr>
    ${data.mostActiveCmdb.map((r, i) => `<tr><td style="${i < data.mostActiveCmdb.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.asset_name)}</td><td style="${i < data.mostActiveCmdb.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${esc(r.asset_category || '—')}</td><td style="text-align:right;${i < data.mostActiveCmdb.length - 1 ? 'border-bottom:1px solid #f1f5f9' : ''}">${r.ticket_count}</td></tr>`).join('')}
  </table>
</td></tr>` : ''}

<!-- System Monitoring -->
${data.systemSummary.total > 0 ? `
<tr><td style="padding:16px 40px 0">
  <h2 style="margin:0 0 12px 0;font-size:16px;color:#1e293b">System Monitoring</h2>
  <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden">
    <tr><td style="border-bottom:1px solid #f1f5f9">System Tickets Created</td><td style="text-align:right;border-bottom:1px solid #f1f5f9;font-weight:600">${data.systemSummary.total}</td></tr>
    <tr><td>Auto-Resolved</td><td style="text-align:right;font-weight:600">${data.systemSummary.autoResolved}</td></tr>
  </table>
</td></tr>` : ''}

<!-- Footer -->
<tr><td style="padding:24px 40px 32px;border-top:1px solid #e2e8f0;margin-top:16px">
  <p style="margin:0;font-size:11px;color:#94a3b8;text-align:center">
    Generated on ${new Date(generatedAt).toLocaleString('en-AU', { dateStyle: 'long', timeStyle: 'short' })} &bull; ServiFlow Monthly Report
  </p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}

module.exports = {
  aggregateMonthlyData,
  renderReportHTML,
};
