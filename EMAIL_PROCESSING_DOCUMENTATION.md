# Email Processing System Documentation

## Overview

The A1 Support Dashboard includes an automated email-to-ticket system that monitors incoming emails and automatically creates support tickets. This system processes emails from registered customer domains, creates customer accounts as needed, and sends confirmation emails with secure ticket access links.

---

## Architecture

### Components

1. **Email Processor Service** (`services/email-processor.js`)
   - Core email processing engine
   - IMAP connection management
   - Email parsing and ticket creation
   - Customer auto-provisioning

2. **Email Configuration** (`config/email.js`)
   - SMTP/Nodemailer setup for outgoing emails
   - Email notification functions
   - Ticket confirmation emails

3. **Email Ingest API** (`routes/email-ingest.js`)
   - REST API for managing email settings
   - Admin-only configuration endpoints

4. **Token Generator** (`utils/tokenGenerator.js`)
   - Secure token generation for ticket access links
   - Token validation and expiration management

---

## Email Processing Flow

### 1. Email Collection (IMAP)

```
Start Server
    ↓
Initialize EmailProcessor for tenant
    ↓
Connect to IMAP Server (Gmail)
    ↓
Open [Gmail]/All Mail folder
    ↓
Search for UNSEEN (unread) emails
    ↓
Fetch email messages
    ↓
Mark emails as read
    ↓
Parse email content
```

**Implementation Details:**

- **Folder:** Opens `[Gmail]/All Mail` to catch emails filtered by Gmail's screener
- **Search Criteria:** `UNSEEN` flag (unread emails only)
- **Marking:** Emails are marked as seen after processing to prevent duplicates
- **Frequency:** Checks every 5 minutes (configurable)
- **Library:** Uses `node-imap` for IMAP connection, `mailparser` for parsing

**File:** `services/email-processor.js:74-180`

### 2. Email Validation

```
Parse Email
    ↓
Extract sender email address
    ↓
Extract domain from email
    ↓
Check if domain exists in customers table
    ↓
   [Domain Found]        [Domain Not Found]
        ↓                        ↓
   Continue Processing      Ignore Email
```

**Domain Matching Logic:**

```javascript
// Extract email from "Name <email@domain.com>" format
let fromEmail = email.from.toLowerCase().trim();
const emailMatch = fromEmail.match(/<(.+?)>/);
if (emailMatch) {
  fromEmail = emailMatch[1];
}

// Extract domain
const domain = fromEmail.split('@')[1];

// Check customer database
SELECT * FROM customers WHERE company_domain = ?
```

**File:** `services/email-processor.js:185-212`

### 3. Customer Identification/Creation

```
Domain Validated
    ↓
Check if email exists in users table
    ↓
[Email Exists]                    [Email Doesn't Exist]
    ↓                                    ↓
Use existing customer ID         Create new customer
    ↓                                    ↓
    └────────────────┬───────────────────┘
                     ↓
              Create Ticket
```

#### Existing Customer Path

```sql
SELECT u.id as user_id, u.email, u.username, c.id as customer_id
FROM users u
LEFT JOIN customers c ON u.id = c.user_id
WHERE u.email = ? AND u.role = 'customer'
```

**File:** `services/email-processor.js:215-229`

#### New Customer Creation Path

**Username Generation:**
```javascript
const emailPrefix = email.split('@')[0];  // john.doe@example.com → john.doe
let username = emailPrefix.replace(/[^a-z0-9]/g, '_');  // → john_doe
```

**Full Name Generation:**
```javascript
const fullName = emailPrefix
  .replace(/[._-]/g, ' ')      // john_doe → john doe
  .replace(/\b\w/g, l => l.toUpperCase());  // → John Doe
```

**Password:**
- Generates random temporary password: `Math.random().toString(36).slice(-10)`
- Hashed with bcrypt (10 rounds)
- **Note:** Welcome email with password not implemented yet

**Company Name:**
```javascript
const companyName = domain.split('.')[0]
  .charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
// example.com → Example
```

**Database Operations:**
```sql
-- Create user account
INSERT INTO users (username, password_hash, role, email, full_name)
VALUES (?, ?, 'customer', ?, ?);

-- Create customer profile
INSERT INTO customers (user_id, company_name, company_domain, sla_level)
VALUES (?, ?, ?, 'basic');
```

**File:** `services/email-processor.js:262-311`

### 4. Ticket Creation

```
Customer Identified
    ↓
Parse email subject and body
    ↓
Analyze priority keywords
    ↓
Calculate SLA deadline
    ↓
Create ticket in database
    ↓
Log activity
    ↓
Return ticket ID
```

#### Priority Detection

**High Priority Keywords:**
- urgent
- critical
- emergency
- asap
- down

**Low Priority Keywords:**
- question
- info
- information

**Default:** Medium priority

**Priority-Based SLA:**
```javascript
const slaHours = {
  high: 4 hours,
  medium: 24 hours,
  low: 48 hours
}
```

#### Database Operations

```sql
-- Create ticket
INSERT INTO tickets (
  title, description, status, priority,
  category, requester_id, sla_deadline
) VALUES (?, ?, 'open', ?, 'Email', ?, ?);

-- Log activity
INSERT INTO ticket_activity (
  ticket_id, user_id, activity_type, description
) VALUES (?, ?, 'created', ?);
```

**File:** `services/email-processor.js:316-352`

### 5. Confirmation Email

```
Ticket Created
    ↓
Generate secure access token (256-bit)
    ↓
Store token in database (30-day expiration)
    ↓
Build confirmation email with ticket link
    ↓
Send email via SMTP
    ↓
Complete processing
```

#### Token Generation

**Security:**
- Uses `crypto.randomBytes(32)` for cryptographic randomness
- 64-character hex string (256 bits of entropy)
- Stored with expiration date

**Database:**
```sql
INSERT INTO ticket_access_tokens (ticket_id, token, expires_at)
VALUES (?, ?, ?);
```

**File:** `utils/tokenGenerator.js:19-37`

#### Email Content

**Template Structure:**
- Ticket ID and subject
- Current status
- Secure access link (no login required)
- 30-day expiration notice
- Automated message disclaimer

**Example Link:**
```
http://localhost:3000/ticket/view/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6...
```

**File:** `services/email-processor.js:357-387`

---

## Database Schema

### email_ingest_settings

Configuration table for email server connection (one row per tenant):

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| enabled | tinyint(1) | Enable/disable email processing |
| server_type | enum('imap','pop3') | Email protocol |
| server_host | varchar(255) | Email server hostname |
| server_port | int | Email server port (default: 993) |
| use_ssl | tinyint(1) | Enable SSL/TLS |
| username | varchar(255) | Email account username |
| password | varchar(255) | Email account password |
| check_interval_minutes | int | Check frequency (default: 5) |
| last_checked_at | timestamp | Last successful check |
| created_at | timestamp | Record creation time |
| updated_at | timestamp | Last update time |

### customers

Customer organization/company records:

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| user_id | int | Foreign key to users table |
| company_name | varchar(100) | Company display name |
| company_domain | varchar(255) | **Email domain (e.g., example.com)** |
| contact_phone | varchar(20) | Contact phone number |
| address | text | Company address |
| sla_level | enum | Service level (basic/premium/enterprise) |
| created_at | timestamp | Record creation time |
| updated_at | timestamp | Last update time |

**Key Field:** `company_domain` - Used for email domain matching

### ticket_access_tokens

Secure tokens for passwordless ticket access:

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| ticket_id | int | Foreign key to tickets |
| token | varchar(64) | Secure random token (hex) |
| expires_at | timestamp | Token expiration date |
| last_accessed_at | timestamp | Last token usage |
| access_count | int | Number of times accessed |
| created_at | timestamp | Token creation time |

---

## API Endpoints

### Get Email Settings

```http
GET /api/email-ingest/:tenantId/settings
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "settings": {
    "id": 1,
    "enabled": true,
    "server_type": "imap",
    "server_host": "imap.gmail.com",
    "server_port": 993,
    "use_ssl": true,
    "username": "support@example.com",
    "password": "******",
    "check_interval_minutes": 5,
    "last_checked_at": "2025-11-24T13:00:00.000Z"
  }
}
```

**File:** `routes/email-ingest.js:48-80`

### Update Email Settings

```http
PUT /api/email-ingest/:tenantId/settings
Authorization: Bearer <token>
Content-Type: application/json

{
  "enabled": true,
  "server_type": "imap",
  "server_host": "imap.gmail.com",
  "server_port": 993,
  "use_ssl": true,
  "username": "support@example.com",
  "password": "app-specific-password",
  "check_interval_minutes": 5
}
```

**Authorization:** Admin role required

**File:** `routes/email-ingest.js:83-141`

### Test Connection

```http
POST /api/email-ingest/:tenantId/test-connection
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "Email connection test successful",
  "details": {
    "server": "imap.gmail.com",
    "port": 993,
    "type": "imap"
  }
}
```

**File:** `routes/email-ingest.js:144-175`

---

## Configuration

### Environment Variables

```bash
# SMTP Configuration (for sending emails)
SMTP_EMAIL=support@example.com
SMTP_PASSWORD=your-gmail-app-password

# Base URL for ticket links
BASE_URL=http://localhost:3000
```

### Gmail App Password Setup

1. Enable 2-factor authentication on Google account
2. Go to https://myaccount.google.com/apppasswords
3. Generate app password for "Mail"
4. Use generated password in `SMTP_PASSWORD`

### Email Ingest Settings

Configure via API or database:

```sql
-- Enable email processing
UPDATE email_ingest_settings SET
  enabled = TRUE,
  server_type = 'imap',
  server_host = 'imap.gmail.com',
  server_port = 993,
  use_ssl = TRUE,
  username = 'support@example.com',
  password = 'app-password',
  check_interval_minutes = 5;
```

---

## Email Processing Schedule

**Startup:**
- Processes all unread emails immediately
- `startEmailProcessing()` called in `server.js:148`

**Recurring:**
- Checks every 5 minutes (default)
- Configurable via `check_interval_minutes`
- `setInterval()` in `services/email-processor.js:400-402`

**File:** `services/email-processor.js:393-405`

---

## Security Features

### 1. Domain Whitelisting

Only emails from registered customer domains are processed:

```javascript
// Check domain exists
const [domainCustomers] = await connection.query(
  'SELECT * FROM customers WHERE company_domain = ?',
  [domain]
);

if (domainCustomers.length === 0) {
  console.log(`Domain ${domain} not found. Ignoring email.`);
  return { success: false, reason: 'domain_not_found' };
}
```

### 2. Secure Token Generation

- Cryptographic random tokens (256-bit entropy)
- Time-based expiration (30 days default)
- Single-use tracking with access counts
- Automatic cleanup of expired tokens

### 3. Email Address Uniqueness

- Enforced at database level (unique constraint)
- Prevents duplicate customer accounts
- Graceful error handling for conflicts

### 4. Rate Limiting

API endpoints protected by rate limiters:

- **Read operations:** 1000 requests / 15 min
- **Write operations:** 30 requests / 15 min
- **Admin operations:** 20 requests / 15 min

**File:** `middleware/rateLimiter.js`

---

## Error Handling

### Email Processing Errors

**Invalid Email Format:**
```javascript
if (!domain) {
  console.log(`Invalid email format: ${email.from}`);
  return { success: false, reason: 'invalid_email_format' };
}
```

**Domain Not Found:**
```javascript
if (domainCustomers.length === 0) {
  console.log(`Domain ${domain} not found in customers. Ignoring email.`);
  return { success: false, reason: 'domain_not_found' };
}
```

**Duplicate Email:**
```javascript
if (error.code === 'ER_DUP_ENTRY') {
  console.log(`Email ${email} already exists. Skipping user creation.`);
  throw new Error('Cannot create customer: Email address already registered.');
}
```

### Connection Errors

**IMAP Connection Failure:**
```javascript
imap.once('error', (err) => {
  console.error(`❌ IMAP connection error: ${err.message}`);
  reject(err);
});
```

**SMTP Not Configured:**
```javascript
if (!transporter) {
  console.log('⚠️  SMTP not configured. Email sending disabled.');
  return { success: false, message: 'SMTP not configured' };
}
```

---

## Logging

### Console Output Format

**Email Processing:**
```
📧 Found 3 new email(s) for tenant: apoyar
Processing email #1234
📨 Email from: john@example.com, Subject: Help needed
Processing email from: john@example.com, domain: example.com
Found existing customer: john@example.com (userId=5, customerId=3)
Successfully processed email and created ticket #42
✅ Finished processing 3 email(s)
```

**Customer Creation:**
```
Creating new customer for: jane@newcompany.com
Created new customer: jane_newcompany (jane@newcompany.com) for domain: newcompany.com
```

**Domain Rejection:**
```
Domain unknown.com not found in customers. Ignoring email.
```

**Token Generation:**
```
🔐 Generated access token for ticket #42
Sent ticket confirmation email to: john@example.com
```

---

## Testing

### Manual Email Test

1. Ensure email settings are configured
2. Ensure customer domain exists in database:

```sql
-- Add test domain
INSERT INTO customers (user_id, company_name, company_domain, sla_level)
VALUES (1, 'Test Company', 'testcompany.com', 'basic');
```

3. Send email from `user@testcompany.com` to configured inbox
4. Wait up to 5 minutes for processing
5. Check logs for processing confirmation
6. Verify ticket created in database:

```sql
SELECT * FROM tickets ORDER BY id DESC LIMIT 1;
```

### Test Script Example

```javascript
// Test password verification
node test-passwords.js

// Test email connection
node test-email-connection.js
```

---

## Troubleshooting

### Emails Not Being Processed

**Check 1: Email Settings**
```sql
SELECT * FROM email_ingest_settings;
```
Verify `enabled = 1`

**Check 2: IMAP Connection**
- Check Gmail App Password is correct
- Ensure 2FA enabled on Gmail account
- Verify server host/port are correct

**Check 3: Domain Registration**
```sql
SELECT * FROM customers WHERE company_domain = 'example.com';
```

**Check 4: Server Logs**
```bash
# Look for email processing logs
grep "Found.*new email" server.log
grep "Domain.*not found" server.log
```

### Confirmation Emails Not Sending

**Check 1: SMTP Configuration**
```bash
# Check .env file
cat .env | grep SMTP
```

**Check 2: Transporter Verification**
```
✅ Email server is ready to send messages  # Good
⚠️  SMTP credentials not configured         # Bad
```

**Check 3: Token Generation**
```bash
# Check if tokens are being created
mysql -u root a1_tenant_apoyar -e "SELECT * FROM ticket_access_tokens ORDER BY id DESC LIMIT 5;"
```

### High Memory Usage

**Issue:** Processing large volumes of emails

**Solution:** Adjust check interval:
```sql
UPDATE email_ingest_settings SET check_interval_minutes = 15;
```

Restart server to apply changes.

---

## Future Enhancements

### Planned Features

1. **Welcome Email for New Customers**
   - Send temporary password
   - Link to set permanent password
   - Getting started guide

2. **Email Reply Handling**
   - Parse In-Reply-To header
   - Add replies as ticket comments
   - Update ticket status on reply

3. **Attachment Support**
   - Extract email attachments
   - Store in file system or cloud storage
   - Link to ticket

4. **Spam Filtering**
   - Integrate spam detection
   - Bayesian filtering
   - Blacklist/whitelist management

5. **Email Templates**
   - Customizable notification templates
   - Multi-language support
   - Tenant-specific branding

6. **Advanced Priority Detection**
   - ML-based priority classification
   - Category auto-assignment
   - Sentiment analysis

7. **Email Archiving**
   - Store raw email content
   - Full-text search
   - Compliance features

---

## Code References

### Key Functions

| Function | File | Lines | Description |
|----------|------|-------|-------------|
| `processEmails()` | services/email-processor.js | 22-69 | Main email processing loop |
| `fetchEmailsViaIMAP()` | services/email-processor.js | 74-180 | IMAP email fetching |
| `processEmail()` | services/email-processor.js | 185-257 | Single email processing |
| `createCustomerFromEmail()` | services/email-processor.js | 262-311 | Customer auto-provisioning |
| `createTicketFromEmail()` | services/email-processor.js | 316-352 | Ticket creation from email |
| `sendTicketConfirmation()` | services/email-processor.js | 357-387 | Confirmation email sending |
| `createTicketAccessToken()` | utils/tokenGenerator.js | 19-37 | Secure token generation |
| `validateTicketAccessToken()` | utils/tokenGenerator.js | 45-94 | Token validation |

### Configuration Files

| File | Purpose |
|------|---------|
| `config/email.js` | SMTP configuration and email sending |
| `routes/email-ingest.js` | Email settings management API |
| `.env` | Environment variables (SMTP credentials) |

---

## Summary

The email processing system provides a complete email-to-ticket workflow:

1. ✅ Monitors Gmail inbox via IMAP every 5 minutes
2. ✅ Validates sender domain against customer database
3. ✅ Auto-creates customer accounts for new email addresses
4. ✅ Analyzes email content for priority and SLA
5. ✅ Creates tickets with proper categorization
6. ✅ Generates secure 30-day access tokens
7. ✅ Sends confirmation emails with ticket links
8. ✅ Provides admin APIs for configuration management

This automated system reduces manual ticket creation workload while ensuring all legitimate customer inquiries are captured and tracked.
