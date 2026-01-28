# ServiFlow Ticket Processing – As Built (Code-Referenced)

**Generated:** 2026-01-28
**Repository:** https://github.com/kzinvogon/Apoyar-A1-Agentic

---

## 1) Architecture Overview

ServiFlow uses a **multi-service architecture** for ticket processing to prevent database pool exhaustion and ensure web responsiveness:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   web service   │     │  email-worker   │     │   sla-worker    │
│  (server.js)    │     │ (email-worker.js│     │ (sla-worker.js) │
│                 │     │                 │     │                 │
│ • API routes    │     │ • IMAP polling  │     │ • SLA breach    │
│ • UI serving    │     │ • Ticket create │     │   checking      │
│ • Ticket CRUD   │     │ • Rules trigger │     │ • Notifications │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    MySQL Database                                │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐ │
│  │  a1_master   │  │  a1_tenant_{code} (per-tenant)           │ │
│  │              │  │  • tickets, users, cmdb_items            │ │
│  │  • tenants   │  │  • ticket_processing_rules               │ │
│  │  • plans     │  │  • email_ingest_settings                 │ │
│  └──────────────┘  │  • sla_definitions, notifications        │ │
│                    └──────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Key Design Decisions:**
- Email processing runs in isolated worker with own connection pool (`email-worker.js:51-59`)
- SLA checking runs as separate worker to prevent web blocking (`sla-worker.js:1-21`)
- Connection pools are NOT shared between services (`email-worker.js:11-14`)
- Post-creation triggers (rules, AI, CMDB) are fire-and-forget async

---

## 2) End-to-End Ticket Lifecycle

### Email-Sourced Ticket Flow

| Step | Action | Code Reference |
|------|--------|----------------|
| 1 | email-worker polls IMAP inbox | `email-worker.js:150-167` → `getProcessor()` |
| 2 | Check kill switch `process_emails` | `email-processor.js:183-200` → `isEmailProcessingEnabled()` |
| 3 | Fetch unread emails from [Gmail]/All Mail | `email-processor.js:340-361` |
| 4 | Queue emails, then process sequentially with 2s delay | `email-processor.js:294-322`, `EMAIL_PROCESS_DELAY_MS` at line 271 |
| 5 | Parse monitoring alerts (Nagios/Zabbix patterns) | `email-processor.js:58-152` → `parseMonitoringAlert()` |
| 6 | Classify sender (system vs customer) | `email-processor.js:543-600` → `classifySystemSource()` |
| 7 | Resolve applicable SLA | `sla-selector.js` → `resolveApplicableSLA()` |
| 8 | Calculate SLA deadlines | `sla-calculator.js` → `computeInitialDeadlines()` |
| 9 | INSERT INTO tickets | `email-processor.js:1241-1247` |
| 10 | Fire-and-forget: trigger ticket rules | `routes/tickets.js:45-56` → `triggerTicketRulesAsync()` |
| 11 | Fire-and-forget: trigger CMDB auto-link | `scripts/auto-link-cmdb.js:34-140` → `autoLinkCMDB()` |

### API-Sourced Ticket Flow

| Step | Action | Code Reference |
|------|--------|----------------|
| 1 | POST `/api/tickets/:tenantId` | `routes/tickets.js` (POST handler ~line 860) |
| 2 | Validate input | `middleware/validation.js` → `validateTicketCreate` |
| 3 | Resolve SLA (priority: ticket→user→company→category→cmdb→default) | `routes/tickets.js` calls `resolveApplicableSLA()` |
| 4 | INSERT INTO tickets | `routes/tickets.js` ~line 920 |
| 5 | Send email notification | `routes/tickets.js:978-984` → `sendTicketNotificationEmail()` |
| 6 | Fire-and-forget: Teams notification | `routes/tickets.js:987` → `triggerTeamsNotificationAsync()` |
| 7 | Fire-and-forget: CMDB auto-link | `routes/tickets.js:990-991` → `triggerAutoLink()` |
| 8 | Fire-and-forget: ticket rules | `routes/tickets.js:995` → `triggerTicketRulesAsync()` |
| 9 | Enrich with SLA status | `routes/tickets.js:998` → `enrichTicketWithSLAStatus()` |

---

## 3) Entry Points

### 3.1 Email Ingestion (email-worker)

**Service:** `email-worker.js` (standalone Railway service)

**Polling Interval:**
```javascript
// email-worker.js:35
EMAIL_POLL_INTERVAL_MS=60000   // Default: 1 minute
```

**Gating Flags (Kill Switches):**

| Flag | Location | Check Code |
|------|----------|------------|
| `DISABLE_EMAIL_PROCESSING` | Railway env var (per-service) | `server.js:413-416` |
| `tenant_settings.process_emails` | Tenant DB table | `email-processor.js:183-200` |
| `email_ingest_settings.enabled` | Tenant DB table | `email-processor.js:226-233` |
| `tenants.status` | Master DB | `email-worker.js:137-138` (only `'active'` tenants) |

**Kill Switch Check Code:**
```javascript
// email-processor.js:183-200
async isEmailProcessingEnabled() {
  const [settings] = await connection.query(
    'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
    ['process_emails']
  );
  if (settings.length === 0) return true;  // Default enabled
  return settings[0].setting_value !== 'false';
}
```

**Message → Ticket Mapping:**
```javascript
// email-processor.js:1241-1247
const [result] = await connection.query(
  `INSERT INTO tickets (title, description, status, priority, category, requester_id,
                        sla_deadline, source_metadata, sla_definition_id, sla_source,
                        sla_applied_at, response_due_at, resolve_due_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [title, description, 'open', priority, 'Email', requesterId, ...]
);
```

**Monitoring Alert Parsing:**
```javascript
// email-processor.js:58-152 - parseMonitoringAlert()
// Extracts: host, service, alert_type, state, correlation_key
// Supports: Nagios, Zabbix, Prometheus/Alertmanager patterns
```

### 3.2 UI/API Ticket Creation

**Route:** `POST /api/tickets/:tenantId`
**File:** `routes/tickets.js`
**Auth:** `verifyToken`, `requireRole(['expert', 'admin', 'customer'])`

**Key code:**
```javascript
// routes/tickets.js:45-56 - Fire-and-forget rules
async function triggerTicketRulesAsync(tenantCode, ticketId) {
  try {
    const rulesService = new TicketRulesService(tenantCode);
    const results = await rulesService.executeAllRulesOnTicket(ticketId);
    // ...
  } catch (error) {
    console.error(`[TicketRules] Error executing rules on ticket #${ticketId}:`, error.message);
  }
}
```

### 3.3 Teams Integration

**Files:**
- `teams-connector/src/webhooks/ticketWebhook.js` - Incoming webhooks
- `services/teams-notification.js` - Outbound notifications
- `teams-connector/src/bot/teamsBot.js` - Bot interactions

**Trigger code:**
```javascript
// routes/tickets.js:987
triggerTeamsNotificationAsync('created', tickets[0], tenantCode);
```

---

## 4) Post-Creation Processing

### 4.1 Ticket Rules Execution

**Service:** `services/ticket-rules-service.js`

**Trigger Point:**
```javascript
// routes/tickets.js:995
triggerTicketRulesAsync(tenantCode, ticketId);
```

**Execution Flow:**
```javascript
// ticket-rules-service.js:398-425 - executeAllRulesOnTicket()
async executeAllRulesOnTicket(ticketId) {
  const rules = await this.getAllRules();
  const enabledRules = rules.filter(r => r.enabled);

  for (const rule of enabledRules) {
    const matchingTickets = await this.findMatchingTickets(rule);
    if (matchingIds.includes(ticketIdNum)) {
      const result = await this.executeRuleOnTicket(rule.id, ticketId);
      // ...
    }
  }
}
```

**Available Actions:** (`ticket-rules-service.js:310-349`)
| Action Type | Method | Lines |
|-------------|--------|-------|
| `delete` | `deleteTicket()` | 428-440 |
| `assign_to_expert` | `assignTicket()` | 442-461 |
| `create_for_customer` | `createTicketForCustomer()` | 463-498 |
| `set_priority` | `setPriority()` | 501-518 |
| `set_status` | `setStatus()` | 520-537 |
| `add_tag` | `addTag()` | 539-573 |
| `add_to_monitoring` | `addToMonitoringSources()` | 575-631 |
| `set_sla_deadlines` | `setSlaDeadlines()` | 633-678 |
| `set_sla_definition` | `setSlaDefinition()` | 680-711 |

**Batch Processing Settings:**
```javascript
// ticket-rules-service.js:3-7
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_BATCH_DELAY_SECONDS = 2;
const MIN_BATCH_DELAY_SECONDS = 3;
const MAX_BATCH_SIZE = 10;
```

### 4.2 AI Analysis

**Service:** `services/ai-analysis-service.js`

**Task Taxonomy:**
| Task Type | Model | Use Cases |
|-----------|-------|-----------|
| `triage` | Haiku | ticket_classify, cmdb_autolink, pool_ranking |
| `reasoning` | Sonnet | preview_summary, next_best_action, draft_customer_reply |
| `premium` | Opus | premium_customer_reply |

### 4.3 CMDB Auto-Link

**Script:** `scripts/auto-link-cmdb.js`

**Trigger:**
```javascript
// routes/tickets.js:990-991
if (description && description.trim().length > 10) {
  triggerAutoLink(tenantCode, ticketId, req.user.userId);
}
```

**Confidence Thresholds:**
```javascript
// auto-link-cmdb.js:23-25
const MIN_CONFIDENCE_FOR_SUGGESTION = 0.6;  // 60% - store as ai_suggested
const MIN_CONFIDENCE_FOR_AUTO_LINK = 0.9;   // 90% - auto-apply without review
const AUTO_APPLY_THRESHOLD = 0.95;          // 95% - auto-apply even if manual links exist
```

**Fields Updated:** `ticket_cmdb_relations` table (link_type, confidence, linked_by)

### 4.4 SLA Scheduler Interactions

**Service:** `services/sla-notifier.js` or `sla-worker.js`

**Thresholds:**
```javascript
// sla-worker.js:43-50
const NOTIFICATION_TYPES = {
  RESPONSE_NEAR: 'SLA_RESPONSE_NEAR',       // 85%
  RESPONSE_BREACHED: 'SLA_RESPONSE_BREACHED', // 100%
  RESPONSE_PAST: 'SLA_RESPONSE_PAST',       // 120%
  RESOLVE_NEAR: 'SLA_RESOLVE_NEAR',         // 85%
  RESOLVE_BREACHED: 'SLA_RESOLVE_BREACHED', // 100%
  RESOLVE_PAST: 'SLA_RESOLVE_PAST'          // 120%
};
```

**Kill Switch:**
```javascript
// sla-worker.js:152-167 - isSlaProcessingEnabled()
const [settings] = await connection.query(
  'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
  ['process_sla']
);
if (settings.length === 0) return true;
return settings[0].setting_value !== 'false';
```

---

## 5) Data Model Touchpoints

### Tables Read/Written Per Stage

| Stage | Tables Read | Tables Written |
|-------|-------------|----------------|
| **Email Fetch** | `email_ingest_settings`, `tenant_settings` | `email_ingest_settings.last_checked_at` |
| **Ticket Create** | `users`, `customer_companies`, `sla_definitions`, `category_sla_mappings`, `cmdb_items` | `tickets`, `ticket_activity` |
| **Rules Execute** | `ticket_processing_rules`, `tickets`, `tenant_settings` | `tickets`, `ticket_rule_executions`, `notifications` |
| **CMDB Auto-Link** | `tickets`, `cmdb_items`, `configuration_items`, `ticket_cmdb_relations` | `ticket_cmdb_relations`, `ticket_ai_analysis_log` |
| **SLA Check** | `tickets`, `sla_definitions`, `business_hours_profiles`, `tenant_settings` | `tickets` (notified_*_at columns), `notifications` |

### Key Ticket Table SLA Columns

```sql
-- All present in tickets table schema
sla_definition_id       -- FK to sla_definitions
sla_applied_at          -- When SLA was attached
sla_source              -- 'ticket', 'user', 'company', 'category', 'cmdb', 'default', 'rule'
response_due_at         -- Response SLA deadline
resolve_due_at          -- Resolution SLA deadline
first_responded_at      -- When first response occurred
notified_response_near_at
notified_response_breached_at
notified_response_past_at
notified_resolve_near_at
notified_resolve_breached_at
notified_resolve_past_at
```

---

## 6) Connection Pool Usage Audit

### 6.1 Web Service (`db/pool.js`)

**Pool Configuration:**
```javascript
// db/pool.js:49-60
const POOL_CONFIG = {
  connectionLimit: CONFIGURED_POOL_LIMIT,  // Default: 8
  waitForConnections: true,
  queueLimit: 0,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  idleTimeout: 60000,
  maxIdle: Math.min(4, CONFIGURED_POOL_LIMIT),
};
```

**Recommended Methods (auto-release):**
- `masterQuery(sql, params)` - `db/pool.js:370-400`
- `tenantQuery(tenantCode, sql, params)` - `db/pool.js:451-481`
- `tenantTransaction(tenantCode, callback)` - `db/pool.js:486-501`

### 6.2 Email Worker Service (`email-worker.js`)

**Isolated Pool Configuration:**
```javascript
// email-worker.js:51-59
const WORKER_POOL_CONFIG = {
  connectionLimit: parseInt(process.env.EMAIL_WORKER_POOL_LIMIT || '3', 10),
  waitForConnections: true,
  queueLimit: 10,  // Limited queue to fail fast
  connectTimeout: 15000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  idleTimeout: 30000,
};
```

### 6.3 Connection Release Audit

**`services/ticket-rules-service.js`** - All functions now have proper try/finally release:

| Function | Line | Has `finally { connection.release() }` |
|----------|------|----------------------------------------|
| `getAllRules()` | 72-93 | ✅ Yes (line 90-92) |
| `getRuleById()` | 96-119 | ✅ Yes (line 116-118) |
| `createRule()` | 122-159 | ✅ Yes (line 156-158) |
| `updateRule()` | 162-204 | ✅ Yes (line 201-203) |
| `deleteRule()` | 207-223 | ✅ Yes (line 220-222) |
| `testRule()` | 226-242 | ✅ Yes (line 239-241) |
| `findMatchingTickets()` | 245-290 | ✅ Yes (line 287-289) |
| `executeRuleOnTicket()` | 293-396 | ✅ Yes (line 393-395) |
| `deleteTicket()` | 428-440 | ✅ Yes (line 437-439) |
| `assignTicket()` | 442-461 | ✅ Yes (line 458-460) |
| `createTicketForCustomer()` | 463-498 | ✅ Yes (line 495-497) |
| `setPriority()` | 501-518 | ✅ Yes (line 515-517) |
| `setStatus()` | 520-537 | ✅ Yes (line 534-536) |
| `addTag()` | 539-573 | ✅ Yes (line 570-572) |
| `addToMonitoringSources()` | 575-631 | ✅ Yes (line 628-630) |
| `setSlaDeadlines()` | 633-678 | ✅ Yes (line 675-677) |
| `setSlaDefinition()` | 680-711 | ✅ Yes (line 708-710) |
| `getRuleExecutionHistory()` | 714-731 | ✅ Yes (line 728-730) |
| `getRuleStatistics()` | 734-763 | ✅ Yes (line 760-762) |
| `runRuleInBackground()` | 768-947 | ✅ Yes (multiple: 793-795, 913-915, 935) |

**`services/email-processor.js`** - Connection handling:

| Method | Connection Pattern | Safe? |
|--------|-------------------|-------|
| `processEmails()` | try/finally at line 252-254 | ✅ Yes |
| `fetchEmailsViaIMAP()` | Uses passed connection | ✅ Yes |
| `processEmail()` | Uses passed connection | ✅ Yes |

**`sla-worker.js`** - Connection handling:

| Function | Line | Has `finally { connection.release() }` |
|----------|------|----------------------------------------|
| `processTenant()` | 172-269 | ✅ Yes (line 267) |
| `shouldProcessTenant()` | 274-294 | ✅ Yes (line 284) |
| `runOnce()` | 299-347 | ✅ Yes (line 345) |
| `runDaemon()` → `runCycle()` | 355-412 | ✅ Yes (line 400) |

**`scripts/auto-link-cmdb.js`** - Connection handling:

| Function | Line | Has `finally { connection.release() }` |
|----------|------|----------------------------------------|
| `autoLinkCMDB()` | 34-141 | ✅ Yes (line 139) |

---

## 7) Observability & Proof

### Log Lines by Stage

| Stage | Log Pattern | File:Line |
|-------|-------------|-----------|
| Email worker start | `[EMAIL-WORKER] Starting...` | `email-worker.js:199` |
| Polling tenants | `[EMAIL-WORKER] Processing emails for N tenant(s)` | `email-worker.js:180` |
| IMAP connect | `✅ IMAP connected for tenant:` | `email-processor.js:337` |
| Email found | `📧 Found N new email(s) for tenant:` | `email-processor.js:361` |
| Email queued | `📨 Queued email #N:` | `email-processor.js:390` |
| Processing queue | `📋 Processing queue of N email(s) sequentially...` | `email-processor.js:300` |
| Ticket created | `✅ Created ticket #N` | `email-processor.js:1280+` |
| Rules executed | `[TicketRules] Executed N rule(s) on ticket #N:` | `routes/tickets.js:50-51` |
| SLA notification | `[SLA-WORKER] tenant: N tickets, N notifications` | `sla-worker.js:332-333` |
| Kill switch active | `🔴 KILL SWITCH: Email processing is disabled` | `email-processor.js:215` |
| Pool exhaustion | `[POOL] ⚠️ Pool queue growing - possible exhaustion` | `db/pool.js:112` |

### Grep Commands for Log Verification

```bash
# 1. Verify email-worker is running
grep -E "\[EMAIL-WORKER\] (Starting|Processing emails)" logs.json | head -20

# 2. Verify tickets being created from email
grep -E "Created ticket #[0-9]+" logs.json | head -20

# 3. Check for kill switch activations
grep -E "KILL SWITCH" logs.json

# 4. Check for pool exhaustion warnings
grep -E "\[POOL\].*exhaustion|queueWarnings" logs.json

# 5. Verify rules execution
grep -E "\[TicketRules\] (Executed|Error executing)" logs.json | head -20
```

---

## 8) Verification Checklist

### Kill Switch Tests

| Test | Steps | Expected |
|------|-------|----------|
| **Disable email processing (env)** | Set `DISABLE_EMAIL_PROCESSING=true` on web service | Log: `Email processing disabled (DISABLE_EMAIL_PROCESSING=true)` |
| **Disable email processing (DB)** | `UPDATE tenant_settings SET setting_value='false' WHERE setting_key='process_emails'` | Log: `🔴 KILL SWITCH: Email processing is disabled` |
| **Disable email ingest (DB)** | `UPDATE email_ingest_settings SET enabled=0` | Log: `Email ingest not enabled for tenant:` |
| **Disable SLA scheduler (env)** | Set `DISABLE_SLA_SCHEDULER=true` on web service | Log: `SLA scheduler disabled (DISABLE_SLA_SCHEDULER=true)` |
| **Disable SLA processing (DB)** | `UPDATE tenant_settings SET setting_value='false' WHERE setting_key='process_sla'` | Log: `🔴 KILL SWITCH: SLA processing is disabled` |
| **Suspend tenant** | `UPDATE tenants SET status='suspended' WHERE tenant_code='X'` | Tenant excluded from all processing loops |

### End-to-End Email Processing Test

1. Send test email to configured inbox
2. Wait for poll interval (default 60s)
3. Verify in logs:
   - `[EMAIL-WORKER] Processing emails for N tenant(s)`
   - `📧 Found N new email(s)`
   - `📨 Queued email #N:`
   - `✅ Created ticket #N`
4. Verify in database:
   - `SELECT * FROM tickets ORDER BY id DESC LIMIT 1`
   - Check `source_metadata` contains email info
5. Verify rules fired:
   - `SELECT * FROM ticket_rule_executions ORDER BY id DESC LIMIT 5`

---

## 9) System Control Kill Switch Wiring

This section documents the complete end-to-end wiring for each kill switch: Admin UI → API endpoint → backend handler → database write → worker read.

### 9.1 `process_emails` Kill Switch (Email Processing)

**Purpose:** Disable inbound email-to-ticket processing at the tenant level.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ADMIN UI                                                                     │
│ File: A1 Support Build from here .html                                       │
│ Location: System Control panel (line 5414)                                   │
│ Element: <input type="checkbox" id="sc-process-emails"                       │
│          onchange="toggleSystemSetting('process_emails', this.checked)">     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ API ENDPOINT                                                                 │
│ Route: POST /api/tickets/settings/:tenantId                                  │
│ File: routes/tickets.js:426-452                                              │
│ Auth: verifyToken (any authenticated user)                                   │
│                                                                              │
│ Request Payload:                                                             │
│   { "key": "process_emails", "value": "false" }                              │
│   or                                                                         │
│   { "key": "process_emails", "value": "true" }                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ BACKEND HANDLER                                                              │
│ File: routes/tickets.js:438-443                                              │
│                                                                              │
│   await connection.query(                                                    │
│     `INSERT INTO tenant_settings (setting_key, setting_value) VALUES (?, ?)  │
│      ON DUPLICATE KEY UPDATE setting_value = ?`,                             │
│     [key, value, value]                                                      │
│   );                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ DATABASE WRITE                                                               │
│ Table: a1_tenant_{code}.tenant_settings                                      │
│ Row: setting_key = 'process_emails', setting_value = 'false' or 'true'       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ EMAIL-WORKER READ                                                            │
│ File: services/email-processor.js:183-200                                    │
│ Method: isEmailProcessingEnabled()                                           │
│                                                                              │
│   const [settings] = await connection.query(                                 │
│     'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',       │
│     ['process_emails']                                                       │
│   );                                                                         │
│   if (settings.length === 0) return true;  // Default: enabled               │
│   return settings[0].setting_value !== 'false';                              │
│                                                                              │
│ Called from: processEmails() at line 213-217                                 │
│   if (!processingEnabled) {                                                  │
│     console.log(`🔴 KILL SWITCH: Email processing is disabled...`);          │
│     return;                                                                  │
│   }                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 9.2 `process_sla` Kill Switch (SLA Breach Checking)

**Purpose:** Disable SLA breach checking and notifications at the tenant level.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ADMIN UI                                                                     │
│ File: A1 Support Build from here .html                                       │
│ Location: System Control panel (line 5428)                                   │
│ Element: <input type="checkbox" id="sc-process-sla"                          │
│          onchange="toggleSystemSetting('process_sla', this.checked)">        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ API ENDPOINT                                                                 │
│ Route: POST /api/tickets/settings/:tenantId                                  │
│ File: routes/tickets.js:426-452                                              │
│ Auth: verifyToken (any authenticated user)                                   │
│                                                                              │
│ Request Payload:                                                             │
│   { "key": "process_sla", "value": "false" }                                 │
│   or                                                                         │
│   { "key": "process_sla", "value": "true" }                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ BACKEND HANDLER                                                              │
│ File: routes/tickets.js:438-443                                              │
│ (Same handler as process_emails - generic tenant_settings upsert)            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ DATABASE WRITE                                                               │
│ Table: a1_tenant_{code}.tenant_settings                                      │
│ Row: setting_key = 'process_sla', setting_value = 'false' or 'true'          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ SLA-WORKER READ                                                              │
│ File: sla-worker.js:152-167                                                  │
│ Method: isSlaProcessingEnabled()                                             │
│                                                                              │
│   const [settings] = await connection.query(                                 │
│     'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',       │
│     ['process_sla']                                                          │
│   );                                                                         │
│   if (settings.length === 0) return true;  // Default: enabled               │
│   return settings[0].setting_value !== 'false';                              │
│                                                                              │
│ Called from: processTenant() at line 177-180                                 │
│   if (!processingEnabled) {                                                  │
│     console.log(`🔴 KILL SWITCH: SLA processing is disabled...`);            │
│     return;                                                                  │
│   }                                                                          │
│                                                                              │
│ Also read by: services/sla-notifier.js:192 (same pattern)                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 9.3 `email_ingest_settings.enabled` Kill Switch (IMAP Connection)

**Purpose:** Completely disable IMAP email fetching for a tenant (different from process_emails which controls ticket creation).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ADMIN UI (Option 1: Email Ingest Settings Panel)                             │
│ File: A1 Support Build from here .html                                       │
│ Location: Admin Settings → Email Ingest (line 4275)                          │
│ Element: <input type="checkbox" id="email-ingest-enabled">                   │
│ Handler: saveEmailIngestSettings() at line 11887                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ API ENDPOINT                                                                 │
│ Route: PUT /api/email-ingest/:tenantId/settings                              │
│ File: routes/email-ingest.js:83-141                                          │
│ Auth: verifyToken + requireRole(['admin'])                                   │
│                                                                              │
│ Request Payload:                                                             │
│   {                                                                          │
│     "enabled": false,        // The kill switch                              │
│     "server_type": "imap",                                                   │
│     "server_host": "imap.gmail.com",                                         │
│     "server_port": 993,                                                      │
│     "use_ssl": true,                                                         │
│     "username": "support@example.com",                                       │
│     "password": "******",                                                    │
│     "check_interval_minutes": 5                                              │
│   }                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ BACKEND HANDLER                                                              │
│ File: routes/email-ingest.js:118-130                                         │
│                                                                              │
│   await connection.query(`                                                   │
│     UPDATE email_ingest_settings SET                                         │
│       enabled = COALESCE(?, enabled),                                        │
│       ...                                                                    │
│     WHERE id = ?                                                             │
│   `, [enabled, ...]);                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ DATABASE WRITE                                                               │
│ Table: a1_tenant_{code}.email_ingest_settings                                │
│ Column: enabled (TINYINT 0 or 1)                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ EMAIL-WORKER READ                                                            │
│ File: services/email-processor.js:226-233                                    │
│ Location: processEmails() method                                             │
│                                                                              │
│   const [settings] = await connection.query(                                 │
│     'SELECT * FROM email_ingest_settings WHERE enabled = TRUE LIMIT 1'       │
│   );                                                                         │
│                                                                              │
│   if (settings.length === 0) {                                               │
│     console.log(`Email ingest not enabled for tenant: ${this.tenantCode}`);  │
│     return;                                                                  │
│   }                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Alternative Admin UI Path (Raw Variables):**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ADMIN UI (Option 2: Raw Variables Panel)                                     │
│ File: A1 Support Build from here .html                                       │
│ Location: Raw Variables → email_ingest section (line 4962)                   │
│ Key: email_ingest.enabled                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ API ENDPOINT                                                                 │
│ Route: PUT /api/raw-variables/:tenantId/:key                                 │
│ File: routes/raw-variables.js:174-304                                        │
│ Auth: verifyToken + requireRole(['admin'])                                   │
│                                                                              │
│ Request: PUT /api/raw-variables/apoyar/email_ingest.enabled                  │
│ Payload: { "value": "false" }                                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ BACKEND HANDLER                                                              │
│ File: routes/raw-variables.js:186-229                                        │
│                                                                              │
│   if (key.startsWith('email_ingest.')) {                                     │
│     const field = key.replace('email_ingest.', '');  // 'enabled'            │
│     let dbValue = value === 'true' || value === true;  // Convert to bool    │
│     await connection.query(                                                  │
│       `UPDATE email_ingest_settings SET ${fieldMap[field]} = ?`,             │
│       [dbValue]                                                              │
│     );                                                                       │
│   }                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 9.4 Environment Variable Kill Switches (Service-Level)

These are set per-Railway-service and checked at startup or on each processing cycle.

| Env Var | Service | Check Location | Effect |
|---------|---------|----------------|--------|
| `DISABLE_EMAIL_PROCESSING=true` | web | `server.js:413-416` | Skips `startEmailProcessing()` call |
| `DISABLE_SLA_SCHEDULER=true` | web | `server.js:455-457` | Skips `startScheduler()` call |

**Server.js startup check:**
```javascript
// server.js:413-416
const shouldRunEmailProcessing = process.env.DISABLE_EMAIL_PROCESSING !== 'true';
if (!shouldRunEmailProcessing) {
  console.log('ℹ️  Email processing disabled (DISABLE_EMAIL_PROCESSING=true)');
}

// server.js:455-457
if (process.env.DISABLE_SLA_SCHEDULER === 'true') {
  console.log('ℹ️  SLA scheduler disabled (DISABLE_SLA_SCHEDULER=true)');
}
```

---

### 9.5 Summary: Kill Switch Matrix

| Kill Switch | UI Location | API Route | Backend File:Lines | DB Table.Column | Worker Read File:Lines |
|-------------|-------------|-----------|-------------------|-----------------|----------------------|
| `process_emails` | System Control toggle | `POST /api/tickets/settings/:tenantId` | `routes/tickets.js:438-443` | `tenant_settings.setting_value` | `email-processor.js:183-200` |
| `process_sla` | System Control toggle | `POST /api/tickets/settings/:tenantId` | `routes/tickets.js:438-443` | `tenant_settings.setting_value` | `sla-worker.js:152-167` |
| `email_ingest.enabled` | Email Ingest panel OR Raw Variables | `PUT /api/email-ingest/:tenantId/settings` OR `PUT /api/raw-variables/:tenantId/email_ingest.enabled` | `routes/email-ingest.js:118-130` OR `routes/raw-variables.js:186-229` | `email_ingest_settings.enabled` | `email-processor.js:226-233` |
| `DISABLE_EMAIL_PROCESSING` | Railway env vars | N/A (env var) | `server.js:413-416` | N/A | N/A (startup only) |
| `DISABLE_SLA_SCHEDULER` | Railway env vars | N/A (env var) | `server.js:455-457` | N/A | N/A (startup only) |
| `tenants.status` | Master Admin panel | `PUT /api/master/tenants/:id` | `routes/master.js` | `a1_master.tenants.status` | `email-worker.js:137-138`, `sla-worker.js:306-308` |

---

## Known Risks / Open Questions

### Risks

1. **No MAX_TENANT_POOLS limit** - `db/pool.js:23-24` notes tenant pools are not capped. With many tenants, total connections = `WEB_POOL_LIMIT × N_tenants` could exhaust MySQL max_connections.

2. **Fire-and-forget errors are swallowed** - `triggerTicketRulesAsync()` and `triggerAutoLink()` catch and log errors but don't retry or alert. Failed post-creation processing is silent.

3. **Email-worker stuck state** - If `isProcessing` flag is set and process crashes mid-email, the flag remains true until restart. Logs show "Email processing already in progress" indefinitely.

4. **Case sensitivity in tenant codes** - Recently fixed in `db/pool.js:272-273` to normalize to lowercase, but other code paths may still pass mixed-case codes.

5. **No dead-letter queue for failed emails** - Emails that fail processing are logged but not retried or stored for later analysis.

### Open Questions

1. **Teams integration ticket creation path** - `teams-connector/src/webhooks/ticketWebhook.js` exists but wasn't fully traced. Does it go through the same post-creation pipeline?

2. **Slack connector** - `slack-connector/` directory exists. Is it active? What triggers does it have?

3. **Pool ranking frequency** - `services/pool-ranking-service.js` mentions 5-minute updates. Is this running? Where is it scheduled?

4. **AI analysis billing** - Claude API calls for CMDB auto-link, KB generation, pool ranking. What's the cost per ticket? Any rate limiting?

---

*Document generated by code analysis. All claims are backed by specific file:line references.*
