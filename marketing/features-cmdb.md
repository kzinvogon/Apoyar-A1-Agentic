# Configuration Management

## Track the systems you support

ServiFlow's CMDB connects your assets to your service delivery. Link tickets to configuration items, inherit SLAs from critical systems, and see which infrastructure generates the most work.

---

### What you track

Configuration items represent the systems and services you manage:

- Servers and workstations
- Network equipment
- Software and applications
- Cloud services
- Business services

Each item has:
- **Identity** — Name, type, serial number, asset tag
- **Ownership** — Which customer company it belongs to
- **Classification** — Category, brand, model
- **Status** — Active, retired, under maintenance
- **Relationships** — Dependencies on other items

You define what attributes matter for your operation.

---

### Linking tickets to assets

When a ticket comes in, link it to the affected configuration items.

This gives you:
- **Context for technicians** — See what's affected before starting work
- **History per asset** — All tickets related to a system in one place
- **Pattern recognition** — Identify assets that generate repeated issues
- **Impact visibility** — Understand which customers are affected

Linking is optional per ticket but valuable when used consistently.

---

### SLA inheritance

Configuration items can carry their own SLA definitions.

When a ticket is linked to an asset with an assigned SLA, that SLA can apply to the ticket. This is useful for:
- Critical infrastructure requiring faster response
- Premium hardware under enhanced support
- Specific systems with contractual obligations

The SLA source is recorded, so you always know whether the service level came from the customer, the category, or the asset.

---

### Customer ownership

Every configuration item belongs to a customer company.

Your team sees all assets across all customers. Customers see only their own. There is no mechanism for one customer to view another's infrastructure.

For internal IT teams without external customers, assets can belong to the tenant directly.

---

### For MSPs

If you manage assets for multiple customers:
- Each customer's items are isolated by ownership
- You report on asset health and ticket volume per customer
- Your team works from a unified view
- Customers access only their own systems

This supports both operational efficiency and customer data separation.

---

### Not a discovery tool

ServiFlow's CMDB is a managed register, not an automatic scanner.

You add configuration items manually or via import. This is intentional—your CMDB should contain the systems you're accountable for, not everything that exists on a network.

If you use discovery tools, import their output into ServiFlow.
