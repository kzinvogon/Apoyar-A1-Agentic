#!/bin/bash
# Railway Environment Switcher for ServiFlow
#
# WORKFLOW:
#   1. Default is UAT - all deployments go here first
#   2. Test on UAT (web-uat-uat.up.railway.app)
#   3. After approval, switch to prod and deploy
#
# Usage: source railway-env.sh [uat|prod|status]

case "$1" in
  prod|production)
    railway environment link production
    railway service link web
    echo "⚠️  Switched to PRODUCTION (app.serviflow.app)"
    echo "   Only deploy here after UAT approval!"
    ;;
  uat|staging)
    railway environment link uat
    railway service link web-uat
    echo "✅ Switched to UAT (web-uat-uat.up.railway.app)"
    ;;
  demo)
    railway environment link demo
    railway service link web-demo
    echo "🎭 Switched to DEMO (demo.serviflow.app)"
    ;;
  status)
    railway status
    ;;
  *)
    echo "Railway Environment Switcher"
    echo ""
    echo "WORKFLOW:"
    echo "  1. Deploy to UAT first (default)"
    echo "  2. Test at web-uat-uat.up.railway.app"
    echo "  3. After approval: source railway-env.sh prod"
    echo "  4. Then: railway redeploy --yes"
    echo ""
    echo "Commands:"
    echo "  source railway-env.sh uat     - Switch to UAT (default)"
    echo "  source railway-env.sh prod    - Switch to Production"
    echo "  source railway-env.sh demo    - Switch to Demo"
    echo "  source railway-env.sh status  - Show current environment"
    echo ""
    railway status
    ;;
esac
