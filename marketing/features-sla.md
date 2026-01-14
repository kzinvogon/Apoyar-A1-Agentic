# SLA Engine

## Service levels that mean something

ServiFlow's SLA engine tracks response and resolution times against business hours, assigns SLAs deterministically, and shows your team exactly where they stand—without exposing the mechanics to your customers.

---

### Two-phase SLA tracking

Every ticket is measured on two independent clocks:

**Response SLA**
Time from ticket creation to first meaningful response. This is when you acknowledge the issue and begin work.

**Resolution SLA**
Time from ticket creation to closure. This is when the issue is resolved and the customer confirms acceptance.

Both phases have separate targets, separate warnings, and separate breach notifications. You can set a 4-hour response target with a 48-hour resolution target—or any combination your service agreements require.

---

### Business hours awareness

SLA timers only run during defined business hours.

A ticket raised at 5pm on Friday with an 8-hour response target won't breach at 1am Saturday. It will breach at 1pm Monday—assuming your business hours are 9-5 weekdays.

You can define multiple business hours profiles:
- Standard office hours
- Extended support hours
- 24/7 coverage

Assign different profiles to different customers, categories, or service tiers.

---

### Deterministic SLA selection

When a ticket is created, ServiFlow assigns an SLA using a clear priority order:

1. **Explicit override** — SLA set manually on the ticket
2. **User-level SLA** — Premium support tier assigned to the requesting user
3. **Customer company SLA** — Default SLA for the customer's organisation
4. **Category mapping** — SLA assigned based on ticket category
5. **Asset SLA** — SLA inherited from linked configuration item
6. **Tenant default** — Fallback SLA if nothing else applies

This hierarchy is evaluated once at ticket creation. The source is recorded, so you always know why a particular SLA was applied.

---

### Visibility for your team

Your dashboard shows:
- Tickets approaching response deadline
- Tickets approaching resolution deadline
- Breached tickets requiring escalation
- SLA performance by customer, category, or assignee

You see the full picture: target times, elapsed time, time remaining, and breach status.

---

### What customers see

Customers see their ticket status and can track progress. They do not see:
- SLA target times
- Internal response/resolution deadlines
- Breach warnings or escalation status
- SLA source or calculation logic

This keeps your service commitments visible to your team while keeping operational mechanics out of customer view.

---

### Notifications

ServiFlow sends email notifications at configurable thresholds:
- SLA warning (e.g., 75% of time elapsed)
- SLA breach
- Escalation triggers

Notifications go to assignees, team leads, or custom recipients based on your rules.
