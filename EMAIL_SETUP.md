# Email Setup Guide

## Current Status
⚠️ **Email notifications are currently disabled** because SMTP credentials are not configured.

When you create or resolve tickets (like Ticket #65426), the system tries to send emails but they are skipped because SMTP is not configured.

## To Enable Email Notifications

### 1. Get Gmail App Password
1. Enable 2-factor authentication on your Google account
2. Go to https://myaccount.google.com/apppasswords
3. Generate an app password for "Mail"
4. Copy the 16-character password

### 2. Update .env File
Add these lines to your `.env` file in `/Users/davidhamilton/Dev/Apoyar-A1-Agentic/.env`:

```
SMTP_EMAIL=your-email@gmail.com
SMTP_PASSWORD=your-16-character-app-password
```

Replace `your-email@gmail.com` with your actual Gmail address.
Replace `your-16-character-app-password` with the app password you generated.

### 3. Restart the Server
After saving the `.env` file, restart your server:
```bash
cd /Users/davidhamilton/Dev/Apoyar-A1-Agentic
pkill -f "node server.js"
node server.js
```

You should see:
```
✅ Email server is ready to send messages
```

Instead of:
```
⚠️  SMTP credentials not configured. Email sending disabled.
```

## Testing Email Notifications

Once configured, email notifications will be sent for:
- **Ticket Creation**: When a new ticket is created
- **Ticket Resolution**: When a ticket is marked as "Resolved"
- **Status Changes**: When a ticket status changes

## Current Behavior

Right now, when emails are attempted:
- Console shows: `⚠️ Skipping email notification - SMTP not configured`
- No emails are sent
- The system continues to work normally

After configuration:
- Console shows: `📧 Email sent successfully to email@example.com`
- Customers receive notification emails
