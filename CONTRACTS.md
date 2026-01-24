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

| UI Component | Endpoint | Method | Response Shape |
|--------------|----------|--------|----------------|
| KB Categories | `GET /api/kb/:tenant/categories` | GET | `{ success: bool, categories: array }` |
| KB Articles | `GET /api/kb/:tenant/articles` | GET | `{ success: bool, articles: array }` |
| KB Stats | `GET /api/kb/:tenant/stats` | GET | `{ success: bool, stats: object }` |
| Single Article | `GET /api/kb/:tenant/articles/:id` | GET | `{ success: bool, article: object }` |
| Create Article | `POST /api/kb/:tenant/articles` | POST | `{ success: bool, article: object }` |
| Update Article | `PUT /api/kb/:tenant/articles/:id` | PUT | `{ success: bool, article: object }` |
| Delete Article | `DELETE /api/kb/:tenant/articles/:id` | DELETE | `{ success: bool }` |
| Article Feedback | `POST /api/kb/:tenant/articles/:id/feedback` | POST | `{ success: bool }` |
| Merge Suggestions | `GET /api/kb/:tenant/merge-suggestions` | GET | `{ success: bool, suggestions: array }` |
| Suggest for Ticket | `GET /api/kb/:tenant/suggest-for-ticket/:ticketId` | GET | `{ success: bool, suggestions: array }` |

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
