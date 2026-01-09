# ServiFlow Teams Connector

Microsoft Teams bot integration for ServiFlow ticket management system.

## Features

- **Raise Tickets** - Create tickets directly from Teams using natural language
- **Status Lookup** - Query ticket status with `status #123`
- **My Tickets** - View your assigned tickets
- **AI Insights** - View ticket analytics with AI-powered trend detection
- **CMDB Search** - Search configuration items
- **Notifications** - Receive Adaptive Card notifications for ticket events

## Prerequisites

- Node.js 18+
- Microsoft 365 tenant with Teams admin access
- Azure Bot registration (Microsoft Entra ID app)
- ngrok for local testing

## Local Setup

### 1. Azure Bot Registration

1. Go to [Azure Portal](https://portal.azure.com)
2. Create a new **Bot Channel Registration** or **Azure Bot**
3. Note your **Microsoft App ID** and create a **Client Secret**
4. Under **Channels**, enable **Microsoft Teams**
5. Set the messaging endpoint to: `https://<your-ngrok-url>/api/messages`

### 2. Environment Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
MICROSOFT_APP_ID=<your-azure-bot-app-id>
MICROSOFT_APP_PASSWORD=<your-azure-bot-client-secret>
MICROSOFT_APP_TENANT_ID=<your-azure-tenant-id>

SERVIFLOW_URL=https://serviflow.app
TEAMS_WEBHOOK_SECRET=<shared-secret-for-webhook-auth>
PORT=3978
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Start ngrok Tunnel

In a separate terminal:

```bash
ngrok http 3978
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`) and update your Azure Bot messaging endpoint.

### 5. Run the Bot

Development mode (with auto-reload):

```bash
npm run dev
```

Production:

```bash
npm start
```

## Creating the Teams App Package

Generate the sideloadable manifest.zip:

```bash
npm run manifest
```

This creates `manifest.zip` in the project root, ready for sideloading.

### Sideloading to Teams

1. Open Microsoft Teams
2. Go to **Apps** > **Manage your apps**
3. Click **Upload an app** > **Upload a custom app**
4. Select the generated `manifest.zip`

## Bot Commands

| Command | Description |
|---------|-------------|
| `raise ticket: <description>` | Create a new ticket |
| `status #123` | View ticket details |
| `my tickets` | List your assigned tickets |
| `assign #123` | Assign ticket to yourself |
| `resolve #123 <comment>` | Resolve a ticket |
| `trends` | View ticket analytics & AI insights |
| `cmdb search <query>` | Search CMDB items |
| `help` | Show available commands |

## Adaptive Cards

The bot responds with rich Adaptive Cards that include:

- Ticket details with priority coloring
- AI analysis (sentiment, category, suggested resolution)
- Linked CMDB items
- Action buttons (View, Assign, Resolve)

## Architecture

```
ServiFlow API  ──webhook──>  teams-connector  <──Bot Framework──>  Teams
     │                            │
     └──────── MySQL DB ──────────┘
```

The connector:
- Receives ticket events via webhook from ServiFlow
- Sends proactive notifications to mapped Teams channels
- Handles bot commands using direct database access via shared utilities

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `MICROSOFT_APP_ID` | Azure Bot App ID | Yes |
| `MICROSOFT_APP_PASSWORD` | Azure Bot Client Secret | Yes |
| `MICROSOFT_APP_TENANT_ID` | Azure Tenant ID (for single-tenant) | No |
| `SERVIFLOW_URL` | ServiFlow web URL | Yes |
| `TEAMS_WEBHOOK_SECRET` | Shared secret for webhook auth | No |
| `PORT` | Server port (default: 3978) | No |

## Database Tables

The integration uses these tables in tenant databases:

- `teams_channel_mappings` - Channel notification settings
- `teams_user_mappings` - Teams user to ServiFlow user links
- `teams_conversation_refs` - Conversation references for proactive messaging
- `teams_notification_log` - Notification history

Run the migration:

```bash
node ../migrations/add-teams-tables.js
```

## Troubleshooting

### Bot not responding

1. Check ngrok is running and URL matches Azure Bot endpoint
2. Verify `MICROSOFT_APP_ID` and `MICROSOFT_APP_PASSWORD` are correct
3. Check server logs for authentication errors

### Notifications not sending

1. Ensure `TEAMS_ENABLED=true` in main ServiFlow app
2. Verify webhook secret matches between apps
3. Check `teams_channel_mappings` has active entries

### Teams app won't install

1. Verify manifest.json has correct `id` matching your Azure App ID
2. Ensure icons are present in manifest folder
3. Check Teams admin policies allow custom app sideloading
