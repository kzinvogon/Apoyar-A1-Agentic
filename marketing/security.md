# Security and Governance

## Control built in, not bolted on

ServiFlow is designed for organisations that need to demonstrate accountability. Tenant isolation, audit logging, and role-based access are part of the architecture—not premium features.

---

### Tenant isolation

Each tenant operates independently.

- **Separate data storage** — Your data is not mixed with other tenants
- **No cross-tenant access** — There is no mechanism to query another tenant's data
- **Independent configuration** — Your settings do not affect other tenants

If you're an MSP, your customer companies are isolated within your tenant. Customers cannot see each other, and other ServiFlow tenants cannot see any of your data.

---

### Audit logging

ServiFlow records user actions with attribution:

- Ticket creation, updates, and status changes
- User account creation and modification
- Configuration changes
- Login events
- SLA overrides

Logs include timestamps and user identification. They can be exported for compliance review or incident investigation.

---

### No anonymous operations

Every action in ServiFlow is tied to an authenticated user.

There are no anonymous ticket submissions, no shared service accounts that obscure attribution, and no API calls without user context.

When you review a ticket's history, you see who did what and when.

---

### Role-based access

ServiFlow enforces permission levels:

**Administrators**
Full access to configuration, user management, and operational data within the tenant.

**Experts**
Can work tickets, view customer data, and access dashboards. Cannot change system configuration.

**Customers**
Can view their own company's tickets, submit requests, and communicate with your team. Cannot see other customers or internal operations.

**Company administrators**
Customer users who can manage other users within their company. Cannot access other companies.

Permissions are enforced at the API level. There is no way to bypass role restrictions through direct requests.

---

### Authentication

User authentication is handled per tenant:

- Password-based login with secure hashing
- Session management with timeout
- Password reset via email
- First-login password change enforcement (optional)

API access uses tokens that include tenant and user context.

---

### Data protection

**In transit**
All connections use TLS encryption.

**At rest**
Database storage is encrypted.

**Backups**
Automated backups with recovery capability.

**Export**
You can export your data at any time—tickets, users, assets, and logs.

---

### Compliance

ServiFlow provides technical controls that support common compliance requirements. We do not currently hold specific certifications (SOC 2, ISO 27001).

If you have compliance obligations, contact us to discuss how ServiFlow's architecture aligns with your requirements.
