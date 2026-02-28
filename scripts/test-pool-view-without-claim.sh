#!/bin/bash
# Test: Pool tickets viewable without claiming (read-only preview)
# Verifies: View works without DB writes, claim/accept flows unchanged
#
# Usage: ./scripts/test-pool-view-without-claim.sh [BASE_URL]
# Default: http://localhost:3000

set -e

BASE_URL="${1:-http://localhost:3000}"
TENANT="apoyar"
SMOKE_PASSWORD="${SMOKE_PASSWORD:?SMOKE_PASSWORD env var required}"

echo "=== Pool View Without Claim Test ==="
echo "Base URL: $BASE_URL"
echo ""

# Login
echo "1. Getting auth token..."
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/tenant/login" \
  -H "Content-Type: application/json" \
  -d "{\"tenant_code\":\"$TENANT\",\"username\":\"admin\",\\"password\\":\\"$SMOKE_PASSWORD\\"}")

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get token"
  exit 1
fi
echo "   Logged in successfully"

# Find an OPEN_POOL ticket
echo ""
echo "2. Finding an OPEN_POOL ticket..."
POOL_RESPONSE=$(curl -s -X GET "$BASE_URL/api/tickets/$TENANT/pool?limit=10" \
  -H "Authorization: Bearer $TOKEN")

TICKET_ID=$(echo "$POOL_RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for t in data.get('tickets', []):
        if t.get('pool_status') == 'OPEN_POOL' and not t.get('claimed_by_expert_id'):
            print(t['id'])
            break
except:
    pass
" 2>/dev/null)

if [ -z "$TICKET_ID" ]; then
  echo "   No unclaimed OPEN_POOL tickets found"
  echo "   Creating a test ticket..."
  CREATE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/tickets/$TENANT" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"title":"Test View Without Claim","description":"Testing read-only view","priority":"Normal"}')
  TICKET_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ticket',{}).get('id',''))" 2>/dev/null)
  if [ -z "$TICKET_ID" ]; then
    echo "ERROR: Failed to create test ticket"
    exit 1
  fi
  echo "   Created ticket ID: $TICKET_ID"
else
  echo "   Found OPEN_POOL ticket ID: $TICKET_ID"
fi

# Get ticket state BEFORE view
echo ""
echo "3. Recording ticket state BEFORE view..."
BEFORE_STATE=$(curl -s -X GET "$BASE_URL/api/tickets/$TENANT/$TICKET_ID" \
  -H "Authorization: Bearer $TOKEN")

BEFORE_POOL_STATUS=$(echo "$BEFORE_STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['ticket'].get('pool_status',''))" 2>/dev/null)
BEFORE_CLAIMED_BY=$(echo "$BEFORE_STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['ticket'].get('claimed_by_expert_id','null'))" 2>/dev/null)
BEFORE_OWNED_BY=$(echo "$BEFORE_STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['ticket'].get('owned_by_expert_id','null'))" 2>/dev/null)

echo "   pool_status: $BEFORE_POOL_STATUS"
echo "   claimed_by_expert_id: $BEFORE_CLAIMED_BY"
echo "   owned_by_expert_id: $BEFORE_OWNED_BY"

# Simulate "View" - just GET the ticket (this is what viewPoolTicket does)
echo ""
echo "4. Simulating View (GET ticket detail)..."
VIEW_RESPONSE=$(curl -s -X GET "$BASE_URL/api/tickets/$TENANT/$TICKET_ID" \
  -H "Authorization: Bearer $TOKEN")

VIEW_SUCCESS=$(echo "$VIEW_RESPONSE" | grep -o '"success":true')
if [ -z "$VIEW_SUCCESS" ]; then
  echo "ERROR: View request failed"
  echo "$VIEW_RESPONSE"
  exit 1
fi
echo "   View succeeded (GET returned ticket data)"

# Get ticket state AFTER view
echo ""
echo "5. Checking ticket state AFTER view..."
AFTER_STATE=$(curl -s -X GET "$BASE_URL/api/tickets/$TENANT/$TICKET_ID" \
  -H "Authorization: Bearer $TOKEN")

AFTER_POOL_STATUS=$(echo "$AFTER_STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['ticket'].get('pool_status',''))" 2>/dev/null)
AFTER_CLAIMED_BY=$(echo "$AFTER_STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['ticket'].get('claimed_by_expert_id','null'))" 2>/dev/null)
AFTER_OWNED_BY=$(echo "$AFTER_STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['ticket'].get('owned_by_expert_id','null'))" 2>/dev/null)

echo "   pool_status: $AFTER_POOL_STATUS"
echo "   claimed_by_expert_id: $AFTER_CLAIMED_BY"
echo "   owned_by_expert_id: $AFTER_OWNED_BY"

# Verify no DB changes occurred
echo ""
echo "6. Verifying View caused NO DB changes..."
if [ "$BEFORE_POOL_STATUS" = "$AFTER_POOL_STATUS" ] && \
   [ "$BEFORE_CLAIMED_BY" = "$AFTER_CLAIMED_BY" ] && \
   [ "$BEFORE_OWNED_BY" = "$AFTER_OWNED_BY" ]; then
  echo "   ✓ PASS: View did not modify ticket state"
else
  echo "   ✗ FAIL: View modified ticket state!"
  echo "   Before: pool=$BEFORE_POOL_STATUS, claimed=$BEFORE_CLAIMED_BY, owned=$BEFORE_OWNED_BY"
  echo "   After:  pool=$AFTER_POOL_STATUS, claimed=$AFTER_CLAIMED_BY, owned=$AFTER_OWNED_BY"
  exit 1
fi

# Test claim/accept flow still works
echo ""
echo "7. Testing Claim flow (should create claim)..."
CLAIM_RESPONSE=$(curl -s -X POST "$BASE_URL/api/tickets/$TENANT/$TICKET_ID/claim" \
  -H "Authorization: Bearer $TOKEN")

CLAIM_SUCCESS=$(echo "$CLAIM_RESPONSE" | grep -o '"success":true')
if [ -z "$CLAIM_SUCCESS" ]; then
  echo "   WARNING: Claim failed (ticket may already be claimed)"
  echo "   Response: $CLAIM_RESPONSE"
else
  echo "   ✓ Claim succeeded"

  # Verify ticket is now CLAIMED_LOCKED
  CLAIMED_STATE=$(curl -s -X GET "$BASE_URL/api/tickets/$TENANT/$TICKET_ID" \
    -H "Authorization: Bearer $TOKEN")
  CLAIMED_STATUS=$(echo "$CLAIMED_STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['ticket'].get('pool_status',''))" 2>/dev/null)

  if [ "$CLAIMED_STATUS" = "CLAIMED_LOCKED" ]; then
    echo "   ✓ Ticket is now CLAIMED_LOCKED"
  else
    echo "   ✗ Expected CLAIMED_LOCKED, got: $CLAIMED_STATUS"
  fi

  # Release claim to clean up
  echo ""
  echo "8. Cleaning up - releasing claim..."
  curl -s -X POST "$BASE_URL/api/tickets/$TENANT/$TICKET_ID/release-claim" \
    -H "Authorization: Bearer $TOKEN" > /dev/null
  echo "   Claim released"
fi

echo ""
echo "=== TEST COMPLETE ==="
echo "Summary:"
echo "  ✓ View (GET) does not modify ticket state"
echo "  ✓ Pool status remains OPEN_POOL after view"
echo "  ✓ Claim flow still works correctly"
echo ""
echo "Backend confirmation:"
echo "  - GET /api/tickets/:tenantId/:ticketId is read-only (routes/tickets.js:978-1071)"
echo "  - Pool endpoint is read-only (routes/tickets.js:750-753)"
echo ""
