#!/usr/bin/env node
/**
 * Fix tickets that were classified with the removed 'tenant_domain' reason.
 *
 * Usage:
 *   node scripts/fix-tenant-domain-reason.js <tenantCode> [--dry-run]
 *
 * This script finds tickets with source_metadata.reason = 'tenant_domain'
 * and updates them to 'legacy_tenant_domain' to indicate they were created
 * under the old classification system.
 */

const { getTenantConnection } = require('../config/database');

async function fixTenantDomainReason(tenantCode, dryRun = false) {
  console.log(`\n=== Fix tenant_domain reason for tenant: ${tenantCode} ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}\n`);

  const connection = await getTenantConnection(tenantCode);

  try {
    // Find tickets with tenant_domain reason
    const [tickets] = await connection.query(`
      SELECT id, title, source_metadata, created_at
      FROM tickets
      WHERE JSON_EXTRACT(source_metadata, '$.reason') = 'tenant_domain'
      ORDER BY id DESC
    `);

    if (tickets.length === 0) {
      console.log('No tickets found with tenant_domain reason.');
      return;
    }

    console.log(`Found ${tickets.length} ticket(s) with tenant_domain reason:\n`);

    for (const ticket of tickets) {
      const metadata = typeof ticket.source_metadata === 'string'
        ? JSON.parse(ticket.source_metadata)
        : ticket.source_metadata;

      console.log(`  #${ticket.id}: ${ticket.title.substring(0, 50)}...`);
      console.log(`    Created: ${ticket.created_at}`);
      console.log(`    Source: ${metadata?.source_email || 'unknown'}`);
      console.log(`    Current reason: ${metadata?.reason}`);

      if (!dryRun) {
        // Update the reason to indicate legacy classification
        const updatedMetadata = {
          ...metadata,
          reason: 'legacy_tenant_domain',
          migrated_at: new Date().toISOString(),
          migration_note: 'tenant_domain classification removed in favor of system_senders_allowlist'
        };

        await connection.query(`
          UPDATE tickets
          SET source_metadata = ?
          WHERE id = ?
        `, [JSON.stringify(updatedMetadata), ticket.id]);

        console.log(`    -> Updated to: legacy_tenant_domain`);
      } else {
        console.log(`    -> Would update to: legacy_tenant_domain`);
      }
      console.log('');
    }

    console.log(`\n=== Summary ===`);
    console.log(`Total tickets affected: ${tickets.length}`);
    if (dryRun) {
      console.log(`\nRun without --dry-run to apply changes.`);
    } else {
      console.log(`\nAll tickets updated successfully.`);
    }

  } finally {
    connection.release();
  }
}

// Parse arguments
const args = process.argv.slice(2);
const tenantCode = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!tenantCode) {
  console.error('Usage: node scripts/fix-tenant-domain-reason.js <tenantCode> [--dry-run]');
  process.exit(1);
}

fixTenantDomainReason(tenantCode, dryRun)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
