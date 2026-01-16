/**
 * Slack Notifier Service
 * Handles proactive notifications to Slack channels
 */

const { WebClient } = require('@slack/web-api');
const { getMasterConnection, getTenantConnection } = require('../config/database');
const { buildSimpleNotification } = require('../bot/blocks/notificationBlocks');

// Cache for bot tokens (TTL: 5 minutes)
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 5 * 60 * 1000;

/**
 * Get bot token for a workspace
 */
async function getBotToken(workspaceId) {
  const cacheKey = `token_${workspaceId}`;

  if (tokenCache.has(cacheKey)) {
    const cached = tokenCache.get(cacheKey);
    if (Date.now() - cached.timestamp < TOKEN_CACHE_TTL) {
      return cached.token;
    }
    tokenCache.delete(cacheKey);
  }

  try {
    const masterPool = await getMasterConnection();
    const [rows] = await masterPool.query(
      'SELECT slack_bot_token FROM slack_workspace_mappings WHERE slack_workspace_id = ? AND is_active = TRUE',
      [workspaceId]
    );

    if (rows.length > 0 && rows[0].slack_bot_token) {
      const token = rows[0].slack_bot_token;
      tokenCache.set(cacheKey, { token, timestamp: Date.now() });
      return token;
    }
  } catch (error) {
    console.error('[Slack Notifier] Error getting bot token:', error.message);
  }

  return null;
}

/**
 * Get workspace IDs for a tenant
 */
async function getWorkspacesForTenant(tenantCode) {
  try {
    const masterPool = await getMasterConnection();
    const [rows] = await masterPool.query(
      'SELECT slack_workspace_id, slack_bot_token FROM slack_workspace_mappings WHERE tenant_code = ? AND is_active = TRUE',
      [tenantCode]
    );
    return rows;
  } catch (error) {
    console.error('[Slack Notifier] Error getting workspaces:', error.message);
    return [];
  }
}

/**
 * Get notification channels for a workspace/tenant
 * For now, returns the default channel (could be expanded to support channel mappings)
 */
async function getNotificationChannels(tenantCode, workspaceId) {
  // TODO: Implement channel mapping table for more granular control
  // For now, we'll rely on the default behavior of posting to channels where the bot was added

  try {
    const tenantPool = await getTenantConnection(tenantCode);

    // Check if there's a slack_channel_mappings table
    const [channels] = await tenantPool.query(
      `SELECT channel_id, notification_types FROM slack_channel_mappings
       WHERE slack_workspace_id = ? AND is_active = TRUE`,
      [workspaceId]
    ).catch(() => [[]]);

    return channels;
  } catch (error) {
    console.error('[Slack Notifier] Error getting channels:', error.message);
    return [];
  }
}

/**
 * Send notification to a specific channel
 */
async function sendToChannel(client, channelId, blocks, fallbackText) {
  try {
    const result = await client.chat.postMessage({
      channel: channelId,
      blocks: blocks,
      text: fallbackText,
      unfurl_links: false,
      unfurl_media: false
    });

    return { success: true, ts: result.ts };
  } catch (error) {
    console.error(`[Slack Notifier] Error posting to channel ${channelId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send notification for a ticket event
 */
async function sendNotification(tenantCode, ticket, eventType, blocks) {
  const workspaces = await getWorkspacesForTenant(tenantCode);

  if (workspaces.length === 0) {
    console.log(`[Slack Notifier] No workspaces configured for tenant ${tenantCode}`);
    return;
  }

  const fallbackText = buildSimpleNotification(eventType, ticket);

  for (const workspace of workspaces) {
    if (!workspace.slack_bot_token) {
      console.log(`[Slack Notifier] No bot token for workspace ${workspace.slack_workspace_id}`);
      continue;
    }

    try {
      const client = new WebClient(workspace.slack_bot_token);

      // Get configured channels for this workspace
      const channels = await getNotificationChannels(tenantCode, workspace.slack_workspace_id);

      if (channels.length === 0) {
        // No specific channels configured - could post to a default channel
        // For now, we skip if no channels are configured
        console.log(`[Slack Notifier] No channels configured for workspace ${workspace.slack_workspace_id}`);
        continue;
      }

      // Send to each configured channel
      for (const channel of channels) {
        // Check if this event type should be sent to this channel
        const notificationTypes = channel.notification_types || [];
        if (notificationTypes.length > 0 && !notificationTypes.includes(eventType)) {
          continue;
        }

        await sendToChannel(client, channel.channel_id, blocks, fallbackText);
      }
    } catch (error) {
      console.error(`[Slack Notifier] Error sending to workspace ${workspace.slack_workspace_id}:`, error.message);
    }
  }
}

/**
 * Broadcast notification to all configured channels
 */
async function broadcastNotification(tenantCode, blocks, fallbackText) {
  const workspaces = await getWorkspacesForTenant(tenantCode);

  for (const workspace of workspaces) {
    if (!workspace.slack_bot_token) continue;

    try {
      const client = new WebClient(workspace.slack_bot_token);
      const channels = await getNotificationChannels(tenantCode, workspace.slack_workspace_id);

      for (const channel of channels) {
        await sendToChannel(client, channel.channel_id, blocks, fallbackText);
      }
    } catch (error) {
      console.error(`[Slack Notifier] Broadcast error:`, error.message);
    }
  }
}

/**
 * Send direct message to a user
 */
async function sendDirectMessage(workspaceId, slackUserId, blocks, fallbackText) {
  const token = await getBotToken(workspaceId);
  if (!token) {
    console.error('[Slack Notifier] No bot token available');
    return { success: false, error: 'No bot token' };
  }

  try {
    const client = new WebClient(token);

    // Open a DM channel with the user
    const dmResult = await client.conversations.open({ users: slackUserId });

    if (!dmResult.ok) {
      return { success: false, error: 'Failed to open DM channel' };
    }

    // Send the message
    const result = await client.chat.postMessage({
      channel: dmResult.channel.id,
      blocks: blocks,
      text: fallbackText
    });

    return { success: true, ts: result.ts };
  } catch (error) {
    console.error('[Slack Notifier] DM error:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendNotification,
  broadcastNotification,
  sendDirectMessage,
  sendToChannel,
  getBotToken,
  getWorkspacesForTenant
};
