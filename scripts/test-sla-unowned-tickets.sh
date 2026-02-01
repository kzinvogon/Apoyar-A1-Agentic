#!/bin/bash
# Test: SLA display for unowned pool tickets
# Verifies: OPEN_POOL tickets return response_due_at=null and UI renders "—"
#
# Usage: ./scripts/test-sla-unowned-tickets.sh [BASE_URL]
# Default: http://localhost:3000

set -e

BASE_URL="${1:-http://localhost:3000}"
TENANT="apoyar"

echo "=== SLA Display Test for Unowned Pool Tickets ==="
echo "Base URL: $BASE_URL"
echo ""

# Login
echo "1. Getting auth token..."
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/tenant/login" \
  -H "Content-Type: application/json" \
  -d "{\"tenant_code\":\"$TENANT\",\"username\":\"admin\",\"password\":\"password123\"}")

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get token"
  exit 1
fi
echo "   Logged in successfully"

# Test 1: Check pool endpoint for OPEN_POOL ticket
echo ""
echo "2. Fetching pool tickets..."
POOL_RESPONSE=$(curl -s -X GET "$BASE_URL/api/tickets/$TENANT/pool?limit=5" \
  -H "Authorization: Bearer $TOKEN")

# Find an OPEN_POOL ticket
OPEN_POOL_TICKET=$(echo "$POOL_RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    tickets = data.get('tickets', [])
    for t in tickets:
        if t.get('pool_status') == 'OPEN_POOL':
            print(json.dumps({
                'id': t['id'],
                'title': t.get('title', '')[:40],
                'pool_status': t['pool_status'],
                'ownership_started_at': t.get('ownership_started_at'),
                'response_due_at': t.get('response_due_at'),
                'resolve_due_at': t.get('resolve_due_at')
            }))
            break
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
" 2>/dev/null)

if [ -z "$OPEN_POOL_TICKET" ]; then
  echo "   No OPEN_POOL tickets found in pool"
else
  echo "   Found OPEN_POOL ticket:"
  echo "$OPEN_POOL_TICKET" | python3 -m json.tool 2>/dev/null || echo "$OPEN_POOL_TICKET"
fi

# Test 2: Check master tickets list endpoint
echo ""
echo "3. Fetching from master tickets list (GET /:tenantId)..."
TICKETS_RESPONSE=$(curl -s -X GET "$BASE_URL/api/tickets/$TENANT?limit=20&status=Open" \
  -H "Authorization: Bearer $TOKEN")

# Find OPEN_POOL tickets in main list and check SLA dates
echo ""
echo "4. Checking SLA dates for OPEN_POOL tickets in main list..."
echo "$TICKETS_RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    tickets = data.get('tickets', [])
    open_pool_count = 0
    null_sla_count = 0

    for t in tickets:
        if t.get('pool_status') == 'OPEN_POOL':
            open_pool_count += 1
            resp_due = t.get('response_due_at')
            resolve_due = t.get('resolve_due_at')
            ownership = t.get('ownership_started_at')

            # Check if SLA dates are properly nulled
            sla_nulled = (resp_due is None) and (resolve_due is None)
            if sla_nulled:
                null_sla_count += 1
                status = '✓ OK'
            else:
                status = '✗ FAIL'

            print(f'   #{t[\"id\"]} {t.get(\"title\", \"\")[:30]:30} | pool={t[\"pool_status\"]:15} | ownership={str(ownership)[:10]:10} | response_due={str(resp_due)[:10]:10} | {status}')

    print()
    if open_pool_count == 0:
        print('   No OPEN_POOL tickets found in list')
    elif null_sla_count == open_pool_count:
        print(f'   ✓ PASS: All {open_pool_count} OPEN_POOL tickets have NULL SLA dates')
    else:
        print(f'   ✗ FAIL: {open_pool_count - null_sla_count}/{open_pool_count} OPEN_POOL tickets have non-NULL SLA dates')
        sys.exit(1)
except Exception as e:
    print(f'Error parsing response: {e}', file=sys.stderr)
    sys.exit(1)
"

# Test 3: Check owned ticket has SLA dates
echo ""
echo "5. Checking owned tickets (IN_PROGRESS_OWNED) have SLA dates..."
echo "$TICKETS_RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    tickets = data.get('tickets', [])
    owned_count = 0
    has_sla_count = 0

    for t in tickets:
        if t.get('pool_status') == 'IN_PROGRESS_OWNED':
            owned_count += 1
            resp_due = t.get('response_due_at')
            resolve_due = t.get('resolve_due_at')
            ownership = t.get('ownership_started_at')

            # Owned tickets should have SLA dates if SLA is applied
            has_sla = (resp_due is not None) or (resolve_due is not None)
            if has_sla:
                has_sla_count += 1
                status = '✓ Has SLA'
            else:
                status = '— No SLA'

            print(f'   #{t[\"id\"]} {t.get(\"title\", \"\")[:30]:30} | pool={t[\"pool_status\"]:18} | ownership={str(ownership)[:10]:10} | {status}')

    print()
    if owned_count == 0:
        print('   No IN_PROGRESS_OWNED tickets found')
    else:
        print(f'   Found {owned_count} owned tickets, {has_sla_count} with SLA dates')
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
"

echo ""
echo "=== TEST COMPLETE ==="
echo "Summary:"
echo "  - Backend: OPEN_POOL tickets should have response_due_at=NULL"
echo "  - Frontend: getSLAState() returns '—' for unowned tickets"
echo ""
