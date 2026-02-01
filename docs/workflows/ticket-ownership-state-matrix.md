# Ticket Ownership State Matrix (Authoritative)

## Principle
Viewing ≠ Claiming ≠ Owning.
“My Open” = owned tickets only.

## Fields used
pool_status
claimed_by_expert_id
claimed_until_at
owned_by_expert_id
ownership_started_at
execution_mode

## Canonical states
A) UNCLAIMED (Pool)
- pool_status=OPEN_POOL
- claimed_by_expert_id=NULL
- owned_by_expert_id=NULL

B) CLAIMED (Locked, temporary)
- pool_status=CLAIMED_LOCKED
- claimed_by_expert_id=<expert>
- claimed_until_at=<now+TTL>
- owned_by_expert_id=NULL

C) OWNED (Accepted, permanent)
- owned_by_expert_id=<expert>
- ownership_started_at=<timestamp>
- pool_status=OWNED (or excluded from pool query)
- claimed_by_expert_id=NULL

D) AUTOMATED (No human yet)
- execution_mode=automated
- owned_by_expert_id=NULL
- Pool shows “Take Over” (no claim TTL)

## Transitions
View: no DB writes (any state)
Claim: A → B
Claim expiry: B → A
Release: B → A
Accept: B → C
Take Over (automated): D → C

## Counting rules
Pool count: pool_status IN ('OPEN_POOL','CLAIMED_LOCKED')
My Open: owned_by_expert_id = me
Claimed is never counted as My Open

## Button visibility
Pool row:
- A: View + Claim
- B (mine): View
- B (other): View (claim disabled)
- C: not shown in Pool
- D: View + Take Over

Ticket detail:
- A: Claim
- B (mine): Accept + Release
- B (other): read-only, no claim actions
- C (mine): work/resolve
- D: Take Over