#!/usr/bin/env bash
set -euo pipefail

STATUS="$(railway status)"
echo "$STATUS"
echo "----------------------------------------"

# 1) Block if linked to MySQL
if echo "$STATUS" | grep -qi "Service: MySQL"; then
  echo "❌ ABORT: You are linked to a MySQL service."
  echo "Run: railway unlink && railway link"
  exit 1
fi

# 2) Ensure correct project
if ! echo "$STATUS" | grep -qi "Project: Apoyar Agentic V1"; then
  echo "❌ ABORT: Not linked to Apoyar Agentic V1 project."
  exit 1
fi

# 3) Ensure production environment
if ! echo "$STATUS" | grep -qi "Environment: production"; then
  echo "❌ ABORT: Not in production environment."
  echo "Hint: railway link -p \"Apoyar Agentic V1\" -e production -s web"
  exit 1
fi

# 4) Explicit human confirmation
echo
read -p "Type PRODUCTION to deploy to PRODUCTION: " CONFIRM
if [[ "$CONFIRM" != "PRODUCTION" ]]; then
  echo "❌ Deployment cancelled."
  exit 1
fi

echo
echo "🚀 Deploying to PRODUCTION..."
railway up --detach
