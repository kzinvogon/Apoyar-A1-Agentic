#!/usr/bin/env bash
# =============================================================================
# Production Deployment Script
# =============================================================================
# Runs parity gate (PROD is baseline) then deploys to production.
# Aborts if UAT is not in parity with PROD.
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║            PRODUCTION DEPLOYMENT GUARD                           ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# =============================================================================
# Step 1: Run Parity Gate (PROD is baseline)
# =============================================================================
echo -e "${YELLOW}Step 1: Running Parity Gate (PROD is baseline)${NC}"
echo ""

if ! npm run gate:uat; then
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║            DEPLOYMENT BLOCKED                                    ║${NC}"
  echo -e "${RED}║                                                                  ║${NC}"
  echo -e "${RED}║   UAT is not in parity with PRODUCTION.                         ║${NC}"
  echo -e "${RED}║   Fix the issues above before deploying.                        ║${NC}"
  echo -e "${RED}║                                                                  ║${NC}"
  echo -e "${RED}║   Summary of what UAT is missing vs PROD:                       ║${NC}"
  echo -e "${RED}║   - Check schema differences (tables, columns, indexes)         ║${NC}"
  echo -e "${RED}║   - Check smoke test failures (profile update, etc.)            ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════════════════╝${NC}"
  exit 1
fi

echo ""
echo -e "${GREEN}Parity gate passed!${NC}"
echo ""

# =============================================================================
# Step 2: Verify Railway Environment
# =============================================================================
echo -e "${YELLOW}Step 2: Verifying Railway environment${NC}"
echo ""

# Switch to production
source railway-env.sh prod 2>/dev/null || {
  echo -e "${RED}Failed to switch to production environment${NC}"
  exit 1
}

STATUS="$(railway status)"
echo "$STATUS"
echo "----------------------------------------"

# Block if linked to MySQL
if echo "$STATUS" | grep -qi "Service: MySQL"; then
  echo -e "${RED}ABORT: You are linked to a MySQL service.${NC}"
  echo "Run: railway unlink && railway link"
  source railway-env.sh uat 2>/dev/null
  exit 1
fi

# Ensure correct project
if ! echo "$STATUS" | grep -qi "Project: Apoyar Agentic V1"; then
  echo -e "${RED}ABORT: Not linked to Apoyar Agentic V1 project.${NC}"
  source railway-env.sh uat 2>/dev/null
  exit 1
fi

# Ensure production environment
if ! echo "$STATUS" | grep -qi "Environment: production"; then
  echo -e "${RED}ABORT: Not in production environment.${NC}"
  echo "Hint: railway link -p \"Apoyar Agentic V1\" -e production -s web"
  source railway-env.sh uat 2>/dev/null
  exit 1
fi

# =============================================================================
# Step 3: Human Confirmation
# =============================================================================
echo ""
echo -e "${YELLOW}Step 3: Human confirmation required${NC}"
echo ""
read -p "Type PRODUCTION to deploy to PRODUCTION: " CONFIRM
if [[ "$CONFIRM" != "PRODUCTION" ]]; then
  echo -e "${RED}Deployment cancelled.${NC}"
  source railway-env.sh uat 2>/dev/null
  exit 1
fi

# =============================================================================
# Step 4: Deploy
# =============================================================================
echo ""
echo -e "${GREEN}Deploying to PRODUCTION...${NC}"
railway redeploy --yes

# =============================================================================
# Step 5: Switch back to UAT
# =============================================================================
echo ""
echo -e "${YELLOW}Switching back to UAT...${NC}"
source railway-env.sh uat 2>/dev/null

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║            PRODUCTION DEPLOYMENT COMPLETE                        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Production URL: https://app.serviflow.app"
echo ""
