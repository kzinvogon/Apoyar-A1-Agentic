/**
 * Monthly Report Scheduler
 * Auto-sends monthly reports to configured recipients on the configured day.
 * Follows the housekeeping.js scheduler pattern.
 */

const { masterQuery, tenantQuery, closeTenantPool, getOpenTenantCodes } = require('../config/database');
const { sendEmail } = require('../config/email');
const { aggregateMonthlyData, renderReportHTML } = require('./report-generator');

let schedulerTimeout = null;
let schedulerInterval = null;

// ---------------------------------------------------------------------------
// Check interval: once daily at 4 AM (1 hour after housekeeping)
// ---------------------------------------------------------------------------
const CHECK_HOUR = 4;

/**
 * Run the monthly report check for all active tenants.
 */
async function runMonthlyReportCheck() {
  console.log('[ReportScheduler] Starting monthly report check...');

  const poolsBefore = getOpenTenantCodes();
  let tenants;
  try {
    tenants = await masterQuery(
      `SELECT t.tenant_code FROM tenants t WHERE t.status = 'active'`
    );
  } catch (err) {
    console.error('[ReportScheduler] Failed to query tenants:', err.message);
    return;
  }

  const today = new Date();
  const dayOfMonth = today.getDate();

  for (const tenant of tenants) {
    const code = tenant.tenant_code;
    try {
      // Check if auto-send is enabled
      const enabledRows = await tenantQuery(code,
        `SELECT setting_value FROM tenant_settings WHERE setting_key = 'monthly_report_enabled'`
      );
      if (!enabledRows.length || enabledRows[0].setting_value !== 'true') continue;

      // Check send day
      const dayRows = await tenantQuery(code,
        `SELECT setting_value FROM tenant_settings WHERE setting_key = 'monthly_report_send_day'`
      );
      const sendDay = dayRows.length ? parseInt(dayRows[0].setting_value, 10) || 1 : 1;
      if (dayOfMonth !== sendDay) continue;

      // Check if already sent for previous month this cycle
      const prevMonth = today.getMonth() === 0 ? 12 : today.getMonth(); // previous month
      const prevYear = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();

      const alreadySent = await tenantQuery(code,
        `SELECT id FROM report_history WHERE report_type = 'monthly' AND period_month = ? AND period_year = ? AND status IN ('sent', 'partial_failure') LIMIT 1`,
        [prevMonth, prevYear]
      );
      if (alreadySent.length > 0) continue; // already sent

      // Get recipients
      const recipRows = await tenantQuery(code,
        `SELECT setting_value FROM tenant_settings WHERE setting_key = 'monthly_report_recipients'`
      );
      let recipients = [];
      try { recipients = JSON.parse(recipRows[0]?.setting_value || '[]'); } catch { /* ignore */ }
      if (!recipients.length) continue;

      // Get include system tickets setting
      let includeSystem = false;
      try {
        const sysRows = await tenantQuery(code,
          `SELECT setting_value FROM tenant_settings WHERE setting_key = 'monthly_report_include_system_tickets'`
        );
        if (sysRows.length && sysRows[0].setting_value === 'true') includeSystem = true;
      } catch { /* ignore */ }

      // Generate report for previous month
      const start = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
      const endDate = new Date(prevYear, prevMonth, 1);
      const end = endDate.toISOString().slice(0, 10);

      // Get tenant name
      let tenantName = code;
      try {
        const nameRows = await tenantQuery(code,
          `SELECT setting_value FROM tenant_settings WHERE setting_key = 'company_name'`
        );
        if (nameRows.length && nameRows[0].setting_value) tenantName = nameRows[0].setting_value;
      } catch { /* ignore */ }

      const data = await aggregateMonthlyData(code, start, end, null, includeSystem);
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const monthName = monthNames[prevMonth - 1];

      const html = renderReportHTML(data, {
        tenantName,
        month: prevMonth,
        year: prevYear,
        companyName: null,
        generatedAt: new Date().toISOString(),
      });

      const subject = `${tenantName} — Monthly Service Report: ${monthName} ${prevYear}`;

      // Send to each recipient
      const results = [];
      for (const to of recipients) {
        const result = await sendEmail(code, {
          to,
          subject,
          html,
          skipUserCheck: true,
          skipKillSwitch: true,
        });
        results.push({ to, ...result });
      }

      // Record in history
      try {
        await tenantQuery(code, `
          INSERT INTO report_history (report_type, period_month, period_year, recipients_json, ticket_count, cmdb_change_count, sla_compliance_pct, status)
          VALUES ('monthly', ?, ?, ?, ?, ?, ?, ?)
        `, [
          prevMonth, prevYear,
          JSON.stringify(recipients),
          data.summary.total || 0,
          data.cmdbChanges.total || 0,
          data.sla.compliancePct != null ? data.sla.compliancePct : null,
          results.every(r => r.success) ? 'sent' : 'partial_failure',
        ]);
      } catch (err) {
        console.warn(`[ReportScheduler] ${code}: Could not save history:`, err.message);
      }

      const sent = results.filter(r => r.success).length;
      console.log(`[ReportScheduler] ${code}: Sent ${monthName} ${prevYear} report to ${sent}/${recipients.length} recipient(s)`);
    } catch (err) {
      console.error(`[ReportScheduler] ${code}: FAILED —`, err.message);
    }
  }

  // Close pools opened just for this check
  for (const tenant of tenants) {
    const code = tenant.tenant_code.toLowerCase();
    if (!poolsBefore.has(code)) {
      await closeTenantPool(code);
    }
  }

  console.log('[ReportScheduler] Check complete.');
}

/**
 * Start the daily scheduler (runs at 4 AM).
 */
function startScheduler() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(CHECK_HOUR, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const msUntil = next.getTime() - now.getTime();
  const hoursUntil = (msUntil / 3600000).toFixed(1);
  console.log(`[ReportScheduler] Scheduler armed — next check in ${hoursUntil}h (${CHECK_HOUR}:00 AM)`);

  schedulerTimeout = setTimeout(() => {
    runMonthlyReportCheck().catch(err => console.error('[ReportScheduler] Scheduled run failed:', err.message));

    schedulerInterval = setInterval(() => {
      runMonthlyReportCheck().catch(err => console.error('[ReportScheduler] Scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

/**
 * Stop the scheduler (for graceful shutdown).
 */
function stopScheduler() {
  if (schedulerTimeout) { clearTimeout(schedulerTimeout); schedulerTimeout = null; }
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
}

module.exports = {
  runMonthlyReportCheck,
  startScheduler,
  stopScheduler,
};
