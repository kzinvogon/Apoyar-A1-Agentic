# UI Endpoint Manifest

Auto-generated manifest of all API endpoints called by the ServiFlow UI.
Used for UAT parity testing to ensure no 500 errors on empty databases.

## Legend

| Symbol | Meaning |
|--------|---------|
| 🔓 | Public (no auth) |
| 🔐 | Auth required |
| 👤 | Customer role |
| 👷 | Expert role |
| 👑 | Admin role |
| 🏛️ | Master admin |

## Endpoints by Category

### Authentication

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| POST | `/api/auth/tenant/login` | 🔓 | 401 if bad creds |
| POST | `/api/auth/master/login` | 🔓 | 401 if bad creds |
| POST | `/api/auth/tenant/forgot-password` | 🔓 | 200 (always) |
| GET | `/api/auth/profile` | 🔐 | 200 with user |
| POST | `/api/auth/${tenant}/reauth` | 🔐 | 200 |
| GET | `/api/auth/experts` | 🔐👑 | 200 empty array |
| GET | `/api/auth/customers` | 🔐👑 | 200 empty array |

### Tickets

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/tickets/${tenant}` | 🔐 | 200 empty array |
| GET | `/api/tickets/${tenant}/pool` | 🔐👷 | 200 empty array |
| GET | `/api/tickets/${tenant}/${id}` | 🔐 | 404 if not found |
| POST | `/api/tickets/${tenant}/${id}/claim` | 🔐👷 | 404 if not found |
| POST | `/api/tickets/${tenant}/${id}/accept-ownership` | 🔐👷 | 404 if not found |
| POST | `/api/tickets/${tenant}/${id}/release-claim` | 🔐👷 | 404 if not found |
| POST | `/api/tickets/${tenant}/${id}/escalate` | 🔐👷 | 404 if not found |
| POST | `/api/tickets/${tenant}/${id}/waiting-on-customer` | 🔐👷 | 404 if not found |
| POST | `/api/tickets/${tenant}/${id}/resume` | 🔐👷 | 404 if not found |
| POST | `/api/tickets/${tenant}/${id}/self-assign` | 🔐👷 | 404 if not found |
| POST | `/api/tickets/${tenant}/${id}/mark-as-system` | 🔐👷 | 404 if not found |
| POST | `/api/tickets/${tenant}/${id}/comment` | 🔐 | 404 if not found |
| PUT | `/api/tickets/${tenant}/${id}` | 🔐👷 | 404 if not found |
| POST | `/api/tickets/${tenant}/bulk-action` | 🔐👷 | 200 |
| GET | `/api/tickets/${tenant}/export/csv` | 🔐👑 | 200 empty CSV |
| GET | `/api/tickets/settings/${tenant}` | 🔐 | 200 with defaults |
| GET | `/api/tickets/public/${tenant}/feedback-scoreboard` | 🔓 | 200 empty array |

### Ticket Rules

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/ticket-rules/${tenant}` | 🔐👷 | 200 empty array |
| GET | `/api/ticket-rules/${tenant}/statistics` | 🔐👷 | 200 with zeros |
| GET | `/api/ticket-rules/${tenant}/${id}` | 🔐👷 | 404 if not found |
| GET | `/api/ticket-rules/${tenant}/${id}/history` | 🔐👷 | 200 empty array |
| POST | `/api/ticket-rules/${tenant}` | 🔐👷 | 201 created |
| PUT | `/api/ticket-rules/${tenant}/${id}` | 🔐👷 | 404 if not found |
| DELETE | `/api/ticket-rules/${tenant}/${id}` | 🔐👷 | 404 if not found |
| POST | `/api/ticket-rules/${tenant}/${id}/test` | 🔐👷 | 200 empty matches |
| POST | `/api/ticket-rules/${tenant}/${id}/run` | 🔐👷 | 200 |

### CMDB

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/cmdb/${tenant}/items` | 🔐 | 200 empty array |
| GET | `/api/cmdb/${tenant}/items/all` | 🔐 | 200 empty array |
| GET | `/api/cmdb/${tenant}/items/${id}` | 🔐 | 404 if not found |
| GET | `/api/cmdb/${tenant}/items/${id}/relationships` | 🔐 | 200 empty arrays |
| GET | `/api/cmdb/${tenant}/items/${id}/history` | 🔐 | 200 empty array |
| GET | `/api/cmdb/${tenant}/items/${id}/cis` | 🔐 | 200 empty array |
| GET | `/api/cmdb/${tenant}/items/${id}/custom-values` | 🔐 | 200 empty object |
| GET | `/api/cmdb/${tenant}/items/${id}/impact-analysis` | 🔐 | 200 empty |
| POST | `/api/cmdb/${tenant}/items` | 🔐👷 | 201 created |
| PUT | `/api/cmdb/${tenant}/items/${id}` | 🔐👷 | 404 if not found |
| DELETE | `/api/cmdb/${tenant}/items/${id}` | 🔐👷 | 404 if not found |
| GET | `/api/cmdb/${tenant}/custom-fields` | 🔐 | 200 empty array |
| POST | `/api/cmdb/${tenant}/custom-fields` | 🔐👑 | 201 created |
| PUT | `/api/cmdb/${tenant}/custom-fields/${id}` | 🔐👑 | 404 if not found |
| DELETE | `/api/cmdb/${tenant}/custom-fields/${id}` | 🔐👑 | 404 if not found |
| GET | `/api/cmdb/${tenant}/relationships` | 🔐 | 200 empty array |
| POST | `/api/cmdb/${tenant}/relationships` | 🔐👷 | 201 created |
| DELETE | `/api/cmdb/${tenant}/relationships/${id}` | 🔐👷 | 404 if not found |
| GET | `/api/cmdb/${tenant}/cis/${id}` | 🔐 | 404 if not found |
| POST | `/api/cmdb/${tenant}/import/items` | 🔐👑 | 200 |
| GET | `/api/cmdb/${tenant}/template/items` | 🔐👑 | 200 CSV template |

### CMDB Types

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/cmdb-types/${tenant}/item-types` | 🔐 | 200 empty array |
| GET | `/api/cmdb-types/${tenant}/item-types/${id}/ci-types` | 🔐 | 200 empty array |

### Knowledge Base

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/kb/${tenant}/categories` | 🔐 | 200 empty array |
| GET | `/api/kb/${tenant}/articles` | 🔐 | 200 empty array |
| GET | `/api/kb/${tenant}/articles/${id}` | 🔐 | 404 if not found |
| POST | `/api/kb/${tenant}/articles` | 🔐👷 | 201 created |
| PUT | `/api/kb/${tenant}/articles/${id}` | 🔐👷 | 404 if not found |
| DELETE | `/api/kb/${tenant}/articles/${id}` | 🔐👷 | 404 if not found |
| POST | `/api/kb/${tenant}/articles/${id}/feedback` | 🔐 | 200 |
| POST | `/api/kb/${tenant}/articles/${id}/merge` | 🔐👷 | 200 |
| GET | `/api/kb/${tenant}/search?q=` | 🔐 | 200 empty array |
| GET | `/api/kb/${tenant}/suggest-for-ticket/${id}` | 🔐 | 200 empty array |
| GET | `/api/kb/${tenant}/stats` | 🔐👷 | 200 with zeros |
| GET | `/api/kb/${tenant}/merge-suggestions` | 🔐👷 | 200 empty array |
| PUT | `/api/kb/${tenant}/merge-suggestions/${id}` | 🔐👷 | 404 if not found |

### Customers

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/customers` | 🔐👷 | 200 empty array |
| GET | `/api/customers/${id}` | 🔐👷 | 404 if not found |
| POST | `/api/customers` | 🔐👷 | 201 created |
| PUT | `/api/customers/${id}` | 🔐👷 | 404 if not found |
| DELETE | `/api/customers/${id}` | 🔐👑 | 404 if not found |
| POST | `/api/customers/${id}/reactivate` | 🔐👑 | 404 if not found |
| PUT | `/api/customers/${id}/email-notifications` | 🔐👷 | 404 if not found |

### Customer Companies

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/customer-companies` | 🔐👷 | 200 empty array |
| GET | `/api/customer-companies/${id}` | 🔐👷 | 404 if not found |
| POST | `/api/customer-companies` | 🔐👷 | 201 created |
| PUT | `/api/customer-companies/${id}` | 🔐👷 | 404 if not found |

### Experts

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/experts/${tenant}` | 🔐👑 | 200 empty array |
| GET | `/api/experts/${tenant}/invited` | 🔐👑 | 200 empty array |
| GET | `/api/experts/${tenant}/deleted` | 🔐👑 | 200 empty array |
| GET | `/api/experts/${tenant}/${id}` | 🔐👑 | 404 if not found |
| PUT | `/api/experts/${tenant}/${id}` | 🔐👑 | 404 if not found |
| DELETE | `/api/experts/${tenant}/${id}` | 🔐👑 | 404 if not found |
| POST | `/api/experts/${tenant}/invite` | 🔐👑 | 200 |
| POST | `/api/experts/${tenant}/bulk-invite` | 🔐👑 | 200 |
| POST | `/api/experts/${tenant}/${id}/resend-invite` | 🔐👑 | 404 if not found |
| POST | `/api/experts/${tenant}/${id}/revoke-invite` | 🔐👑 | 404 if not found |
| POST | `/api/experts/${tenant}/${id}/restore` | 🔐👑 | 404 if not found |
| DELETE | `/api/experts/${tenant}/${id}/erase` | 🔐👑 | 404 if not found |

### Expert Permissions

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/expert-permissions/${tenant}/customers/available` | 🔐👑 | 200 empty array |
| GET | `/api/expert-permissions/${tenant}/${expertId}` | 🔐👑 | 200 empty array |
| PUT | `/api/expert-permissions/${tenant}/${expertId}` | 🔐👑 | 200 |

### Notifications

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/notifications/${tenant}` | 🔐 | 200 empty array |
| POST | `/api/notifications/${tenant}/${id}/deliver` | 🔐 | 200 |
| POST | `/api/notifications/${tenant}/deliver-bulk` | 🔐 | 200 |

### AI Analysis

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/ai/${tenant}/tickets/${id}/suggestions` | 🔐👷 | 200 empty |
| GET | `/api/ai/${tenant}/tickets/${id}/cmdb-matches` | 🔐👷 | 200 empty |
| GET | `/api/ai/${tenant}/tickets/${id}/cmdb-items` | 🔐👷 | 200 empty array |
| POST | `/api/ai/${tenant}/tickets/${id}/cmdb-items/${cmdbId}` | 🔐👷 | 200 |
| DELETE | `/api/ai/${tenant}/tickets/${id}/cmdb-items/${cmdbId}` | 🔐👷 | 200 |
| POST | `/api/ai/${tenant}/tickets/${id}/auto-link-cmdb` | 🔐👷 | 200 |
| POST | `/api/ai/${tenant}/tickets/${id}/apply-cmdb-matches` | 🔐👷 | 200 |
| POST | `/api/ai/${tenant}/tickets/${id}/execute-action` | 🔐👷 | 200 |
| GET | `/api/ai/${tenant}/cmdb-suggestions` | 🔐👷 | 200 empty array |
| POST | `/api/ai/${tenant}/cmdb-suggestions/${id}/approve` | 🔐👷 | 200 |
| GET | `/api/ai/${tenant}/insights` | 🔐👷 | 200 empty |

### Analytics

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/analytics/${tenant}` | 🔐👷 | 200 with zeros |
| GET | `/api/analytics/${tenant}/export/csv` | 🔐👑 | 200 empty CSV |
| POST | `/api/analytics/${tenant}/insights/${id}/dismiss` | 🔐👷 | 200 |

### SLA

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/sla/${tenant}/definitions` | 🔐👑 | 200 empty array |
| GET | `/api/sla/${tenant}/definitions/${id}` | 🔐👑 | 404 if not found |
| POST | `/api/sla/${tenant}/definitions` | 🔐👑 | 201 created |
| PUT | `/api/sla/${tenant}/definitions/${id}` | 🔐👑 | 404 if not found |
| DELETE | `/api/sla/${tenant}/definitions/${id}` | 🔐👑 | 404 if not found |
| GET | `/api/sla/${tenant}/business-hours` | 🔐👑 | 200 empty array |
| POST | `/api/sla/${tenant}/business-hours` | 🔐👑 | 201 created |
| PUT | `/api/sla/${tenant}/business-hours/${id}` | 🔐👑 | 404 if not found |
| DELETE | `/api/sla/${tenant}/business-hours/${id}` | 🔐👑 | 404 if not found |
| GET | `/api/sla/${tenant}/category-mappings` | 🔐👑 | 200 empty array |
| POST | `/api/sla/${tenant}/category-mappings` | 🔐👑 | 201 created |
| DELETE | `/api/sla/${tenant}/category-mappings/${id}` | 🔐👑 | 200 |

### Email Ingest

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/email-ingest/${tenant}/settings` | 🔐👑 | 200 with defaults |
| PUT | `/api/email-ingest/${tenant}/settings` | 🔐👑 | 200 |
| POST | `/api/email-ingest/${tenant}/test-connection` | 🔐👑 | 200/error |
| POST | `/api/email-ingest/${tenant}/process-now` | 🔐👑 | 200 |

### Integrations

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/integrations/${tenant}/slack/status` | 🔐👑 | 200 |
| POST | `/api/integrations/${tenant}/slack/connect` | 🔐👑 | 200 |
| POST | `/api/integrations/${tenant}/slack/disconnect` | 🔐👑 | 200 |
| GET | `/api/integrations/${tenant}/slack/email-domain` | 🔐👑 | 200 |
| PUT | `/api/integrations/${tenant}/slack/email-domain/${id}` | 🔐👑 | 200 |
| GET | `/api/integrations/${tenant}/teams/status` | 🔐👑 | 200 |
| POST | `/api/integrations/${tenant}/teams/connect` | 🔐👑 | 200 |
| POST | `/api/integrations/${tenant}/teams/disconnect` | 🔐👑 | 200 |
| GET | `/api/integrations/${tenant}/teams/email-domain` | 🔐👑 | 200 |
| PUT | `/api/integrations/${tenant}/teams/email-domain/${id}` | 🔐👑 | 200 |

### Tenant Settings

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/tenant-settings/${tenant}/settings` | 🔐👑 | 200 |
| PUT | `/api/tenant-settings/${tenant}/settings/${key}` | 🔐👑 | 200 |
| GET | `/api/raw-variables/${tenant}` | 🔐👑 | 200 |
| PUT | `/api/raw-variables/${tenant}/${key}` | 🔐👑 | 200 |
| PUT | `/api/raw-variables/${tenant}/bulk` | 🔐👑 | 200 |

### Profile

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/profile/${tenant}/profile` | 🔐 | 200 |
| PUT | `/api/profile/${tenant}/profile` | 🔐 | 200 |

### Company Admin

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/company-admin/${tenant}/my-company` | 🔐👤 | 200/404 |
| GET | `/api/company-admin/${tenant}/my-company/users` | 🔐👤 | 200 empty array |
| POST | `/api/company-admin/${tenant}/my-company/invite` | 🔐👤 | 200 |
| PUT | `/api/company-admin/${tenant}/my-company/users/${id}/toggle` | 🔐👤 | 200 |

### Usage & Billing

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/tenant/${tenant}/usage` | 🔐👑 | 200 |
| PUT | `/api/tenant/${tenant}/usage/update` | 🔐👑 | 200 |
| GET | `/api/usage/${tenant}` | 🔐 | 200 |
| GET | `/api/billing/subscription` | 🔐👑 | 200/404 |
| GET | `/api/billing/invoices` | 🔐👑 | 200 empty array |
| GET | `/api/billing/payment-methods` | 🔐👑 | 200 empty array |
| POST | `/api/billing/payment-methods` | 🔐👑 | 200 |
| DELETE | `/api/billing/payment-methods/${id}` | 🔐👑 | 200 |
| POST | `/api/billing/checkout` | 🔐👑 | 200 |
| POST | `/api/billing/cancel` | 🔐👑 | 200 |
| GET | `/api/plans` | 🔓 | 200 array |

### Admin

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/admin/audit-log` | 🔐👑 | 200 empty array |
| GET | `/api/admin/audit-log/actions` | 🔐👑 | 200 array |

### Master Admin

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/api/master/overview` | 🏛️ | 200 |
| GET | `/api/master/tenants` | 🏛️ | 200 array |
| GET | `/api/master/tenants/${id}` | 🏛️ | 404 if not found |
| PUT | `/api/master/tenants/${id}` | 🏛️ | 404 if not found |
| GET | `/api/master/tenants/${id}/email-settings` | 🏛️ | 200 |
| PUT | `/api/master/tenants/${id}/email-settings` | 🏛️ | 200 |
| GET | `/api/master/tenants/${id}/subscription` | 🏛️ | 200/404 |
| GET | `/api/master/subscriptions` | 🏛️ | 200 array |
| POST | `/api/master/subscriptions/${id}/extend-trial` | 🏛️ | 200 |
| POST | `/api/master/subscriptions/${id}/convert-trial` | 🏛️ | 200 |
| GET | `/api/master/plans` | 🏛️ | 200 array |
| POST | `/api/master/plans` | 🏛️ | 201 |
| PUT | `/api/master/plans/${id}` | 🏛️ | 200 |
| DELETE | `/api/master/plans/${id}` | 🏛️ | 200 |
| GET | `/api/master/plans/features` | 🏛️ | 200 array |
| GET | `/api/master/currencies` | 🏛️ | 200 array |
| POST | `/api/master/currencies` | 🏛️ | 201 |
| GET | `/api/master/billing` | 🏛️ | 200 |
| PUT | `/api/master/email` | 🏛️ | 200 |

### Health & Version

| Method | Endpoint | Auth | Empty DB Behaviour |
|--------|----------|------|-------------------|
| GET | `/health` | 🔓 | 200 |
| GET | `/api/version` | 🔓 | 200 |

---

## Critical Endpoints for UAT Parity

These endpoints MUST return 200 (not 500) even on empty database:

1. `/api/tickets/${tenant}` - ticket list
2. `/api/tickets/${tenant}/pool` - ticket pool
3. `/api/tickets/settings/${tenant}` - system settings
4. `/api/tickets/public/${tenant}/feedback-scoreboard` - public feedback
5. `/api/ticket-rules/${tenant}` - rules list
6. `/api/ticket-rules/${tenant}/statistics` - rules stats
7. `/api/cmdb/${tenant}/items` - CMDB items
8. `/api/cmdb/${tenant}/custom-fields` - custom fields
9. `/api/kb/${tenant}/categories` - KB categories
10. `/api/kb/${tenant}/articles` - KB articles
11. `/api/kb/${tenant}/stats` - KB stats
12. `/api/customers` - customers list
13. `/api/customer-companies` - companies list
14. `/api/experts/${tenant}` - experts list
15. `/api/notifications/${tenant}` - notifications
16. `/api/analytics/${tenant}` - analytics
17. `/api/sla/${tenant}/definitions` - SLA definitions
18. `/api/email-ingest/${tenant}/settings` - email settings

---

*Generated: 2026-01-26*
