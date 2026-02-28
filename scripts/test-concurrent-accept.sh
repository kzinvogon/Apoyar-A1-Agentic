#!/bin/bash
# Smoke test for race-safe accept-ownership
# Fires two accept requests concurrently and asserts only one succeeds
#
# Usage: ./scripts/test-concurrent-accept.sh [BASE_URL]
# Default: http://localhost:3000

set -e

BASE_URL="${1:-http://localhost:3000}"
TENANT="apoyar"
SMOKE_PASSWORD="${SMOKE_PASSWORD:?SMOKE_PASSWORD env var required}"

echo "=== Concurrent Accept Race Condition Test ==="
echo "Base URL: $BASE_URL"
echo ""

# Login as admin
echo "1. Getting auth token..."

LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/$TENANT/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"'$SMOKE_PASSWORD'"}')

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get token"
  echo "Response: $LOGIN_RESPONSE"
  exit 1
fi
echo "   Logged in successfully"

# Find or create a ticket in OPEN_POOL
echo ""
echo "2. Finding/creating an OPEN_POOL ticket..."

POOL_RESPONSE=$(curl -s -X GET "$BASE_URL/api/tickets/$TENANT/pool?limit=10" \
  -H "Authorization: Bearer $TOKEN")

# Find a ticket that's actually OPEN_POOL (not CLAIMED_LOCKED)
TICKET_ID=$(echo "$POOL_RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    tickets = data.get('tickets', [])
    for t in tickets:
        if t.get('pool_status') == 'OPEN_POOL':
            print(t['id'])
            break
except:
    pass
" 2>/dev/null)

if [ -z "$TICKET_ID" ]; then
  echo "   No OPEN_POOL tickets found. Creating a test ticket..."

  CREATE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/tickets/$TENANT" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "title": "Test Concurrent Accept Race",
      "description": "Automated test for accept race condition",
      "priority": "Medium"
    }')

  TICKET_ID=$(echo "$CREATE_RESPONSE" | grep -o '"ticketId":[0-9]*' | cut -d':' -f2)

  if [ -z "$TICKET_ID" ]; then
    echo "ERROR: Failed to create test ticket"
    echo "Response: $CREATE_RESPONSE"
    exit 1
  fi
  echo "   Created ticket ID: $TICKET_ID"
else
  echo "   Found OPEN_POOL ticket ID: $TICKET_ID"
fi

# Verify ticket is in OPEN_POOL
echo ""
echo "3. Verifying ticket is in OPEN_POOL state..."

TICKET_STATE=$(curl -s -X GET "$BASE_URL/api/tickets/$TENANT/$TICKET_ID" \
  -H "Authorization: Bearer $TOKEN" | grep -o '"pool_status":"[^"]*"' | cut -d'"' -f4)

if [ "$TICKET_STATE" != "OPEN_POOL" ]; then
  echo "   Ticket not in OPEN_POOL (status: $TICKET_STATE). Releasing if claimed..."
  curl -s -X POST "$BASE_URL/api/tickets/$TENANT/$TICKET_ID/release" \
    -H "Authorization: Bearer $TOKEN" > /dev/null 2>&1 || true

  # Re-check
  TICKET_STATE=$(curl -s -X GET "$BASE_URL/api/tickets/$TENANT/$TICKET_ID" \
    -H "Authorization: Bearer $TOKEN" | grep -o '"pool_status":"[^"]*"' | cut -d'"' -f4)

  if [ "$TICKET_STATE" != "OPEN_POOL" ]; then
    echo "ERROR: Could not get ticket into OPEN_POOL state (current: $TICKET_STATE)"
    exit 1
  fi
fi
echo "   Ticket confirmed in OPEN_POOL"

# Fire two concurrent accept-ownership requests
echo ""
echo "4. Firing TWO concurrent accept-ownership requests..."

RESULT_FILE_1=$(mktemp)
RESULT_FILE_2=$(mktemp)

# Launch both requests in background
curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$BASE_URL/api/tickets/$TENANT/$TICKET_ID/accept-ownership" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" > "$RESULT_FILE_1" &
PID1=$!

curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$BASE_URL/api/tickets/$TENANT/$TICKET_ID/accept-ownership" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" > "$RESULT_FILE_2" &
PID2=$!

# Wait for both
wait $PID1
wait $PID2

# Parse results
BODY1=$(cat "$RESULT_FILE_1" | sed 's/HTTP_CODE:.*//')
CODE1=$(cat "$RESULT_FILE_1" | grep -o 'HTTP_CODE:[0-9]*' | cut -d':' -f2)

BODY2=$(cat "$RESULT_FILE_2" | sed 's/HTTP_CODE:.*//')
CODE2=$(cat "$RESULT_FILE_2" | grep -o 'HTTP_CODE:[0-9]*' | cut -d':' -f2)

rm -f "$RESULT_FILE_1" "$RESULT_FILE_2"

echo "   Request 1: HTTP $CODE1"
echo "   Request 2: HTTP $CODE2"

# Count successes (HTTP 200) and conflicts (HTTP 409)
SUCCESS_COUNT=0
CONFLICT_COUNT=0

[ "$CODE1" = "200" ] && SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
[ "$CODE2" = "200" ] && SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
[ "$CODE1" = "409" ] && CONFLICT_COUNT=$((CONFLICT_COUNT + 1))
[ "$CODE2" = "409" ] && CONFLICT_COUNT=$((CONFLICT_COUNT + 1))

echo ""
echo "5. Analyzing results..."
echo "   Successes (200): $SUCCESS_COUNT"
echo "   Conflicts (409): $CONFLICT_COUNT"

# Assert exactly one success
if [ "$SUCCESS_COUNT" -eq 1 ] && [ "$CONFLICT_COUNT" -eq 1 ]; then
  echo ""
  echo "=== TEST PASSED ==="
  echo "Race condition handled correctly:"
  echo "  - One request succeeded (200)"
  echo "  - One request got conflict (409)"
  echo ""

  # Show the 409 response for verification
  if [ "$CODE1" = "409" ]; then
    echo "409 Response: $BODY1"
  else
    echo "409 Response: $BODY2"
  fi
  exit 0
elif [ "$SUCCESS_COUNT" -eq 2 ]; then
  echo ""
  echo "=== TEST FAILED ==="
  echo "BOTH requests succeeded - race condition NOT prevented!"
  echo "Response 1: $BODY1"
  echo "Response 2: $BODY2"
  exit 1
elif [ "$SUCCESS_COUNT" -eq 0 ]; then
  echo ""
  echo "=== TEST INCONCLUSIVE ==="
  echo "Neither request succeeded. Possible reasons:"
  echo "  - Ticket was already owned"
  echo "  - Auth issue"
  echo "Response 1 (HTTP $CODE1): $BODY1"
  echo "Response 2 (HTTP $CODE2): $BODY2"
  exit 1
else
  echo ""
  echo "=== TEST INCONCLUSIVE ==="
  echo "Unexpected result combination"
  echo "Response 1 (HTTP $CODE1): $BODY1"
  echo "Response 2 (HTTP $CODE2): $BODY2"
  exit 1
fi
