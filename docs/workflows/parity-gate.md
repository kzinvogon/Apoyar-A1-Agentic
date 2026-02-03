# Parity Gate Workflow

## Overview

**PRODUCTION is the reference baseline. UAT must match PRODUCTION.**

The parity gate ensures UAT is in sync with PROD before any production deployment. If UAT is missing anything that exists in PROD (services, env vars, schema elements, or behavior), the deployment is blocked.

## Philosophy

- PROD is assumed correct and stable
- UAT must not be missing anything PROD has
- Differences are only allowed if explicitly allowlisted
- Gate fails with message: "UAT missing X that exists in PROD"

## Components

### A) Service Parity (`scripts/parity/check-services.js`)

Compares Railway services between PROD and UAT.

- **Fails if:** UAT is missing a service that exists in PROD
- **Allowlist:** `scripts/parity/allowlist.services.json`

```json
{
  "allow_missing_in_uat": ["mysql", "redis"],
  "allow_missing_in_prod": ["web-uat", "email-worker-uat"]
}
```

### B) Env Var Parity (`scripts/parity/check-env.js`)

Compares environment variables for each service pair.

- **Fails if:** UAT is missing an env var that exists in PROD
- **Allowlist:** `scripts/parity/allowlist.envvars.json`

```json
{
  "allow_missing_in_uat": ["RAILWAY_DEPLOYMENT_ID"],
  "allow_value_different": ["MYSQLHOST", "PORT", "NODE_ENV"]
}
```

### C) Schema Parity (`scripts/parity/check-schema-parity.js`)

Compares MySQL schemas between PROD and UAT databases.

**Databases compared:**
- `a1_master`
- `a1_tenant_apoyar`

**Checks:**
- Table presence
- Column presence and type (VARCHAR length, NULLability)
- Indexes (unique keys)

- **Fails if:** UAT is missing a table, column, or unique index that exists in PROD
- **Allowlist:** `scripts/parity/allowlist.schema.json`

```json
{
  "allow_missing_tables_in_uat": [],
  "allow_missing_columns_in_uat": ["tickets.legacy_field"],
  "allow_missing_indexes_in_uat": [],
  "allow_type_differences": []
}
```

### D) Behavior Parity (Smoke Tests)

**Mandatory test: Profile Update** (`scripts/smoke/smoke-profile-update.sh`)

Runs against BOTH PROD and UAT:
1. Login as expert/admin
2. GET profile
3. PUT update phone
4. GET profile and verify change

**Decision logic:**
- If PROD passes and UAT fails → **GATE FAILS** ("UAT broken: profile update")
- If both pass → GATE PASSES
- If both fail → INCONCLUSIVE (check credentials)

## NPM Scripts

```bash
# Run schema parity check only
npm run gate:schema

# Run all diff checks (schema)
npm run gate:diff

# Run smoke tests only
npm run gate:smoke

# Run full gate (diff + smoke) - required before prod deploy
npm run gate:uat
```

## Deployment Guard

The `deploy-prod.sh` script automatically runs `npm run gate:uat` before deployment:

```bash
./deploy-prod.sh
```

**Flow:**
1. Run parity gate
2. If gate fails → abort with summary of what UAT is missing
3. If gate passes → verify Railway environment
4. Human confirmation (type "PRODUCTION")
5. Deploy to production
6. Switch back to UAT

## Configuration

### Environment Variables

For schema parity, set these in `.env` or environment:

```bash
# Production database
PROD_DB_HOST=tramway.proxy.rlwy.net
PROD_DB_PORT=19355
PROD_DB_USER=root
PROD_DB_PASSWORD=xxx

# UAT database
UAT_DB_HOST=tramway.proxy.rlwy.net
UAT_DB_PORT=20773
UAT_DB_USER=serviflow_app
UAT_DB_PASSWORD=xxx
```

### Smoke Test Credentials

```bash
SMOKE_USERNAME=expert
SMOKE_PASSWORD=password123
PROD_URL=https://app.serviflow.app
UAT_URL=https://web-uat-uat.up.railway.app
```

## Adding Allowlist Entries

When you intentionally have differences between PROD and UAT:

1. Edit the appropriate allowlist file
2. Add the item to the correct list
3. Commit the allowlist change
4. Re-run the gate

**Example: Allow a column to be missing in UAT temporarily:**

```json
// scripts/parity/allowlist.schema.json
{
  "allow_missing_columns_in_uat": ["tickets.new_feature_flag"]
}
```

## Troubleshooting

### Gate says "UAT missing table X"

1. Run the migration on UAT database
2. Or add to `allow_missing_tables_in_uat` if intentional

### Gate says "UAT missing column X"

1. ALTER TABLE to add the column in UAT
2. Or add to `allow_missing_columns_in_uat` if intentional

### Smoke test fails on UAT

1. Check UAT logs for errors
2. Verify the endpoint exists and works
3. Test manually with curl

### Schema check can't connect

1. Verify database credentials in environment
2. Check network access to Railway MySQL
3. Ensure IP is allowlisted if applicable
