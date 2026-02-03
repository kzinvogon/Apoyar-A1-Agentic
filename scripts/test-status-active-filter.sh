#!/bin/bash
# =============================================================================
# Smoke Test: Active Status Filter
# =============================================================================
# Verifies that status=active correctly excludes Resolved and Closed tickets
#
# Usage: ./scripts/test-status-active-filter.sh [BASE_URL]
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
BASE_URL="${1:-https://web-uat-uat.up.railway.app}"
TENANT="apoyar"
USERNAME="${SMOKE_USERNAME:-admin}"
PASSWORD="${SMOKE_PASSWORD:-password123}"

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Active Status Filter Smoke Test${NC}"
echo -e "${BLUE}  Target: ${BASE_URL}${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Step 1: Login
echo -e "${YELLOW}[1/4] Logging in as ${USERNAME}...${NC}"
LOGIN_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/auth/tenant/login" \
  -H "Content-Type: application/json" \
  -d "{\"tenant_code\":\"${TENANT}\",\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}" \
  2>/dev/null)

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo -e "${RED}[FAIL] Login failed - no token received${NC}"
  echo "Response: ${LOGIN_RESPONSE:0:200}"
  exit 1
fi
echo -e "${GREEN}[OK] Login successful${NC}"
echo ""

# Step 2: Get ALL tickets (no status filter)
echo -e "${YELLOW}[2/4] Fetching ALL tickets (no filter)...${NC}"
ALL_RESPONSE=$(curl -s -X GET "${BASE_URL}/api/tickets/${TENANT}?limit=1000" \
  -H "Authorization: Bearer ${TOKEN}" \
  2>/dev/null)

ALL_TOTAL=$(echo "$ALL_RESPONSE" | grep -o '"total":[0-9]*' | head -1 | cut -d':' -f2)
echo -e "  Total tickets (all): ${ALL_TOTAL:-0}"

# Extract status counts from all tickets
ALL_STATUSES=$(echo "$ALL_RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 | sort | uniq -c | sort -rn)
echo -e "  Status breakdown:"
echo "$ALL_STATUSES" | while read count status; do
  echo "    $status: $count"
done
echo ""

# Step 3: Get ACTIVE tickets (status=active)
echo -e "${YELLOW}[3/4] Fetching ACTIVE tickets (status=active)...${NC}"
ACTIVE_RESPONSE=$(curl -s -X GET "${BASE_URL}/api/tickets/${TENANT}?status=active&limit=1000" \
  -H "Authorization: Bearer ${TOKEN}" \
  2>/dev/null)

ACTIVE_TOTAL=$(echo "$ACTIVE_RESPONSE" | grep -o '"total":[0-9]*' | head -1 | cut -d':' -f2)
echo -e "  Total tickets (active): ${ACTIVE_TOTAL:-0}"

# Extract status counts from active tickets
ACTIVE_STATUSES=$(echo "$ACTIVE_RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 | sort | uniq -c | sort -rn)
echo -e "  Status breakdown:"
echo "$ACTIVE_STATUSES" | while read count status; do
  echo "    $status: $count"
done

# Check that no Resolved or Closed tickets are returned
HAS_RESOLVED=$(echo "$ACTIVE_RESPONSE" | grep -o '"status":"Resolved"' | wc -l | tr -d ' ')
HAS_CLOSED=$(echo "$ACTIVE_RESPONSE" | grep -o '"status":"Closed"' | wc -l | tr -d ' ')

echo ""
if [ "$HAS_RESOLVED" -gt 0 ] || [ "$HAS_CLOSED" -gt 0 ]; then
  echo -e "${RED}[FAIL] Active filter returned Resolved ($HAS_RESOLVED) or Closed ($HAS_CLOSED) tickets!${NC}"
  exit 1
fi
echo -e "${GREEN}[OK] No Resolved or Closed tickets in active results${NC}"
echo ""

# Step 4: Verify counts match
echo -e "${YELLOW}[4/4] Verifying counts...${NC}"

# Get Resolved + Closed count
RESOLVED_CLOSED_RESPONSE=$(curl -s -X GET "${BASE_URL}/api/tickets/${TENANT}?status=Resolved,Closed&limit=1" \
  -H "Authorization: Bearer ${TOKEN}" \
  2>/dev/null)

RESOLVED_CLOSED_TOTAL=$(echo "$RESOLVED_CLOSED_RESPONSE" | grep -o '"total":[0-9]*' | head -1 | cut -d':' -f2)
RESOLVED_CLOSED_TOTAL=${RESOLVED_CLOSED_TOTAL:-0}

echo -e "  Resolved + Closed tickets: ${RESOLVED_CLOSED_TOTAL}"

# Calculate expected active count
EXPECTED_ACTIVE=$((ALL_TOTAL - RESOLVED_CLOSED_TOTAL))
echo -e "  Expected active (all - resolved/closed): ${EXPECTED_ACTIVE}"
echo -e "  Actual active (status=active): ${ACTIVE_TOTAL:-0}"

if [ "${ACTIVE_TOTAL:-0}" -eq "$EXPECTED_ACTIVE" ]; then
  echo -e "${GREEN}[OK] Counts match!${NC}"
else
  echo -e "${RED}[FAIL] Count mismatch: expected ${EXPECTED_ACTIVE}, got ${ACTIVE_TOTAL:-0}${NC}"
  exit 1
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  SMOKE TEST: PASSED${NC}"
echo -e "${GREEN}  Active filter correctly excludes${NC}"
echo -e "${GREEN}  Resolved and Closed tickets${NC}"
echo -e "${GREEN}========================================${NC}"
exit 0
