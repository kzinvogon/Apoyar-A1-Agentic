#!/bin/bash
# =============================================================================
# parity-report.sh - Human-readable UAT/Production parity report
# =============================================================================
# Generates a detailed report showing current state of both environments.
# For machine-enforced checks, use parity-check.sh instead.
#
# Usage:
#   ./scripts/parity/parity-report.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_CONTRACT="$SCRIPT_DIR/schema-contract.json"
ALLOWLIST="$SCRIPT_DIR/allowlist.env"
TEMP_DIR=$(mktemp -d)

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

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

    railway environment "$env_name" > /dev/null 2>&1
    railway service "$service_name" > /dev/null 2>&1 || return 1
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
# MAIN REPORT
# =============================================================================
main() {
    echo "==============================================================================="
    echo "                    PARITY REPORT - UAT vs Production"
    echo "==============================================================================="
    echo ""
    echo "Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
    echo "Script:    $0"
    echo ""

    # Verify Railway CLI
    if ! command -v railway &> /dev/null; then
        echo "ERROR: Railway CLI not found"
        exit 1
    fi

    # Current Railway context
    echo "-------------------------------------------------------------------------------"
    echo "RAILWAY CONTEXT"
    echo "-------------------------------------------------------------------------------"
    railway whoami 2>/dev/null || echo "Not logged in"
    echo ""

    # ==========================================================================
    # SERVICES
    # ==========================================================================
    echo "-------------------------------------------------------------------------------"
    echo "SERVICES BY ENVIRONMENT"
    echo "-------------------------------------------------------------------------------"
    echo ""

    echo "UAT Services:"
    get_services "uat" "$TEMP_DIR/uat_services.txt"
    if [[ -s "$TEMP_DIR/uat_services.txt" ]]; then
        while read -r svc; do
            role=$(get_service_role "$svc")
            echo "  - $svc (role: $role)"
        done < "$TEMP_DIR/uat_services.txt"
    else
        echo "  (none detected)"
    fi
    echo ""

    echo "Production Services:"
    get_services "production" "$TEMP_DIR/prod_services.txt"
    if [[ -s "$TEMP_DIR/prod_services.txt" ]]; then
        while read -r svc; do
            role=$(get_service_role "$svc")
            echo "  - $svc (role: $role)"
        done < "$TEMP_DIR/prod_services.txt"
    else
        echo "  (none detected)"
    fi
    echo ""

    # ==========================================================================
    # ENV VAR KEY COMPARISON
    # ==========================================================================
    echo "-------------------------------------------------------------------------------"
    echo "ENV VAR KEY COMPARISON (excluding allowlisted keys)"
    echo "-------------------------------------------------------------------------------"
    echo ""

    load_allowlist

    for role in web email-worker; do
        echo "Role: $role"
        echo "~~~~~~~~"

        # Find actual service names
        UAT_SVC=$(grep -E "^${role}(-uat)?$" "$TEMP_DIR/uat_services.txt" 2>/dev/null | head -1)
        PROD_SVC=$(grep -E "^${role}(-prod)?$" "$TEMP_DIR/prod_services.txt" 2>/dev/null | head -1)

        if [[ -z "$UAT_SVC" ]]; then
            echo "  UAT service: NOT FOUND"
            echo ""
            continue
        fi
        if [[ -z "$PROD_SVC" ]]; then
            echo "  Production service: NOT FOUND"
            echo ""
            continue
        fi

        echo "  UAT service: $UAT_SVC"
        echo "  Production service: $PROD_SVC"

        get_env_keys "uat" "$UAT_SVC" "$TEMP_DIR/uat_${role}_keys.txt"
        get_env_keys "production" "$PROD_SVC" "$TEMP_DIR/prod_${role}_keys.txt"

        UAT_COUNT=$(wc -l < "$TEMP_DIR/uat_${role}_keys.txt" | tr -d ' ')
        PROD_COUNT=$(wc -l < "$TEMP_DIR/prod_${role}_keys.txt" | tr -d ' ')

        echo "  UAT key count: $UAT_COUNT"
        echo "  Production key count: $PROD_COUNT"

        # Filter out allowlist
        comm -23 "$TEMP_DIR/uat_${role}_keys.txt" "$TEMP_DIR/allowlist.txt" > "$TEMP_DIR/uat_${role}_filtered.txt"
        comm -23 "$TEMP_DIR/prod_${role}_keys.txt" "$TEMP_DIR/allowlist.txt" > "$TEMP_DIR/prod_${role}_filtered.txt"

        # Find differences
        comm -23 "$TEMP_DIR/uat_${role}_filtered.txt" "$TEMP_DIR/prod_${role}_filtered.txt" > "$TEMP_DIR/${role}_only_uat.txt"
        comm -13 "$TEMP_DIR/uat_${role}_filtered.txt" "$TEMP_DIR/prod_${role}_filtered.txt" > "$TEMP_DIR/${role}_only_prod.txt"

        if [[ -s "$TEMP_DIR/${role}_only_uat.txt" ]]; then
            echo "  Keys ONLY in UAT:"
            while read -r key; do
                echo "    - $key"
            done < "$TEMP_DIR/${role}_only_uat.txt"
        fi

        if [[ -s "$TEMP_DIR/${role}_only_prod.txt" ]]; then
            echo "  Keys ONLY in Production:"
            while read -r key; do
                echo "    - $key"
            done < "$TEMP_DIR/${role}_only_prod.txt"
        fi

        if [[ ! -s "$TEMP_DIR/${role}_only_uat.txt" ]] && [[ ! -s "$TEMP_DIR/${role}_only_prod.txt" ]]; then
            echo "  Keys MATCH (after filtering allowlist)"
        fi

        echo ""
    done

    # ==========================================================================
    # DB SCHEMA CHECK
    # ==========================================================================
    echo "-------------------------------------------------------------------------------"
    echo "DB SCHEMA PRESENCE CHECK"
    echo "-------------------------------------------------------------------------------"
    echo ""

    if [[ ! -f "$SCHEMA_CONTRACT" ]]; then
        echo "Schema contract file not found: $SCHEMA_CONTRACT"
    else
        TENANT=$(jq -r '.tenant' "$SCHEMA_CONTRACT")
        TENANT_DB="a1_tenant_${TENANT}"
        echo "Tenant database: $TENANT_DB"
        echo ""

        # Get DB connection
        railway environment production > /dev/null 2>&1
        railway service web > /dev/null 2>&1

        DB_HOST=$(railway variables --kv 2>/dev/null | grep '^MYSQLHOST=' | cut -d'=' -f2-)
        DB_PORT=$(railway variables --kv 2>/dev/null | grep '^MYSQLPORT=' | cut -d'=' -f2-)
        DB_USER=$(railway variables --kv 2>/dev/null | grep '^MYSQLUSER=' | cut -d'=' -f2-)
        DB_PASS=$(railway variables --kv 2>/dev/null | grep '^MYSQLPASSWORD=' | cut -d'=' -f2-)

        if [[ -z "$DB_HOST" ]] || [[ -z "$DB_PASS" ]]; then
            echo "Could not retrieve DB credentials. Skipping schema checks."
        else
            echo "Required Tables:"
            REQUIRED_TABLES=$(jq -r '.required_tables[]' "$SCHEMA_CONTRACT")

            for table in $REQUIRED_TABLES; do
                RESULT=$(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" \
                    -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TENANT_DB' AND table_name='$table'" 2>/dev/null)

                if [[ "$RESULT" -eq 1 ]]; then
                    echo "  [OK]   $table"
                else
                    echo "  [MISS] $table"
                fi
            done
            echo ""

            echo "Required Columns:"
            for table in $(jq -r '.required_columns | keys[]' "$SCHEMA_CONTRACT"); do
                COLUMNS=$(jq -r ".required_columns.\"$table\"[]" "$SCHEMA_CONTRACT")

                for column in $COLUMNS; do
                    RESULT=$(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" \
                        -N -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$TENANT_DB' AND table_name='$table' AND column_name='$column'" 2>/dev/null)

                    if [[ "$RESULT" -eq 1 ]]; then
                        echo "  [OK]   $table.$column"
                    else
                        echo "  [MISS] $table.$column"
                    fi
                done
            done
        fi
    fi

    echo ""
    echo "-------------------------------------------------------------------------------"
    echo "RUNTIME CAPABILITY CHECK (UAT)"
    echo "-------------------------------------------------------------------------------"
    echo ""

    railway environment uat > /dev/null 2>&1
    EMAIL_WORKER_SVC=$(cat "$TEMP_DIR/uat_services.txt" 2>/dev/null | grep -E "^email-worker" | head -1)

    if [[ -n "$EMAIL_WORKER_SVC" ]]; then
        railway service "$EMAIL_WORKER_SVC" > /dev/null 2>&1
        DISABLE_FLAG=$(railway variables --kv 2>/dev/null | grep '^DISABLE_EMAIL_PROCESSING=' | cut -d'=' -f2-)

        echo "UAT email-worker service: $EMAIL_WORKER_SVC"
        echo "DISABLE_EMAIL_PROCESSING: ${DISABLE_FLAG:-<not set>}"
    else
        echo "No email-worker service found in UAT"
    fi

    if [[ -n "$DB_HOST" ]] && [[ -n "$DB_PASS" ]]; then
        ROW_COUNT=$(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" \
            -N -e "SELECT COUNT(*) FROM $TENANT_DB.email_ingest_settings" 2>/dev/null || echo "0")
        echo "email_ingest_settings row count: $ROW_COUNT"
    fi

    echo ""
    echo "==============================================================================="
    echo "                              END OF REPORT"
    echo "==============================================================================="
}

main "$@"
