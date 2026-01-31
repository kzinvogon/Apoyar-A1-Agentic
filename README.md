# Serviflow / Apoyar A1 - Multi-Tenant ITSM Platform

A production multi-tenant IT Service Management platform with AI-powered ticket classification, SLA tracking, CMDB, knowledge base, and multi-channel ticket ingestion.

## Production Architecture

### Multi-Project System

The production system comprises multiple Railway projects working together:

| Project | Repository | Purpose |
|---------|------------|---------|
| **Apoyar Agentic V1** | This repo | Core application (web, email-worker) |
| **Serviflow MYSQL** | N/A (managed DB) | MySQL database hosting |
| **teams_connector** | Separate repo | Microsoft Teams bot integration |
| **Slack Serviflow** | Separate repo | Slack app integration |
| **asset-viewer** | Separate repo | Public CMDB asset viewer |
| **serviflow-marketing** | Separate repo | Marketing site (serviflow.app) |
| **serviflow-redirect** | Separate repo | Domain redirects |

---

## Worker Services

### Services in Apoyar Agentic V1

| Service | Entry Point | Runs As | Purpose |
|---------|-------------|---------|---------|
| **web** | `server.js` | Railway service | Express API + SPA frontend |
| **email-worker** | `services/email-worker.js` | Railway service | IMAP polling, email-to-ticket |
| **sla-notifier** | `services/sla-notifier.js` | In-process (web) | SLA breach notifications |
| **ticket-rules** | `services/ticket-rules-service.js` | In-process (web) | Auto-routing, assignment rules |

### email-worker Service

Dedicated Railway service that polls IMAP mailboxes for new emails.

**Process Flow:**
1. Polls `email_ingest_settings` for enabled mailboxes
2. Connects to IMAP, fetches unread emails
3. Parses sender, subject, body, attachments
4. Matches to tenant by recipient address or domain
5. Calls AI analysis service for classification
6. Creates ticket with `source='email'`, populates classification fields
7. Marks email as read, moves to processed folder
8. Logs to `ai_email_analysis` table

**Configuration (per mailbox):**
- `email_ingest_settings.imap_host`, `imap_port`, `imap_user`, `imap_password`
- `email_ingest_settings.enabled` (0/1)
- `email_ingest_settings.poll_interval_seconds`
- `email_ingest_settings.processed_folder`

**Kill Switches:**
| Level | Setting | Effect |
|-------|---------|--------|
| Global | `DISABLE_EMAIL_PROCESSING=true` (env) | Stops all polling |
| Tenant | `tenant_settings.process_emails = 0` | Skips tenant |
| Mailbox | `email_ingest_settings.enabled = 0` | Skips mailbox |
| Tenant Status | `tenants.status != 'active'` | Skips tenant |

### sla-notifier Service

Runs on interval within the web process to check SLA deadlines.

**Checks:**
- Response SLA approaching (configurable threshold)
- Response SLA breached
- Resolution SLA approaching
- Resolution SLA breached

**Actions:**
- Creates notification records in `notifications` table
- Optionally sends email alerts (if SMTP configured)
- Updates `notified_*_at` timestamps to prevent duplicate alerts

### ticket-rules Service

Executes tenant-defined rules on ticket creation/update.

**Rule Types:**
- Auto-assignment based on category, priority, or keywords
- Auto-tagging based on content
- SLA assignment based on customer or CMDB item
- Escalation triggers

---

## External Integrations

### Microsoft Teams Connector

**Project:** `teams_connector` (separate Railway project)

**Architecture:**
- Node.js Bot Framework application
- Registered as Teams app in Azure AD
- Communicates with Serviflow API via service account

**Flow:**
1. User messages the Teams bot or uses adaptive card
2. Bot parses request, collects required fields
3. Bot calls `POST /api/tickets/:tenant` with service token
4. Ticket created with `source='teams'`
5. Bot sends confirmation card with ticket ID

**Configuration:**
- `MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD` (Azure Bot registration)
- `SERVIFLOW_API_URL`, `SERVIFLOW_SERVICE_TOKEN`
- Tenant mapping (Teams tenant ID → Serviflow tenant code)

### Slack Connector

**Project:** `Slack Serviflow` (separate Railway project)

**Architecture:**
- Node.js Slack Bolt application
- Installed as Slack app in workspaces
- Communicates with Serviflow API via service account

**Flow:**
1. User invokes slash command (`/ticket`) or shortcut
2. App opens modal for ticket details
3. On submit, app calls `POST /api/tickets/:tenant`
4. Ticket created with `source='slack'`
5. App posts confirmation to channel or DM

**Configuration:**
- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`
- `SERVIFLOW_API_URL`, `SERVIFLOW_SERVICE_TOKEN`
- Workspace-to-tenant mapping

### Asset Viewer

**Project:** `asset-viewer` (separate Railway project)

**Purpose:** Public-facing CMDB item viewer for customers without Serviflow login.

**Features:**
- Read-only view of CMDB items
- Filtered by public visibility flag
- QR code scanning for physical asset lookup
- Links back to full Serviflow for authenticated users

---

## AI Processing

### Overview

AI analysis is provided by **Anthropic Claude** models via the `services/ai-analysis-service.js` module. The system uses a tiered model approach based on task complexity.

### Model Tiers

| Tier | Model | Use Cases |
|------|-------|-----------|
| **Triage** | `claude-3-haiku` | Fast, low-cost tasks (classification, auto-linking) |
| **Reasoning** | `claude-3.5-sonnet` | Balanced tasks (summaries, suggested replies) |
| **Premium** | `claude-3-opus` | High-quality output (premium customer replies) |

### AI Tasks

| Task | Tier | Trigger | Output |
|------|------|---------|--------|
| `ticket_classify` | Triage | Email ingestion | Priority, category suggestions |
| `ticket_work_classify` | Triage | Ticket creation | work_type, execution_mode, system_tags |
| `cmdb_autolink` | Triage | Ticket creation | Suggested CMDB item links |
| `pool_ranking` | Triage | Pool refresh | pool_score for prioritization |
| `preview_summary` | Reasoning | On-demand | Ticket summary for preview |
| `next_best_action` | Reasoning | On-demand | Suggested next steps |
| `draft_customer_reply` | Reasoning | On-demand | Draft response to customer |
| `kb_generate` | Reasoning | On-demand | Knowledge base article draft |
| `premium_customer_reply` | Premium | On-demand | High-quality customer response |

### Email Analysis Flow

When an email arrives:

1. **Parse** - Extract sender, subject, body, attachments
2. **Customer Match** - Find/create customer by email address
3. **AI Analysis** - Call `ticket_classify` task:
   - Suggested priority (based on urgency signals)
   - Suggested category
   - Sentiment analysis
   - Key entities extraction
4. **Work Classification** - Call `ticket_work_classify` task:
   - `work_type`: request, incident, problem, change_request, etc.
   - `execution_mode`: automated, human_review, expert_required, etc.
   - `system_tags`: auto-generated tags
   - `classification_confidence`: 0.0-1.0
5. **Ticket Creation** - Create ticket with AI-populated fields
6. **Logging** - Record to `ai_email_analysis` table

### Configuration

**Environment Variables:**
```
AI_API_KEY              # Anthropic API key (sk-ant-...)
AI_MODEL_TRIAGE         # Override triage model (default: claude-3-haiku-20240307)
AI_MODEL_REASONING      # Override reasoning model (default: claude-3-5-sonnet-latest)
AI_MODEL_PREMIUM        # Override premium model (default: claude-3-opus-latest)
```

### Fallback Behavior

If AI is unavailable (no API key, rate limited, error):
- Email tickets created with default priority/category
- `work_type` set to `unknown`, `execution_mode` to `mixed`
- `classification_confidence` set to 0
- System continues without AI enrichment

### Analytics

AI processing metrics available in Analytics dashboard:
- Processing time (avg, p95)
- Success/failure rates
- Model usage by task
- Classification distribution

Stored in `ai_email_analysis` table:
- `processing_time_ms` - Time taken for AI call
- `ai_provider` - anthropic, openai, or pattern
- `ai_model` - Specific model used
- `suggested_priority`, `suggested_category` - AI outputs
- `error_message` - If processing failed

---

## Database

### Connection Details

| Environment | Host | Database Pattern |
|-------------|------|------------------|
| Local | `localhost:3306` | `a1_master`, `a1_tenant_*` |
| UAT | `tramway.proxy.rlwy.net:19355` | Same pattern |
| Production | `tramway.proxy.rlwy.net:19355` | Same pattern (shared MySQL project) |

### Master Database Schema (a1_master)

| Table | Purpose |
|-------|---------|
| `tenants` | Tenant registrations (tenant_code, company_name, status, settings) |
| `master_users` | Super admin accounts |
| `plans` | Subscription plan definitions |
| `tenant_subscriptions` | Active subscriptions per tenant |
| `tenant_admins` | Tenant administrator accounts (legacy) |
| `master_audit_log` | System-wide audit trail |

### Tenant Database Schema (a1_tenant_*)

| Table | Purpose |
|-------|---------|
| **Users & Auth** | |
| `users` | All tenant users (admin, expert, customer roles) |
| `customers` | Customer profile extensions |
| `customer_companies` | Company groupings for customers |
| `expert_ticket_permissions` | Expert access rules |
| **Tickets** | |
| `tickets` | Core ticket data with classification fields |
| `ticket_activity` | Comments, status changes, history |
| `ticket_attachments` | File attachments |
| `ticket_links` | Linked tickets (related, blocked by, etc.) |
| `ticket_rules` | Automation rules |
| **SLA** | |
| `sla_definitions` | SLA policies (response/resolve times) |
| `sla_schedules` | Business hours definitions |
| **CMDB** | |
| `cmdb_items` | Configuration items / assets |
| `cmdb_item_types` | Asset type definitions with custom fields |
| `cmdb_relationships` | CI-to-CI relationships |
| **Knowledge Base** | |
| `knowledge_base_articles` | KB content |
| `knowledge_base_categories` | Article categorization |
| **Email** | |
| `email_ingest_settings` | Mailbox configurations |
| `ai_email_analysis` | AI processing logs and metrics |
| **Settings** | |
| `tenant_settings` | Tenant-level configuration |
| `notifications` | User notification queue |
| `tenant_audit_log` | Tenant activity log |

### Key Ticket Columns

```sql
-- Classification (AI-populated)
work_type           VARCHAR(32)    -- request, incident, problem, etc.
execution_mode      VARCHAR(16)    -- automated, human_review, expert_required, etc.
system_tags         JSON           -- ["tag1", "tag2"]
classification_confidence DECIMAL(4,3)
classification_reason TEXT
classified_by       VARCHAR(16)    -- ai, human, rule
classified_at       TIMESTAMP

-- Pool Management
pool_status         VARCHAR(32)    -- OPEN_POOL, CLAIMED_LOCKED, IN_PROGRESS_OWNED, etc.
pool_score          INT            -- AI-computed priority score
claimed_by_expert_id INT
claimed_until_at    TIMESTAMP
owned_by_expert_id  INT

-- SLA
sla_definition_id   INT
response_due_at     TIMESTAMP
resolve_due_at      TIMESTAMP
first_responded_at  TIMESTAMP
sla_source          VARCHAR(32)    -- manual, rule, cmdb, customer

-- Source Tracking
source              VARCHAR(32)    -- ui, email, teams, slack, api
source_metadata     JSON           -- Original message details
```

---

## Ticket Processing

### Ticket Creation Sources

| Source | Project | Endpoint Called |
|--------|---------|-----------------|
| UI | Apoyar Agentic V1 | `POST /api/tickets/:tenant` |
| Email | email-worker | `POST /api/tickets/:tenant` (internal) |
| Teams | teams_connector | `POST /api/tickets/:tenant` |
| Slack | Slack Serviflow | `POST /api/tickets/:tenant` |
| API | External | `POST /api/tickets/:tenant` |

### Processing Pipeline

1. **Validation** - Required fields, tenant access
2. **Customer Resolution** - Match/create requester from email or ID
3. **SLA Assignment** - Based on rules, CMDB item, or customer
4. **AI Classification** - work_type, execution_mode, tags (async)
5. **Rule Execution** - Auto-assignment, tagging
6. **Pool Placement** - Set `pool_status = 'OPEN_POOL'` if unassigned
7. **Notifications** - Alert relevant users

### Pool vs Master Ticket List

| Endpoint | Purpose | Payload |
|----------|---------|---------|
| `GET /api/tickets/:tenant/pool` | Expert work queue | Lightweight (29 fields, no description) |
| `GET /api/tickets/:tenant` | Master ticket table | Lightweight with server-side filtering |
| `GET /api/tickets/:tenant/:id` | Ticket detail | Full payload including description |

**Query Parameters (both list endpoints):**
- `page`, `limit` - Pagination (default 1, 50; max 200)
- `status`, `priority` - Comma-separated filter values
- `assignee_id` - Filter by assignee (or `unassigned`)
- `company_id`, `requester_id` - Customer filters
- `search` - Free text (title, requester, company)
- `sort_by`, `sort_dir` - Sorting (created_at, updated_at, priority, etc.)

---

## Environments

### Local Development

- **URL**: `http://localhost:3000`
- **Database**: Local MySQL (localhost, root, no password typical)
- **Email**: Disabled by default
- **Connectors**: Not available

```bash
npm install
npm start
```

### UAT

- **URL**: `https://web-uat-uat.up.railway.app`
- **Database**: Railway MySQL (same project as prod, different data)
- **Email**: Configurable (separate mailboxes from prod)
- **Purpose**: Integration testing, mirrors production topology

### Production

- **URL**: `https://app.serviflow.app`
- **Database**: Railway MySQL (Serviflow MYSQL project)
- **Email**: Active (production mailboxes)
- **Connectors**: All active (Teams, Slack)

### Deployment Workflow

```bash
# 1. Deploy to UAT (default)
railway up --detach

# 2. Test on UAT

# 3. Deploy to Production (after approval)
source railway-env.sh prod
railway up --detach
source railway-env.sh uat  # Switch back

# 4. Push to git after production verified
git push
```

---

## Feature Status

### Production-Hardened
- Multi-tenant database isolation
- JWT authentication with role-based access
- Server-side pagination and filtering
- Email ingestion with AI classification
- SLA tracking with breach notifications
- Ticket pool with claim/release workflow
- Knowledge base with AI search
- CMDB with asset categorization
- Teams and Slack integrations
- Activity logging and audit trail

### Prototype / Demo Only
- Local setup scripts (`npm run setup-db`)
- Sample data generators

### Not Included
- Docker (Railway handles containers)
- CI/CD pipeline (manual deployment)
- Automated test suite

---

## Authentication

### Master Admin
- **Endpoint**: `/api/master/*`
- **Credentials**: `admin` / `admin123`

### Tenant Users
- **Endpoint**: `/api/auth/login` with `tenantCode`
- **Roles**: admin, expert, customer
- **Default (apoyar)**: `admin` / `password123`, `expert` / `password123`

---

## API Overview

```
/api/auth/*           # Authentication (login, token refresh)
/api/master/*         # Master admin (tenants, plans, users)
/api/tickets/*        # Tickets (CRUD, pool, classification, bulk)
/api/users/*          # User management
/api/cmdb/*           # CMDB items and types
/api/kb/*             # Knowledge base articles
/api/analytics/*      # Reporting and metrics
/api/notifications/*  # User notifications
/api/sla/*            # SLA definitions and schedules
```

---

## Operational Parity Gate

UAT must mirror production in service roles and database schema. The authoritative check is:

```bash
./scripts/parity/parity-check.sh
```

**Exit codes:** 0 = parity OK, 1 = violation detected

**What it checks:**
- Required service roles exist in both environments (web, email-worker)
- Environment variable keys match (after allowlist filtering)
- Required database tables and columns exist per schema contract

**Deployments should not proceed if parity fails.** Run `parity-report.sh` for detailed diagnostics.

---

## Troubleshooting

### MySQL Connection Failed
- Check `.env` credentials
- Verify MySQL is running
- Check Railway proxy connection for remote

### Email Worker Not Processing
- Check kill switches (see Worker Services section)
- Verify IMAP credentials in `email_ingest_settings`
- Check Railway logs: `railway logs -s email-worker`

### Tickets Not Appearing in Pool
- Verify `pool_status = 'OPEN_POOL'`
- Check ticket is not Resolved/Closed
- Confirm user has expert role

### Teams/Slack Not Creating Tickets
- Check connector service logs in respective Railway project
- Verify service token is valid
- Check tenant mapping configuration

### Health Checks
- **Server**: `GET /health`
- **Database**: `GET /api/db/status`

---

## License

Proprietary - Apoyar / Serviflow

<!-- Last verified: 2026-01-31 -->
