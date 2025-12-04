# AI Insights - Acknowledge & Dismiss Functions

## Overview

The AI Insights Dashboard provides two key actions for managing detected insights and alerts: **Acknowledge** and **Dismiss**. These functions allow administrators and experts to track which insights have been reviewed and remove false positives or resolved issues.

---

## Function: acknowledgeInsight()

### Purpose
Marks an insight as "acknowledged" by the current user, indicating that:
- The insight has been reviewed by a team member
- The issue is understood and being addressed
- Removes the insight from the "active" list

### Location
- **File**: `A1 Support Build from here .html`
- **Line**: 5879-5895

### Function Signature
```javascript
async function acknowledgeInsight(insightId)
```

### Parameters
- `insightId` (Number): The unique ID of the insight to acknowledge

### How It Works

1. **Retrieves Authentication**
   ```javascript
   const tenantCode = window.currentTenant || 'apoyar';
   const token = localStorage.getItem('token');
   ```
   - Gets the current tenant code from browser
   - Retrieves JWT authentication token from localStorage

2. **Makes API Call**
   ```javascript
   const url = window.location.protocol + '//' + window.location.host +
               `/api/analytics/${tenantCode}/insights/${insightId}/acknowledge`;

   const response = await fetch(url, {
     method: 'POST',
     headers: { 'Authorization': `Bearer ${token}` }
   });
   ```
   - POSTs to the acknowledge endpoint
   - Includes authentication token in header

3. **Processes Response**
   ```javascript
   const data = await response.json();

   if (data.success) {
     await refreshAIInsights();
   } else {
     alert('Failed to acknowledge insight');
   }
   ```
   - If successful: Refreshes the dashboard to show updated insights
   - If failed: Shows error alert to user

4. **Error Handling**
   ```javascript
   catch (error) {
     console.error('Error acknowledging insight:', error);
     alert('Error acknowledging insight: ' + error.message);
   }
   ```
   - Logs error to console for debugging
   - Shows user-friendly error message

### API Endpoint

**POST** `/api/analytics/:tenantId/insights/:insightId/acknowledge`

**Authentication**: Required (Bearer token)

**Request Headers**:
```
Authorization: Bearer <JWT_TOKEN>
```

**Response**:
```json
{
  "success": true,
  "message": "Insight acknowledged"
}
```

### Database Changes

**Table**: `ai_insights`

**SQL Update**:
```sql
UPDATE ai_insights
SET
  status = 'acknowledged',
  acknowledged_by = :userId,
  acknowledged_at = NOW(),
  updated_at = NOW()
WHERE id = :insightId
  AND tenant_code = :tenantCode
```

**Fields Modified**:
- `status`: Changed from 'active' to 'acknowledged'
- `acknowledged_by`: Set to current user's ID
- `acknowledged_at`: Set to current timestamp
- `updated_at`: Updated to current timestamp

### Use Cases

#### 1. Alert Has Been Reviewed
```
Scenario: A critical alert shows "Recurring Issue: Database Timeout"
Action: Click "✓ Acknowledge" after investigating the issue
Result: Insight is marked as reviewed and removed from active list
```

#### 2. Issue Is Being Addressed
```
Scenario: Alert shows "High Priority Tickets Need Attention (42 tickets)"
Action: After assigning tickets to experts, acknowledge the insight
Result: Team knows this alert has been handled
```

#### 3. Audit Trail
```
Scenario: Manager wants to see who reviewed critical alerts
Action: Check ai_insights table for acknowledged_by and acknowledged_at
Result: Full audit trail of who acknowledged what and when
```

### UI Integration

**Button HTML**:
```html
<button class="btn ghost"
        style="padding:4px 8px;font-size:12px"
        onclick="acknowledgeInsight(${insight.id})">
  ✓ Acknowledge
</button>
```

**Visual Location**: Right side of each insight card

**Appearance**:
- Small ghost button (transparent background)
- Green checkmark icon: ✓
- Text: "Acknowledge"

---

## Function: dismissInsight()

### Purpose
Permanently removes an insight from view by marking it as "dismissed", indicating that:
- The insight is a false positive
- The issue has been permanently resolved
- The insight is not relevant to the team

### Location
- **File**: `A1 Support Build from here .html`
- **Line**: 5897-5913

### Function Signature
```javascript
async function dismissInsight(insightId)
```

### Parameters
- `insightId` (Number): The unique ID of the insight to dismiss

### How It Works

1. **Retrieves Authentication**
   ```javascript
   const tenantCode = window.currentTenant || 'apoyar';
   const token = localStorage.getItem('token');
   ```
   - Gets the current tenant code from browser
   - Retrieves JWT authentication token from localStorage

2. **Makes API Call**
   ```javascript
   const url = window.location.protocol + '//' + window.location.host +
               `/api/analytics/${tenantCode}/insights/${insightId}/dismiss`;

   const response = await fetch(url, {
     method: 'POST',
     headers: { 'Authorization': `Bearer ${token}` }
   });
   ```
   - POSTs to the dismiss endpoint
   - Includes authentication token in header

3. **Processes Response**
   ```javascript
   const data = await response.json();

   if (data.success) {
     await refreshAIInsights();
   } else {
     alert('Failed to dismiss insight');
   }
   ```
   - If successful: Refreshes the dashboard to show updated insights
   - If failed: Shows error alert to user

4. **Error Handling**
   ```javascript
   catch (error) {
     console.error('Error dismissing insight:', error);
     alert('Error dismissing insight: ' + error.message);
   }
   ```
   - Logs error to console for debugging
   - Shows user-friendly error message

### API Endpoint

**POST** `/api/analytics/:tenantId/insights/:insightId/dismiss`

**Authentication**: Required (Bearer token)

**Request Headers**:
```
Authorization: Bearer <JWT_TOKEN>
```

**Response**:
```json
{
  "success": true,
  "message": "Insight dismissed"
}
```

### Database Changes

**Table**: `ai_insights`

**SQL Update**:
```sql
UPDATE ai_insights
SET
  status = 'dismissed',
  updated_at = NOW()
WHERE id = :insightId
  AND tenant_code = :tenantCode
```

**Fields Modified**:
- `status`: Changed from 'active' to 'dismissed'
- `updated_at`: Updated to current timestamp

**Note**: Dismissed insights are filtered out from all dashboard queries using:
```sql
WHERE status = 'active'
```

### Use Cases

#### 1. False Positive Alert
```
Scenario: Alert shows "Volume Spike Detected" due to test data
Action: Click "✕ Dismiss" to remove from view
Result: Insight is permanently hidden from dashboard
```

#### 2. Resolved Systemic Issue
```
Scenario: Alert "Recurring Issue: Database Timeouts" after DB upgrade
Action: Dismiss the insight once root cause is fixed
Result: Old alert no longer appears
```

#### 3. Irrelevant Category
```
Scenario: Alert about category that doesn't apply to your team
Action: Dismiss to keep dashboard focused on relevant issues
Result: Cleaner, more actionable dashboard
```

### UI Integration

**Button HTML**:
```html
<button class="btn ghost"
        style="padding:4px 8px;font-size:12px"
        onclick="dismissInsight(${insight.id})">
  ✕ Dismiss
</button>
```

**Visual Location**: Right side of each insight card (next to Acknowledge button)

**Appearance**:
- Small ghost button (transparent background)
- Red X icon: ✕
- Text: "Dismiss"

---

## Acknowledge vs. Dismiss: When to Use

### Use **Acknowledge** When:
✅ You've reviewed the insight and understand the issue
✅ The issue is valid and being addressed
✅ You want to track that someone looked at it
✅ The insight should be available for historical reports
✅ You may want to see it again in analytics

**Status Change**: `active` → `acknowledged`
**Visibility**: Hidden from active list, but queryable for reports
**Reversible**: Can be queried from database if needed

### Use **Dismiss** When:
❌ The insight is a false positive
❌ The issue is permanently resolved
❌ The insight is irrelevant to your operations
❌ You want to permanently remove it from view
❌ It's cluttering the dashboard

**Status Change**: `active` → `dismissed`
**Visibility**: Completely hidden from all dashboard views
**Reversible**: Only via direct database update

---

## Example Workflow

### Scenario: Daily Alert Review

**Morning Review**:
```
1. Login to dashboard
2. Navigate to 🤖 AI Insights
3. Review active alerts (10 insights shown)

Alert #1: "🔴 CRITICAL - Recurring Issue: Database Timeouts (30 tickets)"
Action: ✓ Acknowledge (assigned team to investigate)

Alert #2: "⚠️ WARNING - High Priority Tickets (42 tickets)"
Action: ✓ Acknowledge (reassigned 15 tickets to experts)

Alert #3: "⚠️ WARNING - Volume Spike Detected (test environment)"
Action: ✕ Dismiss (false positive from load testing)

Result: 3 insights handled, 7 remaining active
```

**End of Day**:
```
Alert #1: Database issue resolved after DB restart
Action: ✕ Dismiss (issue no longer occurring)

Alert #2: Only 10 high-priority tickets remain
Action: Wait for automatic update (new trend detection will clear old alert)
```

---

## Technical Details

### Authentication
Both functions use **JWT Bearer token authentication**:
- Token stored in `localStorage` after login
- Sent in `Authorization` header on every request
- Token contains: userId, username, role, tenantCode

### Tenant Isolation
Both functions respect multi-tenant architecture:
- Uses `window.currentTenant` to identify tenant
- API validates user has access to that tenant
- Database queries filtered by tenant_code

### Real-time Updates
After each action:
```javascript
await refreshAIInsights();
```
This re-fetches the dashboard data showing:
- Updated insight counts
- Remaining active insights
- Refreshed charts and metrics

### Error States

**Network Error**:
```
❌ Error dismissing insight: Failed to fetch
```

**Authentication Error**:
```
❌ Error acknowledging insight: Unauthorized
```

**Server Error**:
```
❌ Failed to acknowledge insight
```

---

## Database Schema Reference

### ai_insights Table

```sql
CREATE TABLE ai_insights (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_code VARCHAR(50) NOT NULL,
  insight_type VARCHAR(50),           -- 'trend', 'anomaly', 'recommendation'
  title VARCHAR(255),
  description TEXT,
  severity ENUM('info', 'warning', 'critical'),
  affected_tickets JSON,              -- Array of ticket IDs
  metrics JSON,                       -- Additional data
  time_range_start DATETIME,
  time_range_end DATETIME,
  status ENUM('active', 'acknowledged', 'dismissed') DEFAULT 'active',
  acknowledged_by INT,                -- User ID who acknowledged
  acknowledged_at DATETIME,           -- When acknowledged
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_tenant_status (tenant_code, status),
  FOREIGN KEY (acknowledged_by) REFERENCES users(id)
);
```

### Status Values

| Status | Description | Visible in Dashboard | Can Query | Modified By |
|--------|-------------|---------------------|-----------|-------------|
| `active` | New, unreviewed insight | ✅ Yes | ✅ Yes | System (auto-created) |
| `acknowledged` | Reviewed by team member | ❌ No | ✅ Yes | acknowledgeInsight() |
| `dismissed` | Removed as false positive | ❌ No | ⚠️ Admin only | dismissInsight() |

---

## API Implementation Details

### Backend Route Location
**File**: `routes/analytics.js`
**Lines**: ~320-370

### Acknowledge Endpoint
```javascript
router.post('/:tenantId/insights/:insightId/acknowledge',
  requireRole(['admin', 'expert']),
  async (req, res) => {
    const { tenantId, insightId } = req.params;
    const userId = req.user.userId;

    const connection = await getTenantConnection(tenantId);

    await connection.query(
      `UPDATE ai_insights
       SET status = 'acknowledged',
           acknowledged_by = ?,
           acknowledged_at = NOW(),
           updated_at = NOW()
       WHERE id = ? AND tenant_code = ?`,
      [userId, insightId, tenantId]
    );

    res.json({ success: true, message: 'Insight acknowledged' });
  }
);
```

### Dismiss Endpoint
```javascript
router.post('/:tenantId/insights/:insightId/dismiss',
  requireRole(['admin', 'expert']),
  async (req, res) => {
    const { tenantId, insightId } = req.params;

    const connection = await getTenantConnection(tenantId);

    await connection.query(
      `UPDATE ai_insights
       SET status = 'dismissed',
           updated_at = NOW()
       WHERE id = ? AND tenant_code = ?`,
      [insightId, tenantId]
    );

    res.json({ success: true, message: 'Insight dismissed' });
  }
);
```

### Role Requirements
- **Required Roles**: `admin` or `expert`
- **Customer users**: Cannot acknowledge/dismiss (no access to dashboard)
- **Master admin**: Can access via direct API calls

---

## Testing

### Manual Testing

**Test Acknowledge**:
```bash
# Get a valid token first
TOKEN="your-jwt-token"

# Acknowledge insight #1
curl -X POST http://localhost:3000/api/analytics/apoyar/insights/1/acknowledge \
  -H "Authorization: Bearer $TOKEN"

# Expected response:
# {"success":true,"message":"Insight acknowledged"}
```

**Test Dismiss**:
```bash
# Dismiss insight #2
curl -X POST http://localhost:3000/api/analytics/apoyar/insights/2/dismiss \
  -H "Authorization: Bearer $TOKEN"

# Expected response:
# {"success":true,"message":"Insight dismissed"}
```

**Verify in Database**:
```sql
-- Check insight status
SELECT id, title, status, acknowledged_by, acknowledged_at
FROM ai_insights
WHERE tenant_code = 'apoyar'
ORDER BY id DESC;
```

### Automated Testing

Create a test file:
```javascript
// test-insight-actions.js
const fetch = require('node-fetch');

async function testInsightActions() {
  // 1. Login
  const loginRes = await fetch('http://localhost:3000/api/auth/tenant/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'password123',
      tenant_code: 'apoyar'
    })
  });
  const { token } = await loginRes.json();

  // 2. Get active insights
  const insightsRes = await fetch('http://localhost:3000/api/analytics/apoyar/ai-insights', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const { data } = await insightsRes.json();
  const firstInsight = data.insights[0];

  // 3. Acknowledge first insight
  const ackRes = await fetch(
    `http://localhost:3000/api/analytics/apoyar/insights/${firstInsight.id}/acknowledge`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    }
  );
  console.log('Acknowledge:', await ackRes.json());

  // 4. Dismiss second insight (if exists)
  if (data.insights[1]) {
    const dismissRes = await fetch(
      `http://localhost:3000/api/analytics/apoyar/insights/${data.insights[1].id}/dismiss`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );
    console.log('Dismiss:', await dismissRes.json());
  }

  // 5. Verify changes
  const updatedRes = await fetch('http://localhost:3000/api/analytics/apoyar/ai-insights', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const updated = await updatedRes.json();
  console.log(`Active insights reduced from ${data.insights.length} to ${updated.data.insights.length}`);
}

testInsightActions().catch(console.error);
```

Run test:
```bash
node test-insight-actions.js
```

---

## Future Enhancements

### Potential Improvements

1. **Bulk Actions**
   ```javascript
   async function acknowledgeMultiple(insightIds) {
     // Acknowledge multiple insights at once
   }
   ```

2. **Undo Functionality**
   ```javascript
   async function undoAcknowledge(insightId) {
     // Revert status back to 'active'
   }
   ```

3. **Comments on Insights**
   ```sql
   ALTER TABLE ai_insights
   ADD COLUMN comments TEXT;
   ```

4. **Notification on Critical Insights**
   - Email/Slack when critical insight acknowledged
   - Weekly summary of acknowledged vs dismissed

5. **Analytics on Actions**
   ```sql
   SELECT
     COUNT(*) as total,
     SUM(CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END) as acknowledged,
     SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) as dismissed
   FROM ai_insights
   WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY);
   ```

---

## Troubleshooting

### Problem: "Failed to acknowledge insight"

**Cause 1**: Not authenticated
```javascript
// Check if token exists
console.log('Token:', localStorage.getItem('token'));
```

**Cause 2**: Wrong role
```javascript
// Check user role
console.log('User:', JSON.parse(localStorage.getItem('user')));
// Role must be 'admin' or 'expert'
```

**Cause 3**: Insight already acknowledged/dismissed
```sql
-- Check insight status
SELECT status FROM ai_insights WHERE id = 123;
```

### Problem: Dashboard doesn't refresh after action

**Solution**:
```javascript
// Check browser console for errors
// Try manual refresh:
await loadAIInsights();
```

### Problem: Actions work but button stays disabled

**Solution**: Check for JavaScript errors in `finally` block
```javascript
// The finally block should always execute:
finally {
  if (btn) {
    btn.disabled = false;
    btn.textContent = '🔍 Detect Trends';
  }
}
```

---

## Related Documentation

- [AI_DASHBOARD_COMPLETE.md](./AI_DASHBOARD_COMPLETE.md) - Full dashboard documentation
- [AI_ANALYTICS_SYSTEM.md](./AI_ANALYTICS_SYSTEM.md) - Technical architecture
- [routes/analytics.js](./routes/analytics.js) - Backend API implementation

---

**Last Updated**: 2025-11-24
**Version**: 1.0
**Author**: Claude AI Assistant
