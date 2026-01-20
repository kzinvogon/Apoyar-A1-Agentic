#!/usr/bin/env node
/**
 * Fix System Sender Tickets Migration
 *
 * Updates old tickets from system senders to use the system user as requester,
 * so they are properly filtered as "system source" in the ticket pool.
 *
 * Usage:
 *   node scripts/fix-system-sender-tickets.js              # Dry run (shows what would change)
 *   node scripts/fix-system-sender-tickets.js --execute    # Actually make changes
 */

require('dotenv').config();
const { getTenantConnection, getMasterConnection, closeAllConnections } = require('../config/database');

const DRY_RUN = !process.argv.includes('--execute');

async function fixSystemSenderTickets(tenantCode) {
  console.log(`\n📋 Processing tenant: ${tenantCode}`);

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Get system user
    const [systemUsers] = await connection.query(
      "SELECT id FROM users WHERE username = 'system' OR email = 'system@tenant.local' LIMIT 1"
    );

    if (systemUsers.length === 0) {
      console.log(`   ⚠️  No system user found for tenant ${tenantCode}, skipping`);
      return { tenant: tenantCode, updated: 0, skipped: true };
    }

    const systemUserId = systemUsers[0].id;
    console.log(`   System user ID: ${systemUserId}`);

    // Get configured system senders
    const [settings] = await connection.query(
      "SELECT setting_value FROM tenant_settings WHERE setting_key = 'system_senders'"
    );

    let systemSenders = [];
    if (settings.length > 0 && settings[0].setting_value) {
      try {
        systemSenders = JSON.parse(settings[0].setting_value).map(s => s.toLowerCase());
      } catch (e) {
        console.log(`   ⚠️  Could not parse system_senders setting`);
      }
    }

    // Get configured system domains
    const [domainSettings] = await connection.query(
      "SELECT setting_value FROM tenant_settings WHERE setting_key = 'system_domains'"
    );

    let systemDomains = [];
    if (domainSettings.length > 0 && domainSettings[0].setting_value) {
      try {
        systemDomains = JSON.parse(domainSettings[0].setting_value).map(d => d.toLowerCase());
      } catch (e) {
        console.log(`   ⚠️  Could not parse system_domains setting`);
      }
    }

    console.log(`   Configured system senders: ${systemSenders.length > 0 ? systemSenders.join(', ') : '(none)'}`);
    console.log(`   Configured system domains: ${systemDomains.length > 0 ? systemDomains.join(', ') : '(none)'}`);

    if (systemSenders.length === 0 && systemDomains.length === 0) {
      console.log(`   ℹ️  No system senders or domains configured, skipping`);
      return { tenant: tenantCode, updated: 0, skipped: true };
    }

    // Build query to find tickets from system senders that aren't using system user
    let conditions = [];
    let params = [];

    if (systemSenders.length > 0) {
      conditions.push(`LOWER(u.email) IN (${systemSenders.map(() => '?').join(', ')})`);
      params.push(...systemSenders);
    }

    if (systemDomains.length > 0) {
      const domainConditions = systemDomains.map(() => 'LOWER(u.email) LIKE ?');
      conditions.push(`(${domainConditions.join(' OR ')})`);
      params.push(...systemDomains.map(d => `%@${d}`));
    }

    // Find tickets to update
    const query = `
      SELECT t.id, t.title, t.requester_id, u.email as requester_email, t.created_at
      FROM tickets t
      JOIN users u ON t.requester_id = u.id
      WHERE t.requester_id != ?
        AND (${conditions.join(' OR ')})
      ORDER BY t.id
    `;

    const [tickets] = await connection.query(query, [systemUserId, ...params]);

    console.log(`   Found ${tickets.length} tickets to update`);

    if (tickets.length === 0) {
      return { tenant: tenantCode, updated: 0, skipped: false };
    }

    // Show sample of tickets to be updated
    console.log(`\n   Sample tickets to update:`);
    tickets.slice(0, 5).forEach(t => {
      console.log(`     #${t.id}: "${t.title.substring(0, 50)}..." (from: ${t.requester_email})`);
    });
    if (tickets.length > 5) {
      console.log(`     ... and ${tickets.length - 5} more`);
    }

    if (DRY_RUN) {
      console.log(`\n   🔍 DRY RUN - No changes made. Run with --execute to apply changes.`);
      return { tenant: tenantCode, updated: 0, wouldUpdate: tickets.length, skipped: false };
    }

    // Update tickets in batches
    const ticketIds = tickets.map(t => t.id);
    const BATCH_SIZE = 100;
    let totalUpdated = 0;

    for (let i = 0; i < ticketIds.length; i += BATCH_SIZE) {
      const batch = ticketIds.slice(i, i + BATCH_SIZE);

      // Update requester_id to system user
      const [result] = await connection.query(
        `UPDATE tickets SET requester_id = ? WHERE id IN (${batch.map(() => '?').join(', ')})`,
        [systemUserId, ...batch]
      );

      totalUpdated += result.affectedRows;
      console.log(`   Updated batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.affectedRows} tickets`);
    }

    console.log(`   ✅ Updated ${totalUpdated} tickets to use system user`);
    return { tenant: tenantCode, updated: totalUpdated, skipped: false };

  } catch (error) {
    console.error(`   ❌ Error processing tenant ${tenantCode}:`, error.message);
    return { tenant: tenantCode, updated: 0, error: error.message };
  } finally {
    if (connection) connection.release();
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║      Fix System Sender Tickets Migration                  ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'EXECUTE (will modify data)'}              ${DRY_RUN ? '  ' : ''}║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');

  if (DRY_RUN) {
    console.log('\n⚠️  This is a dry run. No changes will be made.');
    console.log('   Run with --execute to apply changes.\n');
  }

  try {
    // Get all active tenants
    const masterConnection = await getMasterConnection();
    const [tenants] = await masterConnection.query(
      "SELECT tenant_code FROM tenants WHERE status = 'active'"
    );
    masterConnection.release();

    console.log(`Found ${tenants.length} active tenants`);

    const results = [];
    for (const tenant of tenants) {
      const result = await fixSystemSenderTickets(tenant.tenant_code);
      results.push(result);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    let totalUpdated = 0;
    let totalWouldUpdate = 0;

    for (const r of results) {
      if (r.error) {
        console.log(`  ${r.tenant}: ERROR - ${r.error}`);
      } else if (r.skipped) {
        console.log(`  ${r.tenant}: Skipped (no system user or senders configured)`);
      } else if (DRY_RUN && r.wouldUpdate > 0) {
        console.log(`  ${r.tenant}: Would update ${r.wouldUpdate} tickets`);
        totalWouldUpdate += r.wouldUpdate;
      } else if (r.updated > 0) {
        console.log(`  ${r.tenant}: Updated ${r.updated} tickets`);
        totalUpdated += r.updated;
      } else {
        console.log(`  ${r.tenant}: No tickets to update`);
      }
    }

    console.log('='.repeat(60));
    if (DRY_RUN) {
      console.log(`Total tickets that would be updated: ${totalWouldUpdate}`);
    } else {
      console.log(`Total tickets updated: ${totalUpdated}`);
    }

  } catch (error) {
    console.error('Fatal error:', error);
  } finally {
    await closeAllConnections();
  }
}

main();
