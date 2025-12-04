# Ticket Processing & Email Notification System

## Overview
This document describes the ticket processing and email notification system implemented for the A1 Support Dashboard. The system handles ticket status changes, email notifications, and maintains a complete audit trail of all ticket actions.

## Features Implemented

### 1. **Ticket Status Management**
- ✅ Automatic status updates when tickets are resolved or reassigned
- ✅ Complete audit trail in `ticket_activity` table
- ✅ Activity logging for all actions (created, updated, resolved, etc.)

### 2. **Email Notifications** (Mock Implementation)
When a ticket action occurs, the system:
- 📧 Sends an email to the customer when ticket is **Resolved**
- 📧 Sends an email when ticket **Status changes** (e.g., Open → In Progress → Resolved)
- 📧 Sends an email when ticket is **Created**

**Email includes:**
- Ticket number and title
- Current status
- Admin comments (if any)
- Link to view ticket and respond (accept/reject resolution)
- Complete history of past actions and responses

### 3. **REST API Endpoints**

#### Get All Tickets
```
GET /api/tickets/:tenantId
```
**Response:**
```json
{
  "success": true,
  "tickets": [
    {
      "id": 1,
      "ticket_number": 1,
      "title": "Server Issue",
      "status": "Resolved",
      "priority": "High",
      "assignee_name": "John Doe",
      "customer_name": "Jane Smith",
      "customer_email": "jane@example.com",
      ...
    }
  ]
}
```

#### Get Specific Ticket with Activity History
```
GET /api/tickets/:tenantId/:ticketId
```
**Response:**
```json
{
  "success": true,
  "ticket": { ... },
  "activities": [
    {
      "id": 1,
      "ticket_id": 1,
      "user_id": 5,
      "action": "Updated",
      "details": "Status changed from Open to Resolved. Comment: Issue fixed.",
      "user_name": "admin",
      "user_full_name": "System Administrator",
      "created_at": "2025-10-27T08:15:00.000Z"
    }
  ]
}
```

#### Create New Ticket
```
POST /api/tickets/:tenantId
```
**Body:**
```json
{
  "title": "New Issue",
  "description": "Issue description",
  "priority": "Normal",
  "customer_id": 3,
  "cmdb_item_id": 5,
  "ci_id": 2,
  "due_date": "2025-11-01"
}
```

#### Update Ticket (e.g., Resolve)
```
PUT /api/tickets/:tenantId/:ticketId
```
**Body:**
```json
{
  "status": "Resolved",
  "assignee_id": 2,
  "priority": "High",
  "comment": "Issue has been resolved by restarting the service."
}
```

## Email Notification Flow

### When Ticket is Resolved:
1. **Status Change**: Ticket status changes from current status to "Resolved"
2. **Activity Log**: Entry created in `ticket_activity` table with action details
3. **Email Sent**: Customer receives email notification including:
   - Ticket details
   - Resolution comment
   - Link to view ticket
   - Accept/Reject resolution options
4. **Customer Response**: Customer can view ticket, see all past actions, and accept/reject resolution

### Email Template Structure:
```
Subject: [Ticket #12345] Issue Title - resolved

Your Support Ticket Has Been Updated

Ticket #12345
Status: Resolved
Title: Server Connection Issue

Comment: Issue resolved by restarting the service.

[View Ticket & Respond] (link to http://localhost:3000/ticket/123)
```

## Database Schema

### `tickets` Table
- `id`: Primary key
- `ticket_number`: Unique ticket identifier
- `title`: Ticket title
- `description`: Full ticket description
- `status`: Open, In Progress, Pending, Resolved, Closed
- `priority`: Low, Normal, High, Critical
- `assignee_id`: User assigned to ticket
- `customer_id`: Customer who opened ticket
- `cmdb_item_id`: Linked CMDB item
- `ci_id`: Linked Configuration Item
- `created_at`, `updated_at`: Timestamps

### `ticket_activity` Table
- `id`: Primary key
- `ticket_id`: Reference to ticket
- `user_id`: User who performed action
- `action`: Action type (Created, Updated, Resolved, etc.)
- `details`: Description of action
- `created_at`: Timestamp

## Implementation Details

### 1. Ticket Routes (`routes/tickets.js`)
- ✅ Created RESTful API endpoints for ticket management
- ✅ Implemented authentication middleware
- ✅ Activity logging for all actions
- ✅ Email notification triggers

### 2. Server Integration (`server.js`)
- ✅ Added ticket routes to Express app
- ✅ Configured API paths: `/api/tickets`

### 3. Email System (Mock Implementation)
Currently, email sending is mocked with console logging. To implement real emails:

1. **Install nodemailer** or use SendGrid/AWS SES
2. **Update `sendTicketEmail()` function** in `routes/tickets.js`
3. **Configure email credentials** in environment variables
4. **Add email templates** for different notification types

Example:
```javascript
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendTicketEmail(tenantCode, action, ticket, details) {
  const emailContent = {
    to: ticket.customer_email,
    subject: `[Ticket #${ticket.ticket_number}] ${ticket.title}`,
    html: `...`
  };
  
  await transporter.sendMail(emailContent);
}
```

## Usage Examples

### Resolve a Ticket
```javascript
// Update ticket status to Resolved
PUT /api/tickets/apoyar/123
{
  "status": "Resolved",
  "comment": "Issue resolved by restarting the service."
}

// Customer receives email with:
// - Ticket details
// - Resolution comment
// - Link to accept/reject: http://localhost:3000/ticket/123
```

### View Ticket with History
```javascript
// Get ticket with all activities
GET /api/tickets/apoyar/123

// Response includes complete history:
// - All status changes
// - All comments
// - All assignments
// - All past actions and responses
```

## Next Steps

1. **Implement Real Email Service**
   - Add nodemailer or similar
   - Configure SMTP settings
   - Create email templates

2. **Frontend Integration**
   - Add UI for ticket resolution
   - Add accept/reject buttons
   - Display complete activity history

3. **Email Templates**
   - Create HTML email templates
   - Add branding/styling
   - Include images and links

4. **Customer Response Handling**
   - Add endpoints for accept/reject
   - Update ticket status based on response
   - Send follow-up emails

## Testing

Test the ticket system with curl:

```bash
# Get all tickets
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/tickets/apoyar

# Create a new ticket
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","description":"Test ticket","priority":"Normal","customer_id":1}' \
  http://localhost:3000/api/tickets/apoyar

# Resolve a ticket
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"Resolved","comment":"Fixed!"}' \
  http://localhost:3000/api/tickets/apoyar/1
```

## Current Status
- ✅ API endpoints implemented
- ✅ Database schema ready
- ✅ Activity logging working
- ✅ Email notifications (mock/console)
- ⏳ Real email sending (TODO)
- ⏳ Frontend integration (TODO)

