#!/usr/bin/env node
/**
 * One-time Mailbox Reconciliation Script
 *
 * Compares email_processed_messages between two environments (via export files)
 * and backfills missing tickets by fetching the original email from Graph API
 * and replaying it through processEmail().
 *
 * Usage:
 *   # Step 1: Export processed messages from each environment
 *   node scripts/reconcile-mailbox.js --export --output /tmp/prod-processed.json
 *   node scripts/reconcile-mailbox.js --export --output /tmp/uat-processed.json
 *
 *   # Step 2: Diff against the other environment's export (dry-run)
 *   node scripts/reconcile-mailbox.js --diff /tmp/other-env-processed.json
 *
 *   # Step 3: Backfill missing messages (explicit opt-in)
 *   node scripts/reconcile-mailbox.js --diff /tmp/other-env-processed.json --apply --limit 50
 *
 * Options:
 *   --export              Export this environment's email_processed_messages to JSON
 *   --output <path>       Output file for --export (default: stdout)
 *   --diff <path>         Compare local DB against the other environment's export file
 *   --apply               Actually replay missing messages (default: dry-run)
 *   --limit N             Max messages to replay (default: no limit)
 *   --since YYYY-MM-DD    Only consider messages processed after this date (default: 2026-01-01)
 *   --tenant <code>       Tenant code (default: apoyar)
 */

require('dotenv').config();

const fs = require('fs');
const mysql = require('mysql2/promise');
const { simpleParser } = require('mailparser');
const { EmailProcessor } = require('../services/email-processor');

// ── Parse CLI args ──

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const MODE_EXPORT = hasFlag('--export');
const MODE_DIFF = !!getArg('--diff');
const DIFF_FILE = getArg('--diff');
const OUTPUT_FILE = getArg('--output');
const APPLY = hasFlag('--apply');
const LIMIT = parseInt(getArg('--limit') || '0', 10);
const SINCE = getArg('--since') || '2026-01-01';
const TENANT_CODE = getArg('--tenant') || 'apoyar';

if (!MODE_EXPORT && !MODE_DIFF) {
  console.error('Usage: node scripts/reconcile-mailbox.js --export|--diff <file> [--apply] [--limit N] [--since YYYY-MM-DD]');
  process.exit(1);
}

// ── DB connection (uses same env vars as email-worker) ──

async function createPool() {
  return mysql.createPool({
    host: process.env.MYSQLHOST || 'localhost',
    port: parseInt(process.env.MYSQLPORT || '3306', 10),
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: `a1_tenant_${TENANT_CODE}`,
    connectionLimit: 3,
    waitForConnections: true,
    connectTimeout: 15000,
  });
}

// ── Export mode ──

async function runExport() {
  const pool = await createPool();
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT message_id, result, ticket_id, processed_at
         FROM email_processed_messages
         WHERE processed_at >= ?
         ORDER BY processed_at ASC`,
        [SINCE]
      );

      const output = JSON.stringify({
        environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_SERVICE_NAME || 'local',
        tenant: TENANT_CODE,
        since: SINCE,
        exportedAt: new Date().toISOString(),
        count: rows.length,
        messages: rows.map(r => ({
          message_id: r.message_id,
          result: r.result,
          ticket_id: r.ticket_id,
          processed_at: r.processed_at
        }))
      }, null, 2);

      if (OUTPUT_FILE) {
        fs.writeFileSync(OUTPUT_FILE, output);
        console.log(`Exported ${rows.length} records to ${OUTPUT_FILE}`);
      } else {
        process.stdout.write(output);
      }
    } finally {
      conn.release();
    }
  } finally {
    await pool.end();
  }
}

// ── Diff + optional backfill mode ──

async function runDiff() {
  // Load other environment's export
  if (!fs.existsSync(DIFF_FILE)) {
    console.error(`File not found: ${DIFF_FILE}`);
    process.exit(1);
  }
  const otherData = JSON.parse(fs.readFileSync(DIFF_FILE, 'utf8'));
  console.log(`Loaded ${otherData.count} records from ${otherData.environment} (exported ${otherData.exportedAt})`);

  const pool = await createPool();
  try {
    const conn = await pool.getConnection();
    try {
      // Load local processed messages
      const [localRows] = await conn.query(
        `SELECT message_id, result, ticket_id, processed_at
         FROM email_processed_messages
         WHERE processed_at >= ?`,
        [SINCE]
      );

      // Build lookup maps
      const localMap = new Map();
      for (const r of localRows) {
        localMap.set(r.message_id, r);
      }

      const otherMap = new Map();
      for (const r of otherData.messages) {
        otherMap.set(r.message_id, r);
      }

      // Classify each message_id
      const needsBackfill = [];   // Messages that created tickets in other env but missing/error here
      const bothOk = [];          // Both environments have successful result
      const bothError = [];       // Both environments have error
      const skippedBoth = [];     // Both environments skipped
      const localOnly = [];       // Only in local (other env missing)

      for (const [msgId, otherRow] of otherMap) {
        const localRow = localMap.get(msgId);
        const otherSuccess = ['ticket_created', 'ticket_updated'].includes(otherRow.result);

        if (!localRow) {
          // Missing locally — if it was a ticket in the other env, we need it
          if (otherSuccess) {
            needsBackfill.push({ message_id: msgId, localResult: null, otherResult: otherRow.result });
          }
        } else if (localRow.result === 'error' && otherSuccess) {
          // Local error, other success — needs backfill
          needsBackfill.push({ message_id: msgId, localResult: 'error', otherResult: otherRow.result });
        } else if (['ticket_created', 'ticket_updated'].includes(localRow.result) && otherSuccess) {
          bothOk.push(msgId);
        } else if (localRow.result === 'error' && otherRow.result === 'error') {
          bothError.push(msgId);
        } else {
          skippedBoth.push(msgId);
        }
      }

      // Messages only in local (not in other env export)
      for (const [msgId] of localMap) {
        if (!otherMap.has(msgId)) {
          localOnly.push(msgId);
        }
      }

      // Summary
      console.log('\n══════════════════════════════════════════════════');
      console.log('  RECONCILIATION SUMMARY');
      console.log('══════════════════════════════════════════════════');
      console.log(`  Since:                  ${SINCE}`);
      console.log(`  Local records:          ${localRows.length}`);
      console.log(`  Other env records:      ${otherData.count}`);
      console.log('──────────────────────────────────────────────────');
      console.log(`  Both OK (no action):    ${bothOk.length}`);
      console.log(`  Both skipped:           ${skippedBoth.length}`);
      console.log(`  Both errored:           ${bothError.length}`);
      console.log(`  Local only:             ${localOnly.length}`);
      console.log(`  NEEDS BACKFILL:         ${needsBackfill.length}`);
      console.log('══════════════════════════════════════════════════\n');

      if (needsBackfill.length === 0) {
        console.log('Nothing to backfill — environments are in sync for this window.');
        return;
      }

      // List what needs backfill
      const toProcess = LIMIT > 0 ? needsBackfill.slice(0, LIMIT) : needsBackfill;
      console.log(`Messages to backfill (${toProcess.length}${LIMIT > 0 ? ` of ${needsBackfill.length}, limited by --limit ${LIMIT}` : ''}):\n`);
      for (const item of toProcess) {
        const status = item.localResult === 'error' ? 'error → retry' : 'missing → replay';
        console.log(`  ${item.message_id}  [${status}]`);
      }

      if (!APPLY) {
        console.log('\n⚠️  DRY RUN — no changes made. Use --apply to replay missing messages.');
        return;
      }

      // ── Backfill: fetch from Graph and replay ──
      console.log('\n── Starting backfill ──\n');

      // Get mailbox config (needed for mailbox_id and Graph auth)
      const [settingsRows] = await conn.query(
        'SELECT id, oauth2_email, auth_method FROM email_ingest_settings ORDER BY id ASC LIMIT 1'
      );
      if (settingsRows.length === 0) {
        console.error('No email_ingest_settings row found — cannot backfill.');
        return;
      }
      const mailboxConfig = settingsRows[0];
      const mailboxId = mailboxConfig.id;
      const userEmail = mailboxConfig.oauth2_email;

      if (mailboxConfig.auth_method !== 'oauth2') {
        console.error(`Mailbox auth_method is '${mailboxConfig.auth_method}', not oauth2. Graph fetch not supported.`);
        return;
      }

      // Get Graph API token
      const { getValidAccessToken } = require('../services/oauth2-helper');
      const { accessToken } = await getValidAccessToken(conn, TENANT_CODE);

      // Create EmailProcessor with same context as normal ingestion
      const processor = new EmailProcessor(TENANT_CODE, {
        getConnection: () => pool.getConnection(),
      });

      let backfilled = 0;
      let failed = 0;
      let notFound = 0;

      for (let i = 0; i < toProcess.length; i++) {
        const item = toProcess[i];
        const msgId = item.message_id;
        console.log(`\n[${i + 1}/${toProcess.length}] ${msgId}`);

        try {
          // Fetch Graph message by internetMessageId
          const filterUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/messages?$filter=internetMessageId eq '${encodeURIComponent(msgId)}'&$select=id,internetMessageId`;
          const searchRes = await fetch(filterUrl, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (!searchRes.ok) {
            console.error(`  Graph search failed: ${searchRes.status} ${await searchRes.text()}`);
            failed++;
            continue;
          }
          const searchData = await searchRes.json();
          if (!searchData.value || searchData.value.length === 0) {
            console.log(`  Not found in mailbox (moved/deleted) — skipping`);
            notFound++;
            continue;
          }

          const graphId = searchData.value[0].id;

          // Fetch full MIME
          const mimeRes = await fetch(
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/messages/${graphId}/$value`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (!mimeRes.ok) {
            console.error(`  MIME fetch failed: ${mimeRes.status}`);
            failed++;
            continue;
          }
          const mimeBuffer = Buffer.from(await mimeRes.arrayBuffer());
          const parsed = await simpleParser(mimeBuffer);

          // Build emailData matching normal ingestion format
          const emailData = {
            from: parsed.from?.text || parsed.from?.value?.[0]?.address || '',
            subject: parsed.subject || '(No Subject)',
            body: parsed.text || parsed.html || '(No content)',
            html: parsed.html || '',
            text: parsed.text || '',
            messageId: msgId,
            date: parsed.date || new Date(),
            uid: null,
            inReplyTo: parsed.inReplyTo || null,
            references: parsed.references || [],
            graphMessageId: graphId
          };

          console.log(`  From: ${emailData.from} | Subject: ${emailData.subject}`);

          // Replay through processEmail — same path as normal ingestion
          const procConn = await pool.getConnection();
          try {
            const result = await processor.processEmail(procConn, emailData);

            let resultType = 'ticket_created';
            if (!result.success) {
              if (result.reason === 'bounce_notification_skipped') resultType = 'skipped_bounce';
              else if (result.reason === 'domain_not_found') resultType = 'skipped_domain';
              else if (result.reason === 'skipped_system') resultType = 'skipped_system';
              else resultType = 'error';
            } else if (result.wasReply) {
              resultType = 'ticket_updated';
            }

            // Record processed message (ON DUPLICATE KEY UPDATE handles existing error rows)
            await processor.recordProcessedMessage(
              procConn, mailboxId, msgId, null, result.ticketId || null, resultType
            );

            if (resultType === 'error') {
              console.log(`  Result: error — ${result.reason || 'unknown'}`);
              failed++;
            } else {
              console.log(`  Result: ${resultType}${result.ticketId ? ` (ticket #${result.ticketId})` : ''}`);
              backfilled++;
            }
          } finally {
            procConn.release();
          }

        } catch (err) {
          console.error(`  Error: ${err.message}`);
          failed++;
        }

        // Rate limit — same as normal processing
        if (i < toProcess.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      console.log('\n══════════════════════════════════════════════════');
      console.log('  BACKFILL COMPLETE');
      console.log('══════════════════════════════════════════════════');
      console.log(`  Backfilled:    ${backfilled}`);
      console.log(`  Not in mailbox: ${notFound}`);
      console.log(`  Failed:        ${failed}`);
      console.log('══════════════════════════════════════════════════');

    } finally {
      conn.release();
    }
  } finally {
    await pool.end();
  }
}

// ── Main ──

(async () => {
  try {
    if (MODE_EXPORT) {
      await runExport();
    } else {
      await runDiff();
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
