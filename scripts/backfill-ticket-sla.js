#!/usr/bin/env node
/**
 * Backfill Ticket SLA Migration
 *
 * Applies SLA to existing tickets that don't have sla_definition_id set.
 * Uses the same SLA resolution logic as ticket creation.
 *
 * Usage:
 *   node scripts/backfill-ticket-sla.js              # Dry run (shows what would change)
 *   node scripts/backfill-ticket-sla.js --execute    # Actually make changes
 */

require('dotenv').config();
const { getTenantConnection, getMasterConnection, closeAllConnections } = require('../config/database');
const { resolveApplicableSLA } = require('../services/sla-selector');
const { computeInitialDeadlines } = require('../services/sla-calculator');

const DRY_RUN = !process.argv.includes('--execute');

async function backfillTicketSLA(tenantCode) {
  console.log(`\n📋 Processing tenant: ${tenantCode}`);

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Find tickets without SLA
    const [tickets] = await connection.query(`
      SELECT t.id, t.title, t.requester_id, t.category, t.created_at,
             u.email as requester_email
      FROM tickets t
      LEFT JOIN users u ON t.requester_id = u.id
      WHERE t.sla_definition_id IS NULL
      ORDER BY t.id DESC
    `);

    console.log(`   Found ${tickets.length} tickets without SLA`);

    if (tickets.length === 0) {
      return { tenant: tenantCode, updated: 0, skipped: false };
    }

    // Show sample
    console.log(`\n   Sample tickets to update:`);
    tickets.slice(0, 5).forEach(t => {
      console.log(`     #${t.id}: "${t.title.substring(0, 40)}..." (requester: ${t.requester_email || 'unknown'})`);
    });
    if (tickets.length > 5) {
      console.log(`     ... and ${tickets.length - 5} more`);
    }

    if (DRY_RUN) {
      console.log(`\n   🔍 DRY RUN - No changes made. Run with --execute to apply changes.`);
      return { tenant: tenantCode, updated: 0, wouldUpdate: tickets.length, skipped: false };
    }

    // Process tickets in batches
    let totalUpdated = 0;
    let totalFailed = 0;

    for (const ticket of tickets) {
      try {
        // Resolve SLA for this ticket
        const { slaId, source: slaSource } = await resolveApplicableSLA({
          tenantCode,
          ticketPayload: {
            requester_id: ticket.requester_id,
            category: ticket.category
          }
        });

        if (!slaId) {
          // No SLA found - skip
          continue;
        }

        // Fetch full SLA definition
        const [slaRows] = await connection.query(
          `SELECT s.*, b.timezone, b.days_of_week, b.start_time, b.end_time, b.is_24x7
           FROM sla_definitions s
           LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
           WHERE s.id = ? AND s.is_active = 1`,
          [slaId]
        );

        if (slaRows.length === 0) continue;

        const sla = slaRows[0];

        // Calculate deadlines based on ticket creation time
        const createdAt = new Date(ticket.created_at);
        const deadlines = computeInitialDeadlines(sla, createdAt);

        // Update the ticket
        await connection.query(
          `UPDATE tickets SET
             sla_definition_id = ?,
             sla_source = ?,
             sla_applied_at = ?,
             response_due_at = ?,
             resolve_due_at = ?
           WHERE id = ?`,
          [sla.id, slaSource, createdAt, deadlines.response_due_at, deadlines.resolve_due_at, ticket.id]
        );

        totalUpdated++;

        // Progress every 100 tickets
        if (totalUpdated % 100 === 0) {
          console.log(`   Progress: ${totalUpdated} tickets updated...`);
        }
      } catch (ticketError) {
        console.error(`   ❌ Error updating ticket #${ticket.id}:`, ticketError.message);
        totalFailed++;
      }
    }

    console.log(`   ✅ Updated ${totalUpdated} tickets with SLA (${totalFailed} failed)`);
    return { tenant: tenantCode, updated: totalUpdated, failed: totalFailed, skipped: false };

  } catch (error) {
    console.error(`   ❌ Error processing tenant ${tenantCode}:`, error.message);
    return { tenant: tenantCode, updated: 0, error: error.message };
  } finally {
    if (connection) connection.release();
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║           Backfill Ticket SLA Migration                   ║');
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
      const result = await backfillTicketSLA(tenant.tenant_code);
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
        console.log(`  ${r.tenant}: Skipped`);
      } else if (DRY_RUN && r.wouldUpdate > 0) {
        console.log(`  ${r.tenant}: Would update ${r.wouldUpdate} tickets`);
        totalWouldUpdate += r.wouldUpdate;
      } else if (r.updated > 0) {
        console.log(`  ${r.tenant}: Updated ${r.updated} tickets${r.failed ? ` (${r.failed} failed)` : ''}`);
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
