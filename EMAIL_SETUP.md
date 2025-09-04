# Email Processing Setup Guide

## Setting Up Real IMAP Credentials

### 1. Gmail Setup (Recommended)

#### Step 1: Enable 2-Factor Authentication
1. Go to your Google Account settings
2. Navigate to Security → 2-Step Verification
3. Enable 2-Factor Authentication

#### Step 2: Generate App Password
1. Go to Google Account → Security → App passwords
2. Select "Mail" and your device
3. Copy the generated 16-character password

#### Step 3: Configure Environment Variables
Create a `.env` file in your project root with:

```bash
# IMAP Settings
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=your-support-email@gmail.com
IMAP_PASSWORD=your-16-character-app-password
IMAP_REJECT_UNAUTHORIZED=false

# SMTP Settings (for sending emails)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-support-email@gmail.com
SMTP_PASSWORD=your-16-character-app-password

# Email Check Interval (30 seconds)
EMAIL_CHECK_INTERVAL=30000
```

### 2. Outlook/Hotmail Setup

```bash
# IMAP Settings
IMAP_HOST=outlook.office365.com
IMAP_PORT=993
IMAP_USER=your-support-email@outlook.com
IMAP_PASSWORD=your-password
IMAP_REJECT_UNAUTHORIZED=false

# SMTP Settings
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=587
SMTP_USER=your-support-email@outlook.com
SMTP_PASSWORD=your-password
```

### 3. Custom Email Server Setup

```bash
# IMAP Settings
IMAP_HOST=your-mail-server.com
IMAP_PORT=993
IMAP_USER=support@yourdomain.com
IMAP_PASSWORD=your-password
IMAP_REJECT_UNAUTHORIZED=false

# SMTP Settings
SMTP_HOST=your-mail-server.com
SMTP_PORT=587
SMTP_USER=support@yourdomain.com
SMTP_PASSWORD=your-password
```

## Testing Your Setup

### 1. Test Email Processing
1. Login as Master Admin
2. Go to "📧 Email Processing"
3. Use the test form to send a test email
4. Check server logs for processing results

### 2. Configure Tenant Domains
1. In Email Processing dashboard
2. Click "Edit" next to a tenant
3. Set the email domain (e.g., `company.com`)
4. Enable email processing

### 3. Send Real Test Email
Send an email from `test@company.com` to your configured IMAP email address with:
- Subject: "Test Support Request"
- Body: "This is a test email to verify the system works"

## Troubleshooting

### Common Issues

1. **SSL Certificate Errors**
   - Set `IMAP_REJECT_UNAUTHORIZED=false` in your `.env` file
   - This allows self-signed certificates in development

2. **Authentication Failed**
   - Verify your email and password are correct
   - For Gmail, ensure you're using an App Password, not your regular password
   - Check that 2FA is enabled for Gmail

3. **Connection Timeout**
   - Verify the IMAP host and port are correct
   - Check your firewall settings
   - Ensure the email server allows IMAP connections

4. **No Emails Processed**
   - Check that emails are in the INBOX
   - Verify the tenant domain is configured correctly
   - Check server logs for error messages

### Debug Mode

To enable detailed logging, add to your `.env` file:
```bash
DEBUG=imap:*
```

## Security Notes

- Never commit your `.env` file to version control
- Use App Passwords instead of regular passwords
- Consider using environment-specific configurations
- Regularly rotate your email passwords
- Monitor email processing logs for suspicious activity

## Production Considerations

1. **Rate Limiting**: Adjust `EMAIL_CHECK_INTERVAL` based on your needs
2. **Error Handling**: Implement proper error recovery and alerting
3. **Monitoring**: Set up monitoring for email processing failures
4. **Backup**: Ensure email processing doesn't interfere with regular email access
5. **Compliance**: Consider GDPR and other privacy regulations for email processing
