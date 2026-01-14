# SLA Engine

## Response and resolution, measured properly

ServiFlow tracks service levels in two phases—response and resolution—against business hours. SLAs are assigned deterministically, and the mechanics stay hidden from your customers.

---

### Two-phase tracking

Every ticket has two clocks:

**Response time**
How long until someone acknowledges the request and begins work. This is when the customer knows you're on it.

**Resolution time**
How long until the issue is closed. This is when the work is done.

Each phase has its own target. A ticket might require a 2-hour response but allow 24 hours for resolution. Both are tracked independently.

---

### Business hours

SLA timers pause outside your operating hours.

A ticket raised at 4:55pm on Friday with a 4-hour response target won't breach overnight. It will resume counting Monday morning.

You can define multiple profiles:
- Weekday office hours
- Extended support windows
- Around-the-clock coverage

Different customers or categories can use different profiles.

---

### How SLAs are assigned

When a ticket is created, ServiFlow selects an SLA using this order:

1. **Ticket override** — Explicitly set on the ticket itself
2. **User override** — Assigned to the individual user (for premium tiers)
3. **Customer company** — Default SLA for the customer's organisation
4. **Category** — SLA mapped to the ticket category
5. **Linked asset** — SLA inherited from a configuration item
6. **Tenant default** — Fallback if nothing else applies

The first match wins. The source is recorded on the ticket so you can see why that SLA was applied.

---

### What your team sees

Your dashboard shows:
- Tickets nearing response deadline
- Tickets nearing resolution deadline
- Breached tickets
- Performance by customer, category, or team member

Timers show elapsed time, remaining time, and breach status.

---

### What customers see

Customers can view their tickets and track progress. They do not see:
- Target response or resolution times
- Breach warnings
- SLA source or selection logic
- Internal escalation status

This keeps service commitments visible to your team while keeping the mechanics out of customer view.

---

### Notifications

ServiFlow sends alerts at defined thresholds:
- Warning before breach
- Notification on breach
- Escalation to designated recipients

You configure who receives what and when.
