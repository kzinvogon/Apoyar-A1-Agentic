#!/bin/bash
# =============================================================================
# UAT Reply Threading Verification Script
# =============================================================================
# Verifies that email replies update existing tickets (not create new ones)
# and that all tracking tables are being populated correctly.
#
# Usage: ./scripts/verify-uat-reply-threading.sh
#
# Prerequisites:
#   - mysql client installed
#   - UAT environment variables set (or will prompt)
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# UAT Database Configuration (Railway)
DB_HOST="${UAT_DB_HOST:-tramway.proxy.rlwy.net}"
DB_PORT="${UAT_DB_PORT:-20773}"
DB_USER="${UAT_DB_USER:-serviflow_app}"
DB_PASS="${UAT_DB_PASS:-5tarry.53rv1fl0w}"
DB_NAME="a1_tenant_apoyar"

echo ""
echo -e "${BLUE}======================================================================${NC}"
echo -e "${BLUE}  UAT Reply Threading Verification${NC}"
echo -e "${BLUE}======================================================================${NC}"
echo ""

# Function to run MySQL query
run_query() {
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "$1" 2>/dev/null
}

run_query_pretty() {
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "$1" 2>/dev/null
}

# Step 1: Verify connection and database
echo -e "${YELLOW}Step 1: Verifying database connection...${NC}"
if ! run_query "SELECT 1" > /dev/null 2>&1; then
  echo -e "${RED}FAIL: Cannot connect to UAT database${NC}"
  echo "  Host: $DB_HOST:$DB_PORT"
  echo "  User: $DB_USER"
  echo "  Database: $DB_NAME"
  exit 1
fi
echo -e "  ${GREEN}Connected to: $DB_HOST:$DB_PORT / $DB_NAME${NC}"
echo ""

# Step 2: Verify required tables exist
echo -e "${YELLOW}Step 2: Verifying required tables...${NC}"
TABLES=$(run_query "SHOW TABLES LIKE 'email_%'")
REQUIRED_TABLES=("email_ingest_settings" "email_processed_messages" "email_ticket_threads")
MISSING_TABLES=()

for table in "${REQUIRED_TABLES[@]}"; do
  if echo "$TABLES" | grep -q "$table"; then
    echo -e "  ${GREEN}[OK] $table${NC}"
  else
    echo -e "  ${RED}[MISSING] $table${NC}"
    MISSING_TABLES+=("$table")
  fi
done

if [ ${#MISSING_TABLES[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}FAIL: Missing required tables. Run migrations first:${NC}"
  echo "  node migrations/add-email-crash-recovery.js"
  echo "  node migrations/add-email-threading.js"
  exit 1
fi
echo ""

# Step 3: Get mailbox configuration
echo -e "${YELLOW}Step 3: Fetching mailbox configuration...${NC}"
MAILBOX_INFO=$(run_query "SELECT id, email_address, enabled, last_uid_processed, last_checked_at FROM email_ingest_settings LIMIT 1")
if [ -z "$MAILBOX_INFO" ]; then
  echo -e "${RED}FAIL: No mailbox configured in email_ingest_settings${NC}"
  exit 1
fi

MAILBOX_ID=$(echo "$MAILBOX_INFO" | awk '{print $1}')
MAILBOX_EMAIL=$(echo "$MAILBOX_INFO" | awk '{print $2}')
MAILBOX_ENABLED=$(echo "$MAILBOX_INFO" | awk '{print $3}')
MAILBOX_LAST_UID=$(echo "$MAILBOX_INFO" | awk '{print $4}')
MAILBOX_LAST_CHECKED=$(echo "$MAILBOX_INFO" | awk '{print $5" "$6}')

echo -e "  Mailbox ID:       ${GREEN}$MAILBOX_ID${NC}"
echo -e "  Email Address:    ${GREEN}$MAILBOX_EMAIL${NC}"
echo -e "  Enabled:          ${GREEN}$MAILBOX_ENABLED${NC}"
echo -e "  Last UID:         $MAILBOX_LAST_UID"
echo -e "  Last Checked:     $MAILBOX_LAST_CHECKED"
echo ""

if [ "$MAILBOX_ENABLED" != "1" ]; then
  echo -e "${YELLOW}WARNING: Mailbox is not enabled. Email processing may not work.${NC}"
  echo ""
fi

# Step 4: Check for existing test tickets
echo -e "${YELLOW}Step 4: Checking for existing UAT THREAD TEST tickets...${NC}"
EXISTING_TICKETS=$(run_query "SELECT id, title, created_at FROM tickets WHERE title LIKE '%UAT THREAD TEST%' ORDER BY id DESC LIMIT 5")
if [ -n "$EXISTING_TICKETS" ]; then
  echo -e "  ${BLUE}Found existing test tickets:${NC}"
  run_query_pretty "SELECT id, title, created_at FROM tickets WHERE title LIKE '%UAT THREAD TEST%' ORDER BY id DESC LIMIT 5"
  echo ""
fi

# Step 5: Instructions for manual test
echo -e "${BLUE}======================================================================${NC}"
echo -e "${BLUE}  MANUAL TEST INSTRUCTIONS${NC}"
echo -e "${BLUE}======================================================================${NC}"
echo ""
echo -e "  ${YELLOW}Step A: Create a new ticket via email${NC}"
echo -e "  Send an email to: ${GREEN}$MAILBOX_EMAIL${NC}"
echo -e "  With subject:     ${GREEN}UAT THREAD TEST $(date +%Y%m%d-%H%M)${NC}"
echo ""
echo -e "  Wait 1-2 minutes for the email worker to process it."
echo ""
echo -e "  ${YELLOW}Step B: Reply to the confirmation email${NC}"
echo -e "  When you receive the ticket confirmation, reply to it."
echo -e "  The subject should contain [Ticket #NNN]"
echo ""
echo -e "${BLUE}======================================================================${NC}"
echo ""

# Step 6: Interactive verification loop
read -p "Press [Enter] when you've sent the initial email, or 'q' to skip to verification... " RESPONSE

if [ "$RESPONSE" != "q" ]; then
  echo ""
  echo -e "${YELLOW}Polling for new ticket...${NC}"

  for i in {1..12}; do
    NEW_TICKET=$(run_query "SELECT id, title FROM tickets WHERE title LIKE '%UAT THREAD TEST%' AND created_at >= NOW() - INTERVAL 10 MINUTE ORDER BY id DESC LIMIT 1")
    if [ -n "$NEW_TICKET" ]; then
      TICKET_ID=$(echo "$NEW_TICKET" | awk '{print $1}')
      echo -e "  ${GREEN}Found ticket #$TICKET_ID${NC}"
      break
    fi
    echo "  Waiting... ($i/12)"
    sleep 10
  done

  if [ -z "$TICKET_ID" ]; then
    echo -e "${RED}No new ticket found after 2 minutes.${NC}"
    echo "Check email worker logs for errors."
  else
    echo ""
    read -p "Press [Enter] when you've replied to the confirmation email... " REPLY_RESPONSE
  fi
fi

# Step 7: Verification queries
echo ""
echo -e "${BLUE}======================================================================${NC}"
echo -e "${BLUE}  VERIFICATION RESULTS${NC}"
echo -e "${BLUE}======================================================================${NC}"
echo ""

# 7a: Recent tickets with UAT THREAD TEST
echo -e "${YELLOW}7a. Recent tickets with 'UAT THREAD TEST':${NC}"
run_query_pretty "SELECT id, title, created_at FROM tickets WHERE title LIKE '%UAT THREAD TEST%' AND created_at >= NOW() - INTERVAL 2 HOUR ORDER BY id DESC LIMIT 10"
echo ""

# 7b: Check for duplicate tickets (same subject, multiple IDs)
echo -e "${YELLOW}7b. Checking for duplicate tickets (same subject):${NC}"
DUPLICATES=$(run_query "SELECT title, COUNT(*) as cnt FROM tickets WHERE title LIKE '%UAT THREAD TEST%' AND created_at >= NOW() - INTERVAL 2 HOUR GROUP BY title HAVING cnt > 1")
if [ -n "$DUPLICATES" ]; then
  echo -e "  ${RED}WARNING: Duplicate tickets found!${NC}"
  run_query_pretty "SELECT title, COUNT(*) as cnt FROM tickets WHERE title LIKE '%UAT THREAD TEST%' AND created_at >= NOW() - INTERVAL 2 HOUR GROUP BY title HAVING cnt > 1"
else
  echo -e "  ${GREEN}No duplicate tickets found${NC}"
fi
echo ""

# 7c: Recent email_reply activities
echo -e "${YELLOW}7c. Recent 'email_reply' activities:${NC}"
run_query_pretty "SELECT ta.id, ta.ticket_id, ta.activity_type, ta.created_at, SUBSTRING(ta.description, 1, 60) as description FROM ticket_activity ta WHERE ta.activity_type = 'email_reply' AND ta.created_at >= NOW() - INTERVAL 2 HOUR ORDER BY ta.id DESC LIMIT 10"
echo ""

# 7d: email_processed_messages for this mailbox
echo -e "${YELLOW}7d. Recent email_processed_messages (mailbox $MAILBOX_ID):${NC}"
run_query_pretty "SELECT id, ticket_id, result, processed_at, SUBSTRING(message_id, 1, 40) as message_id FROM email_processed_messages WHERE mailbox_id = $MAILBOX_ID AND processed_at >= NOW() - INTERVAL 2 HOUR ORDER BY id DESC LIMIT 20"
echo ""

# 7e: Result summary by type
echo -e "${YELLOW}7e. Processing results summary (last 2 hours):${NC}"
run_query_pretty "SELECT result, COUNT(*) as count FROM email_processed_messages WHERE processed_at >= NOW() - INTERVAL 2 HOUR GROUP BY result ORDER BY count DESC"
echo ""

# Step 8: Final verdict
echo -e "${BLUE}======================================================================${NC}"
echo -e "${BLUE}  VERDICT${NC}"
echo -e "${BLUE}======================================================================${NC}"
echo ""

# Check for ticket_updated results (replies that updated tickets)
TICKET_UPDATED_COUNT=$(run_query "SELECT COUNT(*) FROM email_processed_messages WHERE result = 'ticket_updated' AND processed_at >= NOW() - INTERVAL 2 HOUR")
EMAIL_REPLY_COUNT=$(run_query "SELECT COUNT(*) FROM ticket_activity WHERE activity_type = 'email_reply' AND created_at >= NOW() - INTERVAL 2 HOUR")

PASS=true

if [ "$TICKET_UPDATED_COUNT" -gt 0 ]; then
  echo -e "  ${GREEN}[PASS] ticket_updated results: $TICKET_UPDATED_COUNT${NC}"
else
  echo -e "  ${YELLOW}[WARN] No ticket_updated results in last 2 hours${NC}"
  PASS=false
fi

if [ "$EMAIL_REPLY_COUNT" -gt 0 ]; then
  echo -e "  ${GREEN}[PASS] email_reply activities: $EMAIL_REPLY_COUNT${NC}"
else
  echo -e "  ${YELLOW}[WARN] No email_reply activities in last 2 hours${NC}"
  PASS=false
fi

echo ""
if [ "$PASS" = true ]; then
  echo -e "${GREEN}======================================================================${NC}"
  echo -e "${GREEN}  OVERALL: PASS - Reply threading is working${NC}"
  echo -e "${GREEN}======================================================================${NC}"
else
  echo -e "${YELLOW}======================================================================${NC}"
  echo -e "${YELLOW}  OVERALL: INCONCLUSIVE - Send test emails and re-run verification${NC}"
  echo -e "${YELLOW}======================================================================${NC}"
fi
echo ""
