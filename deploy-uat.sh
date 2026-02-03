#!/usr/bin/env bash
set -euo pipefail

STATUS="$(railway status)"
echo "$STATUS"

if echo "$STATUS" | grep -qi "Service: MySQL"; then
  echo "ABORT: linked to MySQL service. Run: railway unlink && railway link"
  exit 1
fi

railway up --detach
