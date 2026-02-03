#!/bin/bash
# =============================================================================
# Profile Update Smoke Test - Dual Environment
# =============================================================================
# Runs profile update test against BOTH PROD and UAT.
# PROD is baseline - if PROD passes and UAT fails, gate fails.
#
# Usage: ./scripts/smoke/smoke-profile-update.sh
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
PROD_URL="${PROD_URL:-https://app.serviflow.app}"
UAT_URL="${UAT_URL:-https://web-uat-uat.up.railway.app}"
TENANT="apoyar"
USERNAME="${SMOKE_USERNAME:-admin}"
PASSWORD="${SMOKE_PASSWORD:-password123}"

# Test phone number with timestamp to verify update
TEST_PHONE="555-$(date +%H%M%S)"

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Profile Update Smoke Test${NC}"
echo -e "${BLUE}  PROD is baseline${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Function to run profile update test
run_profile_test() {
  local ENV_NAME=$1
  local BASE_URL=$2
  local RESULT_VAR=$3

  echo -e "${YELLOW}Testing ${ENV_NAME}: ${BASE_URL}${NC}"

  # Step 1: Login
  echo "  [1/4] Logging in as ${USERNAME}..."
  LOGIN_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/auth/tenant/login" \
    -H "Content-Type: application/json" \
    -d "{\"tenant_code\":\"${TENANT}\",\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}" \
    2>/dev/null)

  TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$TOKEN" ]; then
    echo -e "  ${RED}[FAIL] Login failed - no token received${NC}"
    eval "$RESULT_VAR=fail"
    return 1
  fi
  echo -e "  ${GREEN}[OK] Login successful${NC}"

  # Step 2: GET current profile
  echo "  [2/4] Fetching current profile..."
  PROFILE_RESPONSE=$(curl -s -X GET "${BASE_URL}/api/profile/${TENANT}/profile" \
    -H "Authorization: Bearer ${TOKEN}" \
    2>/dev/null)

  CURRENT_PHONE=$(echo "$PROFILE_RESPONSE" | grep -o '"contact_phone":"[^"]*"' | cut -d'"' -f4 || echo "")
  USER_SUCCESS=$(echo "$PROFILE_RESPONSE" | grep -o '"success":true' || echo "")

  if [ -z "$USER_SUCCESS" ]; then
    echo -e "  ${RED}[FAIL] Could not fetch profile${NC}"
    echo "  Response: ${PROFILE_RESPONSE:0:200}"
    eval "$RESULT_VAR=fail"
    return 1
  fi
  echo -e "  ${GREEN}[OK] Profile fetched (current contact_phone: ${CURRENT_PHONE:-empty})${NC}"

  # Step 3: UPDATE contact phone number
  echo "  [3/4] Updating contact_phone to ${TEST_PHONE}..."
  UPDATE_RESPONSE=$(curl -s -X PUT "${BASE_URL}/api/profile/${TENANT}/profile" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"contact_phone\":\"${TEST_PHONE}\"}" \
    2>/dev/null)

  UPDATE_SUCCESS=$(echo "$UPDATE_RESPONSE" | grep -o '"success":true' || echo "")

  if [ -z "$UPDATE_SUCCESS" ]; then
    echo -e "  ${RED}[FAIL] Profile update failed${NC}"
    echo "  Response: ${UPDATE_RESPONSE:0:200}"
    eval "$RESULT_VAR=fail"
    return 1
  fi
  echo -e "  ${GREEN}[OK] Profile updated${NC}"

  # Step 4: GET profile again to verify
  echo "  [4/4] Verifying update..."
  VERIFY_RESPONSE=$(curl -s -X GET "${BASE_URL}/api/profile/${TENANT}/profile" \
    -H "Authorization: Bearer ${TOKEN}" \
    2>/dev/null)

  NEW_PHONE=$(echo "$VERIFY_RESPONSE" | grep -o '"contact_phone":"[^"]*"' | cut -d'"' -f4 || echo "")

  if [ "$NEW_PHONE" != "$TEST_PHONE" ]; then
    echo -e "  ${RED}[FAIL] Phone not updated (expected: ${TEST_PHONE}, got: ${NEW_PHONE})${NC}"
    eval "$RESULT_VAR=fail"
    return 1
  fi

  echo -e "  ${GREEN}[OK] Phone verified: ${NEW_PHONE}${NC}"

  # Restore original phone (cleanup)
  if [ -n "$CURRENT_PHONE" ]; then
    curl -s -X PUT "${BASE_URL}/api/profile/${TENANT}/profile" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"contact_phone\":\"${CURRENT_PHONE}\"}" > /dev/null 2>&1
  fi

  echo -e "  ${GREEN}[PASS] ${ENV_NAME} profile update test passed${NC}"
  echo ""
  eval "$RESULT_VAR=pass"
  return 0
}

# Run tests
PROD_RESULT="unknown"
UAT_RESULT="unknown"

echo -e "${BLUE}--- Running PROD test (baseline) ---${NC}"
run_profile_test "PROD" "$PROD_URL" "PROD_RESULT" || true

echo -e "${BLUE}--- Running UAT test ---${NC}"
run_profile_test "UAT" "$UAT_URL" "UAT_RESULT" || true

# Evaluate results
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Results${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "  PROD: ${PROD_RESULT}"
echo -e "  UAT:  ${UAT_RESULT}"
echo ""

# Decision logic: PROD is baseline
if [ "$PROD_RESULT" = "pass" ] && [ "$UAT_RESULT" = "fail" ]; then
  echo -e "${RED}========================================${NC}"
  echo -e "${RED}  SMOKE TEST: FAILED${NC}"
  echo -e "${RED}  UAT broken: profile update works in PROD but fails in UAT${NC}"
  echo -e "${RED}========================================${NC}"
  exit 1
fi

if [ "$PROD_RESULT" = "fail" ] && [ "$UAT_RESULT" = "fail" ]; then
  echo -e "${YELLOW}========================================${NC}"
  echo -e "${YELLOW}  SMOKE TEST: INCONCLUSIVE${NC}"
  echo -e "${YELLOW}  Both environments failed - check credentials/connectivity${NC}"
  echo -e "${YELLOW}========================================${NC}"
  exit 1
fi

if [ "$PROD_RESULT" = "fail" ] && [ "$UAT_RESULT" = "pass" ]; then
  echo -e "${YELLOW}========================================${NC}"
  echo -e "${YELLOW}  SMOKE TEST: WARNING${NC}"
  echo -e "${YELLOW}  PROD failed but UAT passed - unusual state${NC}"
  echo -e "${YELLOW}========================================${NC}"
  exit 0
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  SMOKE TEST: PASSED${NC}"
echo -e "${GREEN}  Both PROD and UAT profile update working${NC}"
echo -e "${GREEN}========================================${NC}"
exit 0
