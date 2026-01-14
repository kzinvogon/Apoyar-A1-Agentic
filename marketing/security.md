# Security & Governance

## Built for accountability

ServiFlow is designed for organisations that need to demonstrate control over their service operations. Tenant isolation, audit logging, and role-based access are core to how the platform works—not optional add-ons.

---

### Tenant isolation

Every tenant operates in complete isolation.

- **Separate databases** — Your data is stored in a dedicated database, not mixed with other tenants
- **No cross-tenant queries** — There's no mechanism for one tenant to access another's data
- **Independent configuration** — Your SLAs, categories, and settings don't affect other tenants

If you're an MSP, your customer companies are isolated within your tenant. Your customers can't see each other, and other ServiFlow tenants can't see any of you.

---

### Audit logging

ServiFlow logs user actions with attribution and timestamps:

- Ticket creation, updates, and status changes
- User account modifications
- Configuration changes
- Login events
- SLA overrides and escalations

Audit logs are retained according to your data retention policy and can be exported for compliance reviews or incident investigation.

---

### No ghost users

Every action in ServiFlow is tied to an authenticated user account.

- No anonymous ticket submissions
- No shared service accounts with hidden attribution
- No API calls without user context

When you review a ticket's history, you see exactly who did what and when. This is essential for operations where accountability matters.

---

### Role-based access control

ServiFlow enforces different permission levels:

**Administrators**
Full access to configuration, user management, and all operational data. Can see and modify everything within the tenant.

**Experts**
Can work tickets, view customers, and access operational dashboards. Cannot modify system configuration or manage user accounts.

**Customers**
Can view their own company's tickets, submit requests, and communicate with your team. Cannot see other customers, internal notes, or operational metrics.

**Company administrators**
Customer users with additional permissions to manage users within their own company. Cannot access other companies or system-level settings.

Permissions are enforced at the API level, not just the UI. There's no way to bypass role restrictions by crafting requests directly.

---

### Authentication

User authentication is handled per tenant:

- Password-based authentication with secure hashing
- Session management with configurable timeout
- Password reset via email verification
- Optional first-login password change enforcement

API access uses JWT tokens with tenant and user context embedded.

---

### Data handling

**Encryption in transit**
All connections use TLS. There's no unencrypted HTTP access to the platform.

**Encryption at rest**
Database storage uses encrypted volumes.

**Backups**
Automated backups with point-in-time recovery capability.

**Data export**
You can export your data at any time. Tickets, users, configuration items, and audit logs are all exportable.

---

### Compliance considerations

ServiFlow provides the technical controls that support compliance frameworks, but we don't certify specific compliance (SOC 2, ISO 27001, etc.) at this time.

If you have specific compliance requirements, contact us to discuss how ServiFlow's architecture aligns with your obligations.
