# Ticket Processing Rules Module

## Overview

The Ticket Processing Rules Module allows administrators to create automated rules that match tickets based on search criteria and perform specific actions. This powerful feature enables workflow automation, reducing manual ticket management overhead.

## Features

- **Flexible Search Criteria**: Match tickets by title, body, or both
- **Multiple Action Types**: Delete, assign, create for customer, set priority/status, add tags
- **Rule Testing**: Preview which tickets would be affected before enabling a rule
- **Execution Tracking**: Monitor rule performance with statistics and execution history
- **Enable/Disable**: Easily toggle rules on and off without deletion

## Database Schema

### ticket_processing_rules Table

```sql
CREATE TABLE ticket_processing_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_code VARCHAR(50) NOT NULL,
  rule_name VARCHAR(255) NOT NULL,
  description TEXT,
  enabled BOOLEAN DEFAULT TRUE,

  -- Search criteria
  search_in ENUM('title', 'body', 'both') DEFAULT 'both',
  search_text VARCHAR(500) NOT NULL,
  case_sensitive BOOLEAN DEFAULT FALSE,

  -- Action configuration
  action_type ENUM('delete', 'create_for_customer', 'assign_to_expert',
                   'set_priority', 'set_status', 'add_tag') NOT NULL,
  action_params JSON,

  -- Execution tracking
  times_triggered INT DEFAULT 0,
  last_triggered_at DATETIME,

  -- Metadata
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_tenant (tenant_code),
  INDEX idx_enabled (enabled),
  INDEX idx_search (search_text)
);
```

### ticket_rule_executions Table

```sql
CREATE TABLE ticket_rule_executions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rule_id INT NOT NULL,
  ticket_id INT NOT NULL,
  action_taken VARCHAR(100) NOT NULL,
  execution_result ENUM('success', 'failure', 'skipped') NOT NULL,
  error_message TEXT,
  executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_rule (rule_id),
  INDEX idx_ticket (ticket_id),
  INDEX idx_date (executed_at),
  FOREIGN KEY (rule_id) REFERENCES ticket_processing_rules(id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
```

## API Endpoints

All endpoints are prefixed with `/api/ticket-rules/:tenantId` and require authentication.

### GET /:tenantId
**Get all rules for tenant**

Response:
```json
{
  "success": true,
  "rules": [
    {
      "id": 1,
      "rule_name": "Auto-assign Infrastructure Alerts",
      "description": "Automatically assign infrastructure monitoring alerts",
      "enabled": true,
      "search_in": "title",
      "search_text": "Infrastructure Monitoring",
      "case_sensitive": false,
      "action_type": "assign_to_expert",
      "action_params": {
        "expert_id": 1,
        "expert_name": "Infrastructure Team"
      },
      "times_triggered": 15,
      "last_triggered_at": "2025-11-29T10:00:00Z",
      "created_by": 1,
      "created_at": "2025-11-29T08:00:00Z"
    }
  ],
  "count": 1
}
```

### GET /:tenantId/:ruleId
**Get single rule by ID**

Response:
```json
{
  "success": true,
  "rule": { /* rule object */ }
}
```

### POST /:tenantId
**Create new rule**

Request:
```json
{
  "rule_name": "Delete Test Tickets",
  "description": "Automatically delete tickets marked as test",
  "enabled": true,
  "search_in": "both",
  "search_text": "TEST:",
  "case_sensitive": true,
  "action_type": "delete",
  "action_params": {}
}
```

Response:
```json
{
  "success": true,
  "message": "Rule created successfully",
  "rule": { /* created rule object */ }
}
```

### PUT /:tenantId/:ruleId
**Update existing rule**

Request: Same as POST, all fields optional

Response:
```json
{
  "success": true,
  "message": "Rule updated successfully",
  "rule": { /* updated rule object */ }
}
```

### DELETE /:tenantId/:ruleId
**Delete rule**

Response:
```json
{
  "success": true,
  "message": "Rule deleted successfully"
}
```

### POST /:tenantId/:ruleId/test
**Test rule (preview matching tickets)**

Response:
```json
{
  "success": true,
  "message": "Rule would affect 5 ticket(s)",
  "rule": { /* rule object */ },
  "matching_tickets": [
    {
      "id": 101,
      "title": "Infrastructure Alert",
      "description": "Server down",
      "status": "Open",
      "priority": "high"
    }
  ],
  "would_affect": 5
}
```

### POST /:tenantId/:ruleId/execute/:ticketId
**Execute rule on specific ticket**

Response:
```json
{
  "success": true,
  "message": "Rule executed successfully",
  "result": {
    "success": true,
    "result": "success",
    "action": "assign_to_expert",
    "details": {
      "message": "Ticket #101 assigned to Infrastructure Team",
      "expert_id": 1
    }
  }
}
```

### POST /:tenantId/execute-all/:ticketId
**Execute all enabled rules on a ticket**

Response:
```json
{
  "success": true,
  "message": "Executed 2 rule(s)",
  "results": [
    {
      "rule_id": 1,
      "rule_name": "Auto-assign Infrastructure",
      "success": true,
      "result": "success",
      "action": "assign_to_expert"
    }
  ]
}
```

### GET /:tenantId/:ruleId/history
**Get execution history for a rule**

Query params:
- `limit` (default: 50) - Number of executions to return

Response:
```json
{
  "success": true,
  "history": [
    {
      "id": 1,
      "rule_id": 1,
      "ticket_id": 101,
      "action_taken": "assign_to_expert",
      "execution_result": "success",
      "error_message": null,
      "executed_at": "2025-11-29T10:30:00Z",
      "ticket_title": "Infrastructure Alert"
    }
  ],
  "count": 1
}
```

### GET /:tenantId/statistics
**Get rule statistics for tenant**

Response:
```json
{
  "success": true,
  "statistics": {
    "total_rules": 2,
    "enabled_rules": 1,
    "total_executions": 25,
    "last_execution": "2025-11-29T10:30:00Z",
    "executions_last_24h": 5
  }
}
```

## Action Types

### 1. delete
**Delete matching tickets**

Action params: `{}`

Example:
```json
{
  "action_type": "delete",
  "action_params": {}
}
```

### 2. assign_to_expert
**Assign tickets to a specific expert**

Action params:
```json
{
  "expert_id": 1,
  "expert_name": "John Doe"  // Optional, for display
}
```

### 3. create_for_customer
**Create a new ticket for a different customer**

Action params:
```json
{
  "customer_id": 5
}
```

The new ticket will have:
- Title: `[Forwarded] {original title}`
- Description: `Forwarded from ticket #{original_id}:\n\n{original description}`
- Priority: Same as original
- Status: Open

### 4. set_priority
**Set ticket priority**

Action params:
```json
{
  "priority": "high"  // low, medium, high, critical
}
```

### 5. set_status
**Set ticket status**

Action params:
```json
{
  "status": "In Progress"  // Open, In Progress, Pending, Resolved, Closed
}
```

### 6. add_tag
**Add a tag to the ticket**

Action params:
```json
{
  "tag": "auto-processed"
}
```

Tags are comma-separated. If tag already exists, it won't be duplicated.

## UI Components

### Main View

Navigate to: **⚙️ Ticket Rules** (available in Master Admin and Admin navigation)

Features:
- Statistics dashboard (Total Rules, Enabled Rules, Executions in last 24h)
- List of all rules with search criteria and actions
- Create, Edit, Test, and Delete buttons for each rule

### Create/Edit Rule Modal

Form fields:

**Basic Information:**
- Rule Name (required)
- Description (optional)
- Enabled checkbox

**Search Criteria:**
- Search In: Title Only / Body Only / Title and Body
- Search Text (required)
- Case Sensitive checkbox

**Action:**
- Action Type dropdown (required)
- Dynamic action parameters based on selected type

### Rule Display

Each rule card shows:
- Rule name and enabled/disabled badge
- Description
- Search criteria (search in, text, case sensitivity)
- Action type and parameters
- Execution statistics (times triggered, last triggered)
- Test, Edit, Delete buttons

## Usage Examples

### Example 1: Auto-delete test tickets

```json
{
  "rule_name": "Delete Test Tickets",
  "description": "Remove tickets created for testing purposes",
  "enabled": true,
  "search_in": "both",
  "search_text": "[TEST]",
  "case_sensitive": false,
  "action_type": "delete",
  "action_params": {}
}
```

### Example 2: Auto-assign infrastructure alerts

```json
{
  "rule_name": "Auto-assign Infrastructure",
  "description": "Assign infrastructure monitoring alerts to infrastructure team",
  "enabled": true,
  "search_in": "title",
  "search_text": "Infrastructure Monitoring",
  "case_sensitive": false,
  "action_type": "assign_to_expert",
  "action_params": {
    "expert_id": 1,
    "expert_name": "Infrastructure Team"
  }
}
```

### Example 3: Escalate critical issues

```json
{
  "rule_name": "Escalate Critical",
  "description": "Mark tickets with 'URGENT' as critical priority",
  "enabled": true,
  "search_in": "title",
  "search_text": "URGENT",
  "case_sensitive": true,
  "action_type": "set_priority",
  "action_params": {
    "priority": "critical"
  }
}
```

### Example 4: Tag billing issues

```json
{
  "rule_name": "Tag Billing Issues",
  "description": "Add 'billing' tag to payment-related tickets",
  "enabled": true,
  "search_in": "both",
  "search_text": "payment",
  "case_sensitive": false,
  "action_type": "add_tag",
  "action_params": {
    "tag": "billing"
  }
}
```

## Testing Rules

Before enabling a rule, you can test it to see which tickets would be affected:

1. Create or edit a rule
2. Click the **🧪 Test** button
3. View a popup showing:
   - Number of matching tickets
   - List of first 10 ticket titles
   - Indication if there are more

This helps verify your search criteria are correct before the rule executes on real tickets.

## Execution Flow

### Manual Execution

1. Navigate to rule detail
2. Click execute on specific ticket
3. Rule checks if enabled
4. Finds matching tickets
5. Executes configured action
6. Logs execution result
7. Updates rule statistics

### Automatic Execution (Future)

Rules can be configured to execute automatically:
- On ticket creation
- On ticket update
- On schedule (e.g., every hour)

## Service Layer

The `TicketRulesService` class handles all rule operations:

```javascript
const { TicketRulesService } = require('./services/ticket-rules-service');

const service = new TicketRulesService('apoyar');

// Get all rules
const rules = await service.getAllRules();

// Create rule
const newRule = await service.createRule(ruleData, userId);

// Test rule
const testResult = await service.testRule(ruleId);

// Execute rule on ticket
const result = await service.executeRuleOnTicket(ruleId, ticketId);

// Get statistics
const stats = await service.getRuleStatistics();
```

## Security Considerations

1. **Role-Based Access**: Only admins can create, edit, or delete rules
2. **Tenant Isolation**: Rules can only access tickets within their tenant
3. **Action Validation**: All actions validate parameters before execution
4. **Audit Trail**: All executions are logged with timestamps and results
5. **SQL Injection Prevention**: Parameterized queries throughout

## Performance Considerations

1. **Indexing**: Search text and enabled status are indexed for fast lookups
2. **Limit Results**: Test function limits to 100 matching tickets
3. **Batch Execution**: Multiple rules can be executed in sequence
4. **Async Operations**: All database operations use async/await
5. **Error Handling**: Failed executions don't block subsequent rules

## Troubleshooting

### Rule not matching expected tickets

1. Check search criteria:
   - Verify search text is correct
   - Try with case_sensitive disabled
   - Check if searching in correct field (title/body/both)

2. Test the rule first to see what matches

### Action failing to execute

1. Check execution history for error message
2. Verify action parameters are valid:
   - Expert/Customer IDs exist
   - Priority/Status values are valid enum values
3. Check tenant permissions

### Statistics not updating

1. Verify rule is enabled
2. Check if executions are being logged in ticket_rule_executions
3. Look for database connection errors

## Future Enhancements

Potential features for future development:

1. **Scheduling**: Run rules on a schedule (hourly, daily)
2. **Conditions**: Multiple conditions (AND/OR logic)
3. **Regular Expressions**: Advanced pattern matching
4. **Actions Chain**: Execute multiple actions per rule
5. **Rule Priority**: Order of execution when multiple rules match
6. **Webhooks**: Trigger external services
7. **Templates**: Pre-built rule templates for common use cases
8. **Bulk Import/Export**: Import/export rules as JSON/CSV

## Files Created/Modified

### New Files
- `/routes/ticket-rules.js` - API route handlers
- `/services/ticket-rules-service.js` - Business logic
- `/migrations/add-ticket-rules.sql` - Database schema
- `/apply-ticket-rules-migration.js` - Migration script
- `/TICKET_PROCESSING_RULES.md` - This documentation

### Modified Files
- `/server.js` - Added ticket-rules routes registration
- `/A1 Support Build from here .html` - Added UI views, navigation, JavaScript functions

---

**Last Updated**: 2025-11-29
**Version**: 1.0
**Author**: Claude AI Assistant
