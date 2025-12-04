# AI-Powered Email Analytics System

## Overview

Your A1 Support system now includes a comprehensive AI-powered analytics agent that automatically analyzes incoming emails, detects trends, and produces actionable insights for experts and administrators.

## ✅ What's Been Implemented

### 1. Database Schema (`ai_email_analysis`, `ai_insights`, `ai_category_mappings`, `ai_system_metrics`)
- **ai_email_analysis**: Stores AI analysis of each ticket (sentiment, category, root cause, confidence scores, etc.)
- **ai_insights**: Tracks detected trends, anomalies, and recommendations
- **ai_category_mappings**: Pattern learning for improved categorization
- **ai_system_metrics**: Performance tracking and accuracy metrics

### 2. AI Analysis Service (`services/ai-analysis-service.js`)
- **Pattern-based analysis** (currently active - no API key required)
- **Ready for AI providers**: OpenAI and Anthropic Claude integration prepared
- **Real-time ticket analysis**: Sentiment, category, root cause, impact level
- **Trend detection**: Recurring issues, SLA risks, volume spikes
- **Performance metrics**: Processing time, confidence scores, accuracy tracking

### 3. Email Processing Integration
- **Automatic analysis**: Every incoming email is analyzed by AI after ticket creation
- **Non-blocking**: AI analysis runs asynchronously to not slow down email processing
- **Intelligent categorization**: Beyond manual categories, AI detects specific issue types
- **Similar ticket detection**: Links related tickets for pattern recognition

### 4. Enhanced Analytics API Endpoints
```
GET  /api/analytics/:tenantId/ai-insights           - Get AI dashboard data
POST /api/analytics/:tenantId/detect-trends         - Manual trend detection
POST /api/analytics/:tenantId/insights/:id/acknowledge - Acknowledge insight
POST /api/analytics/:tenantId/insights/:id/dismiss  - Dismiss insight
GET  /api/analytics/:tenantId/tickets/:id/ai-analysis - Get ticket with AI data
```

## 🎯 Features

### Email Analysis
For each incoming email/ticket, the AI analyzes:
- **Sentiment**: urgent, negative, neutral, positive
- **Confidence Score**: How confident the AI is in its analysis (0-100%)
- **AI Category**: More specific than manual categories (e.g., "Infrastructure Monitoring", "Database", "Storage")
- **Root Cause Type**: hardware, software, network, system, resource, database
- **Impact Level**: low, medium, high, critical
- **Key Phrases**: Important sentences extracted from email
- **Technical Terms**: Server names, technical keywords
- **Suggested Assignee**: Based on category and patterns
- **Estimated Resolution Time**: Predicted time to resolve
- **Similar Tickets**: Links to related past tickets

### Trend Detection
The AI automatically detects:

1. **Volume Spikes**: Unusual increases in ticket volume
2. **Recurring Issues**: Same category appearing repeatedly (systemic problems)
3. **SLA Breach Risks**: Tickets approaching SLA deadline
4. **High-Urgency Backlog**: Urgent tickets not being addressed

### Dashboard Insights
- **Sentiment Distribution**: Overview of ticket urgency/sentiment
- **Top Categories**: Most common issue types with confidence scores
- **Root Cause Analysis**: What's really causing the tickets
- **Performance Metrics**: AI accuracy, processing speed, total analyzed

## 📊 Test Results

Successfully analyzed **60 Nagios alert tickets**:

```
Sentiment Distribution:
- Positive (Recovery alerts): 18
- Negative (Warnings): 20
- Urgent (Critical): 22

Categories Detected:
- Infrastructure Monitoring: 60 tickets (77% confidence)

Root Causes:
- System issues: 60 tickets

AI Performance:
- Average confidence: 77%
- Average processing time: 1ms per ticket
- Total analyzed: 60 tickets
```

**Detected Insights:**
1. **CRITICAL**: Recurring Issue - "Infrastructure Monitoring" (50 tickets in 24h)
2. **WARNING**: High Priority Tickets Need Attention (36 urgent tickets open)

## 🚀 How to Use

### For Administrators/Experts

#### 1. View AI Insights Dashboard
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/analytics/apoyar/ai-insights?period=7
```

Returns:
- Active insights and alerts
- Sentiment distribution
- Top categories with confidence scores
- Root cause breakdown
- Performance metrics

#### 2. Trigger Manual Trend Detection
```bash
curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"timeRangeHours": 24}' \
  http://localhost:3000/api/analytics/apoyar/detect-trends
```

Analyzes last 24 hours and generates new insights.

#### 3. View Ticket with AI Analysis
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/analytics/apoyar/tickets/99/ai-analysis
```

Returns full ticket data plus AI analysis (sentiment, category, suggestions, similar tickets).

#### 4. Acknowledge an Insight
```bash
curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/analytics/apoyar/insights/1/acknowledge
```

Marks an insight as "acknowledged" (tracks who reviewed it).

### For Testing

Run the comprehensive test:
```bash
node test-ai-analysis.js
```

This will:
- Analyze all unanalyzed tickets
- Detect trends
- Show dashboard summary

## 🔮 AI Provider Configuration (Optional)

Currently using **pattern-matching** (no API key needed). To enable advanced AI:

### Option 1: OpenAI GPT
```env
AI_PROVIDER=openai
AI_API_KEY=sk-your-openai-key
```

Requires: `npm install openai`

### Option 2: Anthropic Claude
```env
AI_PROVIDER=anthropic
AI_API_KEY=sk-ant-your-anthropic-key
```

Requires: `npm install @anthropic-ai/sdk`

The service will automatically use the configured provider. Pattern-matching serves as a reliable fallback.

## 📈 What the AI Detects

### Email Patterns Recognized

**Urgent Keywords**: urgent, critical, emergency, asap, down, outage, failing, broken
**Positive Keywords**: thank, resolved, working, fixed, recovery, ok
**Problem Keywords**: problem, issue, error, fail

**Categories Detected**:
- Infrastructure Monitoring (server/service/host/nagios keywords)
- Database (mysql/mariadb/sql/query keywords)
- Storage (disk/volume/storage/space keywords)
- Network (connection/vpn/dns keywords)
- Performance (cpu/memory/load keywords)

**Impact Detection**:
- CRITICAL alerts → Impact: critical
- WARNING alerts → Impact: low
- PROBLEM/DOWN/OUTAGE → Impact: high

### Example Analysis

**Input Email:**
```
Subject: ** PROBLEM Service Alert: FreeNAS/Volumes is CRITICAL **
Body: Volume Apoyar is DEGRADED
```

**AI Analysis:**
```json
{
  "sentiment": "urgent",
  "confidence": 85,
  "category": "Storage",
  "rootCause": "hardware",
  "impactLevel": "critical",
  "keyPhrases": ["CRITICAL - Volume Apoyar is DEGRADED"],
  "technicalTerms": ["FreeNAS", "Volume"],
  "estimatedResolutionTime": 30,
  "suggestedAssignee": "Storage-team"
}
```

## 🎨 Dashboard UI (Next Steps)

The backend is fully functional. To add a visual dashboard to the HTML interface:

1. Add a new "AI Insights" tab/view
2. Display active insights with severity indicators
3. Show sentiment distribution chart (pie/donut chart)
4. Display top categories bar chart
5. Show trend lines for ticket volume
6. Add "Acknowledge" and "Dismiss" buttons for insights

Example API call for dashboard data:
```javascript
const response = await fetch(`http://localhost:3000/api/analytics/apoyar/ai-insights?period=7`, {
  headers: { 'Authorization': `Bearer ${token}` }
});
const data = await response.json();

// data.insights = array of active insights
// data.sentiment.distribution = { urgent: 22, negative: 20, positive: 18 }
// data.categories = top categories with counts
// data.performance = AI metrics
```

## 🔧 Maintenance

### Monitor AI Performance
```sql
SELECT * FROM ai_system_metrics ORDER BY metric_date DESC LIMIT 30;
```

### Review Active Insights
```sql
SELECT * FROM ai_insights WHERE status = 'active' ORDER BY severity DESC;
```

### Check Analysis Coverage
```sql
SELECT
  COUNT(*) as total_tickets,
  SUM(CASE WHEN ai_analyzed = TRUE THEN 1 ELSE 0 END) as analyzed,
  ROUND(SUM(CASE WHEN ai_analyzed = TRUE THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as coverage_pct
FROM tickets;
```

## 🎯 Benefits

1. **Proactive Problem Detection**: Spot recurring issues before they escalate
2. **Intelligent Categorization**: Better than manual categorization
3. **SLA Management**: Early warnings for breach risks
4. **Resource Optimization**: Suggested assignees based on patterns
5. **Trend Visibility**: Understand what's really happening
6. **Data-Driven Decisions**: Metrics and confidence scores

## 📝 Future Enhancements

1. **Real AI Integration**: Connect OpenAI or Claude for advanced NLP
2. **Machine Learning**: Train on your specific ticket patterns
3. **Predictive Analytics**: Forecast ticket volumes
4. **Auto-Assignment**: Automatically assign tickets to best expert
5. **Root Cause Analysis**: Deep dive into systemic issues
6. **Custom Alerting**: Slack/email notifications for critical insights
7. **Dashboard Visualizations**: Interactive charts and graphs

## 🏁 Summary

You now have a fully functional AI analytics system that:
- ✅ Automatically analyzes every incoming email/ticket
- ✅ Detects trends and anomalies in real-time
- ✅ Provides actionable insights for experts/admins
- ✅ Tracks AI performance and accuracy
- ✅ Exposes comprehensive analytics APIs
- ✅ Works without requiring external AI APIs (pattern-matching)
- ✅ Ready to integrate with OpenAI/Claude for advanced AI

**Current Status**: 60 tickets analyzed, 2 critical insights detected, 77% average confidence, <1ms average processing time.

Next step: Build the visual dashboard UI to make these insights easily accessible to your team!
