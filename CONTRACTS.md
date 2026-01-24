# API Contracts

This document defines the API contracts between the UI and backend. All endpoints listed here are covered by smoke tests and must return valid JSON responses.

## Authentication

All endpoints require JWT Bearer token except `/health` and `/api/version`.

```
Authorization: Bearer <token>
```

---

## Core Endpoints

### Health & Version

| UI Component | Endpoint | Method | Response Shape |
|--------------|----------|--------|----------------|
| App Init | `GET /health` | GET | `{ status: string }` |
| App Init | `GET /api/version` | GET | `{ success: bool, version: { git_sha, build_time, environment, node_version } }` |

### Authentication

| UI Component | Endpoint | Method | Response Shape |
|--------------|----------|--------|----------------|
| Login Screen | `POST /api/auth/tenant/login` | POST | `{ token: string, user: object }` |

---

## Tickets API

| UI Component | Endpoint | Method | Response Shape |
|--------------|----------|--------|----------------|
| Dashboard | `GET /api/tickets/:tenant` | GET | `{ success: bool, tickets: array }` |
| Ticket Pool | `GET /api/tickets/:tenant/pool` | GET | `{ success: bool, pool: array }` |
| System Settings | `GET /api/tickets/settings/:tenant` | GET | `{ success: bool, settings: object }` |
| Claim Ticket | `POST /api/tickets/:tenant/:id/claim` | POST | `{ success: bool, ticket: object }` |
| Accept Ownership | `POST /api/tickets/:tenant/:id/accept-ownership` | POST | `{ success: bool, ticket: object }` |
| Escalate | `POST /api/tickets/:tenant/:id/escalate` | POST | `{ success: bool, ticket: object }` |

---

## CMDB API

| UI Component | Endpoint | Method | Response Shape |
|--------------|----------|--------|----------------|
| CMDB List | `GET /api/cmdb/:tenant/items` | GET | `{ success: bool, items: array }` |
| Item Types | `GET /api/cmdb-types/:tenant/item-types` | GET | `{ success: bool, itemTypes: array }` |
| Custom Fields | `GET /api/cmdb/:tenant/custom-fields` | GET | `{ success: bool, fields: array }` |
| Relationships | `GET /api/cmdb/:tenant/items/:cmdbId/relationships` | GET | `{ success: bool, outgoing: array, incoming: array }` |

---

## Knowledge Base API

**Route file:** `routes/knowledge-base.js`
**Mount point:** `app.use('/api/kb', knowledgeBaseRoutes)` (server.js:126)

### Articles CRUD

| UI Component | Endpoint | Method | Auth | Response Shape |
|--------------|----------|--------|------|----------------|
| KB List | `GET /api/kb/:tenant/articles` | GET | token | `{ success, articles[], pagination }` |
| KB Article View | `GET /api/kb/:tenant/articles/:id` | GET | token | `{ success, article }` |
| KB Create | `POST /api/kb/:tenant/articles` | POST | admin/expert | `{ success, article }` |
| KB Edit | `PUT /api/kb/:tenant/articles/:id` | PUT | admin/expert | `{ success, article }` |
| KB Delete | `DELETE /api/kb/:tenant/articles/:id` | DELETE | admin | `{ success, message }` |

### Categories & Stats

| UI Component | Endpoint | Method | Auth | Response Shape |
|--------------|----------|--------|------|----------------|
| KB Sidebar | `GET /api/kb/:tenant/categories` | GET | token | `{ success, categories[] }` |
| KB Dashboard | `GET /api/kb/:tenant/stats` | GET | admin/expert | `{ success, stats }` |

### Search & Suggestions

| UI Component | Endpoint | Method | Auth | Response Shape |
|--------------|----------|--------|------|----------------|
| KB Search | `GET /api/kb/:tenant/search?q=` | GET | token | `{ success, query, results[] }` |
| Ticket Sidebar | `GET /api/kb/:tenant/suggest-for-ticket/:ticketId` | GET | token | `{ success, suggestions[] }` |
| Ticket KB Panel | `GET /api/kb/:tenant/tickets/:ticketId/suggestions` | GET | admin/expert | `{ success, suggestions[] }` |
| Create from Ticket | `POST /api/kb/:tenant/tickets/:ticketId/create-article` | POST | admin/expert | `{ success, article }` |

### Merge & Deduplication

| UI Component | Endpoint | Method | Auth | Response Shape |
|--------------|----------|--------|------|----------------|
| Merge Queue | `GET /api/kb/:tenant/merge-suggestions` | GET | admin/expert | `{ success, count, suggestions[] }` |
| Merge Action | `POST /api/kb/:tenant/merge` | POST | admin | `{ success, merged_article }` |
| Dismiss Merge | `POST /api/kb/:tenant/merge-suggestions/:id/dismiss` | POST | admin/expert | `{ success, message }` |

### Feedback

| UI Component | Endpoint | Method | Auth | Response Shape |
|--------------|----------|--------|------|----------------|
| Article Footer | `POST /api/kb/:tenant/articles/:id/feedback` | POST | token | `{ success, message }` |

### Database Tables

| Table | Purpose |
|-------|---------|
| `kb_articles` | Main articles (title, content, status, category) |
| `kb_categories` | Article categories with hierarchy |
| `kb_article_versions` | Version history for rollback |
| `kb_article_similarities` | AI-detected duplicate/merge candidates |
| `kb_article_feedback` | User helpful/not-helpful votes |
| `kb_article_embeddings` | Vector embeddings for semantic search |
| `ticket_kb_articles` | Links between tickets and articles |

---

## SLA API

| UI Component | Endpoint | Method | Response Shape |
|--------------|----------|--------|----------------|
| SLA Definitions | `GET /api/sla/:tenant/definitions` | GET | `{ success: bool, definitions: array }` |

---

## Smoke Test Coverage

All **read-only** endpoints (GET) in this document are covered by the smoke test suite:
- `npm run smoke` - Local
- `npm run smoke:uat` - UAT (full tests including mutations)
- `npm run smoke:prod` - Production (read-only, no state changes)

See `scripts/smoke-test.js` for implementation.

---

## Routing Contract

All `/api/*` routes MUST return JSON responses:
- Success: `{ success: true, ... }`
- Error: `{ success: false, message: string }`

Non-API routes fall back to `index.html` (SPA routing).

If an `/api/*` route returns HTML, it indicates a missing route handler (bug).
