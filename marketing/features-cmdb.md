# Configuration Management

## Assets connected to service delivery

ServiFlow's CMDB isn't a standalone inventory system. It's designed to connect your configuration items directly to the tickets, customers, and SLAs that depend on them.

---

### Configuration items, not just assets

Track servers, workstations, network devices, software, and services. Each item includes:

- **Identification** — Name, type, serial number, asset tag
- **Ownership** — Which customer company owns this item
- **Categorisation** — Asset type, brand, model
- **Status** — Active, retired, maintenance, decommissioned
- **Relationships** — Links to other CIs, dependencies, parent systems

You define the categories and attributes that matter for your operation.

---

### Ticket-to-asset linkage

When creating or updating a ticket, link it to one or more configuration items.

This gives you:
- **Context** — Technicians see what system is affected before they start work
- **History** — View all tickets related to a specific asset
- **Patterns** — Identify assets generating repeated issues
- **Impact** — Understand which customers are affected by a failing system

Linking is optional per ticket, but when used, it adds meaningful operational intelligence.

---

### SLA inheritance from assets

Configuration items can have their own SLA definitions.

When a ticket is linked to a CI with an assigned SLA, that SLA can be inherited by the ticket (based on the SLA selection hierarchy). This is useful for:

- Critical infrastructure with stricter response requirements
- Premium hardware under enhanced support agreements
- Specific systems with contractual obligations

The SLA source is recorded on the ticket, so you always know whether the SLA came from the customer, category, or asset.

---

### Customer ownership

Every configuration item belongs to a customer company (or to the tenant for internal assets).

When viewing the CMDB:
- **Your team** sees all assets across all customers
- **Customers** see only their own assets (if portal access is enabled)

There's no risk of a customer seeing another customer's infrastructure. Ownership is enforced at the data level.

---

### For MSPs: operational separation

If you're an MSP managing assets for multiple customers:

- Each customer's CIs are isolated by ownership
- You can report on asset counts, ticket volumes, and SLA performance per customer
- Your team has a unified view; your customers see only their own systems

This structure supports both operational efficiency (one console for your team) and governance (clear boundaries between customers).

---

### Not a discovery tool

ServiFlow's CMDB is a register of managed assets, not an automatic discovery system.

You add configuration items manually or via import. This is intentional—your CMDB should contain the systems you're accountable for, not everything that happens to exist on the network.

If you need discovery, use your preferred scanning tools and import the results.
