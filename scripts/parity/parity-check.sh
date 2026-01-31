#!/bin/bash
# =============================================================================
# parity-check.sh - Machine-enforced UAT/Production parity verification
# =============================================================================
# Exit codes: 0 = parity OK, 1 = parity violation
# This script is suitable for pre-deploy gates.
#
# Usage:
#   ./scripts/parity/parity-check.sh
#
# Prerequisites:
#   - Railway CLI installed and authenticated
#   - Access to both UAT and Production environments
#   - MySQL client available (for schema checks)
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_CONTRACT="$SCRIPT_DIR/schema-contract.json"
ALLOWLIST="$SCRIPT_DIR/allowlist.env"
TEMP_DIR=$(mktemp -d)
VIOLATIONS=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    VIOLATIONS=$((VIOLATIONS + 1))
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_info() {
    echo -e "[INFO] $1"
}

# =============================================================================
# Load allowlist
# =============================================================================
load_allowlist() {
    if [[ -f "$ALLOWLIST" ]]; then
        grep -v '^#' "$ALLOWLIST" | grep -v '^$' | sort -u > "$TEMP_DIR/allowlist.txt"
    else
        touch "$TEMP_DIR/allowlist.txt"
    fi
}

# =============================================================================
# Get services for an environment
# =============================================================================
get_services() {
    local env_name=$1
    local output_file=$2

    # Switch to environment
    railway environment "$env_name" > /dev/null 2>&1

    # List services - extract service names from status output
    # Format: "service-name | uuid | STATUS"
    railway service status --all 2>/dev/null | grep -E '^\S+\s+\|' | awk '{print $1}' | grep -v '^MySQL$' | sort -u > "$output_file" 2>/dev/null || true
}

# =============================================================================
# Get env var keys for a service
# =============================================================================
get_env_keys() {
    local env_name=$1
    local service_name=$2
    local output_file=$3

    # Switch to environment and link service
    railway environment "$env_name" > /dev/null 2>&1
    railway service "$service_name" > /dev/null 2>&1 || return 1

    # Get variables in KV format and extract keys only
    railway variables --kv 2>/dev/null | grep -E '^[A-Z_][A-Z0-9_]*=' | cut -d'=' -f1 | sort -u > "$output_file" 2>/dev/null || true
}

# =============================================================================
# Map service name to role
# =============================================================================
get_service_role() {
    local service_name=$1

    case "$service_name" in
        web|web-uat|web-prod)
            echo "web"
            ;;
        email-worker|email-worker-uat|email-worker-prod)
            echo "email-worker"
            ;;
        worker|worker-uat|worker-prod)
            echo "worker"
            ;;
        *)
            echo "$service_name"
            ;;
    esac
}

# =============================================================================
# 1) SERVICE PARITY CHECK
# =============================================================================
check_service_parity() {
    echo ""
    echo "=============================================="
    echo "1) SERVICE PARITY CHECK"
    echo "=============================================="

    # Get services for both environments
    get_services "uat" "$TEMP_DIR/uat_services.txt"
    get_services "production" "$TEMP_DIR/prod_services.txt"

    # Map to roles
    > "$TEMP_DIR/uat_roles.txt"
    > "$TEMP_DIR/prod_roles.txt"

    while read -r svc; do
        get_service_role "$svc" >> "$TEMP_DIR/uat_roles.txt"
    done < "$TEMP_DIR/uat_services.txt"

    while read -r svc; do
        get_service_role "$svc" >> "$TEMP_DIR/prod_roles.txt"
    done < "$TEMP_DIR/prod_services.txt"

    sort -u "$TEMP_DIR/uat_roles.txt" -o "$TEMP_DIR/uat_roles.txt"
    sort -u "$TEMP_DIR/prod_roles.txt" -o "$TEMP_DIR/prod_roles.txt"

    log_info "UAT services: $(cat "$TEMP_DIR/uat_services.txt" | tr '\n' ' ')"
    log_info "Production services: $(cat "$TEMP_DIR/prod_services.txt" | tr '\n' ' ')"

    # Required roles
    REQUIRED_ROLES="web email-worker"

    for role in $REQUIRED_ROLES; do
        if ! grep -q "^${role}$" "$TEMP_DIR/uat_roles.txt"; then
            log_fail "Required role '$role' missing in UAT"
        fi
        if ! grep -q "^${role}$" "$TEMP_DIR/prod_roles.txt"; then
            log_fail "Required role '$role' missing in Production"
        fi
    done

    # Check for extra services in UAT not in Production
    while read -r role; do
        if ! grep -q "^${role}$" "$TEMP_DIR/prod_roles.txt"; then
            log_fail "Extra role '$role' in UAT but not in Production"
        fi
    done < "$TEMP_DIR/uat_roles.txt"

    # Check for conditional 'worker' role
    if grep -q "^worker$" "$TEMP_DIR/uat_roles.txt" || grep -q "^worker$" "$TEMP_DIR/prod_roles.txt"; then
        if ! grep -q "^worker$" "$TEMP_DIR/uat_roles.txt"; then
            log_fail "Conditional role 'worker' exists in Production but missing in UAT"
        fi
        if ! grep -q "^worker$" "$TEMP_DIR/prod_roles.txt"; then
            log_fail "Conditional role 'worker' exists in UAT but missing in Production"
        fi
    fi

    if [[ $VIOLATIONS -eq 0 ]]; then
        log_pass "Service parity verified"
    fi
}

# =============================================================================
# 2) ENV VAR KEY PARITY CHECK
# =============================================================================
check_env_parity() {
    echo ""
    echo "=============================================="
    echo "2) ENV VAR KEY PARITY CHECK"
    echo "=============================================="

    load_allowlist

    # Check each role
    for role in web email-worker; do
        echo ""
        log_info "Checking env vars for role: $role"

        # Find actual service names
        UAT_SVC=$(grep -E "^${role}(-uat)?$" "$TEMP_DIR/uat_services.txt" | head -1)
        PROD_SVC=$(grep -E "^${role}(-prod)?$" "$TEMP_DIR/prod_services.txt" | head -1)

        if [[ -z "$UAT_SVC" ]]; then
            log_warn "No UAT service found for role $role"
            continue
        fi
        if [[ -z "$PROD_SVC" ]]; then
            log_warn "No Production service found for role $role"
            continue
        fi

        # Get env keys
        get_env_keys "uat" "$UAT_SVC" "$TEMP_DIR/uat_${role}_keys.txt"
        get_env_keys "production" "$PROD_SVC" "$TEMP_DIR/prod_${role}_keys.txt"

        # Filter out allowlist keys
        comm -23 "$TEMP_DIR/uat_${role}_keys.txt" "$TEMP_DIR/allowlist.txt" > "$TEMP_DIR/uat_${role}_filtered.txt"
        comm -23 "$TEMP_DIR/prod_${role}_keys.txt" "$TEMP_DIR/allowlist.txt" > "$TEMP_DIR/prod_${role}_filtered.txt"

        # Find differences
        comm -23 "$TEMP_DIR/uat_${role}_filtered.txt" "$TEMP_DIR/prod_${role}_filtered.txt" > "$TEMP_DIR/${role}_only_uat.txt"
        comm -13 "$TEMP_DIR/uat_${role}_filtered.txt" "$TEMP_DIR/prod_${role}_filtered.txt" > "$TEMP_DIR/${role}_only_prod.txt"

        # Report differences
        if [[ -s "$TEMP_DIR/${role}_only_uat.txt" ]]; then
            while read -r key; do
                log_fail "[$role] Key '$key' exists in UAT but not Production"
            done < "$TEMP_DIR/${role}_only_uat.txt"
        fi

        if [[ -s "$TEMP_DIR/${role}_only_prod.txt" ]]; then
            while read -r key; do
                log_fail "[$role] Key '$key' exists in Production but not UAT"
            done < "$TEMP_DIR/${role}_only_prod.txt"
        fi

        if [[ ! -s "$TEMP_DIR/${role}_only_uat.txt" ]] && [[ ! -s "$TEMP_DIR/${role}_only_prod.txt" ]]; then
            log_pass "[$role] Env var keys match"
        fi
    done
}

# =============================================================================
# 3) DB SCHEMA PRESENCE PARITY CHECK
# =============================================================================
check_schema_parity() {
    echo ""
    echo "=============================================="
    echo "3) DB SCHEMA PRESENCE PARITY CHECK"
    echo "=============================================="

    if [[ ! -f "$SCHEMA_CONTRACT" ]]; then
        log_fail "Schema contract file not found: $SCHEMA_CONTRACT"
        return
    fi

    # Read contract
    TENANT=$(jq -r '.tenant' "$SCHEMA_CONTRACT")
    TENANT_DB="a1_tenant_${TENANT}"

    # Get DB connection from Railway (production has the shared DB)
    railway environment production > /dev/null 2>&1
    railway service web > /dev/null 2>&1

    # Extract DB credentials from Railway variables (KV format)
    DB_HOST=$(railway variables --kv 2>/dev/null | grep '^MYSQLHOST=' | cut -d'=' -f2-)
    DB_PORT=$(railway variables --kv 2>/dev/null | grep '^MYSQLPORT=' | cut -d'=' -f2-)
    DB_USER=$(railway variables --kv 2>/dev/null | grep '^MYSQLUSER=' | cut -d'=' -f2-)
    DB_PASS=$(railway variables --kv 2>/dev/null | grep '^MYSQLPASSWORD=' | cut -d'=' -f2-)

    if [[ -z "$DB_HOST" ]] || [[ -z "$DB_PASS" ]]; then
        log_warn "Could not retrieve DB credentials from Railway. Skipping schema checks."
        return
    fi

    log_info "Checking schema in database: $TENANT_DB"

    # Check required tables
    REQUIRED_TABLES=$(jq -r '.required_tables[]' "$SCHEMA_CONTRACT")

    for table in $REQUIRED_TABLES; do
        RESULT=$(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" \
            -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TENANT_DB' AND table_name='$table'" 2>/dev/null)

        if [[ "$RESULT" -eq 1 ]]; then
            log_pass "Table '$table' exists"
        else
            log_fail "Table '$table' missing from $TENANT_DB"
        fi
    done

    # Check required columns
    for table in $(jq -r '.required_columns | keys[]' "$SCHEMA_CONTRACT"); do
        COLUMNS=$(jq -r ".required_columns.\"$table\"[]" "$SCHEMA_CONTRACT")

        for column in $COLUMNS; do
            RESULT=$(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" \
                -N -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$TENANT_DB' AND table_name='$table' AND column_name='$column'" 2>/dev/null)

            if [[ "$RESULT" -eq 1 ]]; then
                log_pass "Column '$table.$column' exists"
            else
                log_fail "Column '$table.$column' missing from $TENANT_DB"
            fi
        done
    done
}

# =============================================================================
# 4) RUNTIME PATH CAPABILITY CHECK
# =============================================================================
check_runtime_capability() {
    echo ""
    echo "=============================================="
    echo "4) RUNTIME PATH CAPABILITY CHECK (UAT)"
    echo "=============================================="

    # Check UAT email-worker env
    railway environment uat > /dev/null 2>&1

    # Find email-worker service
    EMAIL_WORKER_SVC=$(cat "$TEMP_DIR/uat_services.txt" | grep -E "^email-worker" | head -1)

    if [[ -z "$EMAIL_WORKER_SVC" ]]; then
        log_warn "No email-worker service found in UAT"
    else
        railway service "$EMAIL_WORKER_SVC" > /dev/null 2>&1

        # Check DISABLE_EMAIL_PROCESSING
        DISABLE_FLAG=$(railway variables --kv 2>/dev/null | grep '^DISABLE_EMAIL_PROCESSING=' | cut -d'=' -f2-)

        if [[ "$DISABLE_FLAG" == "true" ]]; then
            log_warn "DISABLE_EMAIL_PROCESSING=true in UAT (email processing disabled)"
        else
            log_pass "DISABLE_EMAIL_PROCESSING is not set to true in UAT"
        fi
    fi

    # Check DB for email capability
    railway environment production > /dev/null 2>&1
    railway service web > /dev/null 2>&1

    DB_HOST=$(railway variables --kv 2>/dev/null | grep '^MYSQLHOST=' | cut -d'=' -f2-)
    DB_PORT=$(railway variables --kv 2>/dev/null | grep '^MYSQLPORT=' | cut -d'=' -f2-)
    DB_USER=$(railway variables --kv 2>/dev/null | grep '^MYSQLUSER=' | cut -d'=' -f2-)
    DB_PASS=$(railway variables --kv 2>/dev/null | grep '^MYSQLPASSWORD=' | cut -d'=' -f2-)

    TENANT=$(jq -r '.tenant' "$SCHEMA_CONTRACT")
    TENANT_DB="a1_tenant_${TENANT}"

    if [[ -n "$DB_HOST" ]] && [[ -n "$DB_PASS" ]]; then
        # Check tenant_settings.process_emails column exists (already checked in schema)

        # Check email_ingest_settings has at least one row
        ROW_COUNT=$(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" \
            -N -e "SELECT COUNT(*) FROM $TENANT_DB.email_ingest_settings" 2>/dev/null)

        if [[ "$ROW_COUNT" -gt 0 ]]; then
            log_pass "email_ingest_settings has $ROW_COUNT row(s) - email capability exists"
        else
            log_warn "email_ingest_settings is empty - no mailboxes configured"
        fi
    fi
}

# =============================================================================
# MAIN
# =============================================================================
main() {
    echo "=============================================="
    echo "PARITY CHECK - UAT vs Production"
    echo "=============================================="
    echo "Timestamp: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
    echo ""

    # Verify Railway CLI
    if ! command -v railway &> /dev/null; then
        echo "ERROR: Railway CLI not found"
        exit 1
    fi

    # Verify jq
    if ! command -v jq &> /dev/null; then
        echo "ERROR: jq not found (required for JSON parsing)"
        exit 1
    fi

    check_service_parity
    check_env_parity
    check_schema_parity
    check_runtime_capability

    echo ""
    echo "=============================================="
    echo "SUMMARY"
    echo "=============================================="

    if [[ $VIOLATIONS -eq 0 ]]; then
        echo -e "${GREEN}PARITY CHECK PASSED${NC} - No violations detected"
        exit 0
    else
        echo -e "${RED}PARITY CHECK FAILED${NC} - $VIOLATIONS violation(s) detected"
        exit 1
    fi
}

main "$@"
