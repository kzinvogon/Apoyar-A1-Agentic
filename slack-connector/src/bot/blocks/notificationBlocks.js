/**
 * Slack Block Kit builders for notifications
 * Used for proactive messages when tickets are updated
 */

const SERVIFLOW_URL = process.env.SERVIFLOW_URL || 'https://app.serviflow.app';

const eventConfig = {
  created: {
    emoji: ':new:',
    color: '#36a64f',
    title: 'New Ticket Created'
  },
  assigned: {
    emoji: ':bust_in_silhouette:',
    color: '#2eb886',
    title: 'Ticket Assigned'
  },
  resolved: {
    emoji: ':white_check_mark:',
    color: '#2eb886',
    title: 'Ticket Resolved'
  },
  status_changed: {
    emoji: ':arrows_counterclockwise:',
    color: '#f2c744',
    title: 'Ticket Status Changed'
  },
  comment: {
    emoji: ':speech_balloon:',
    color: '#439fe0',
    title: 'New Comment'
  },
  priority_changed: {
    emoji: ':rotating_light:',
    color: '#e01e5a',
    title: 'Priority Changed'
  }
};

const priorityEmoji = {
  low: ':white_circle:',
  medium: ':large_yellow_circle:',
  high: ':large_orange_circle:',
  critical: ':red_circle:'
};

function truncate(text, length) {
  if (!text) return '';
  if (text.length <= length) return text;
  return text.substring(0, length) + '...';
}

/**
 * Build notification blocks for a ticket event
 */
function buildNotificationBlocks(eventType, ticket, eventDetails = {}) {
  const config = eventConfig[eventType] || eventConfig.status_changed;
  const priority = (ticket.priority || 'medium').toLowerCase();

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${config.emoji} ${config.title}`,
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${SERVIFLOW_URL}/ticket/${ticket.id}|Ticket #${ticket.id}>*\n${truncate(ticket.title, 100)}`
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View Ticket', emoji: true },
        url: `${SERVIFLOW_URL}/ticket/${ticket.id}`,
        action_id: 'view_ticket_notification'
      }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status*\n${ticket.status || 'Open'}` },
        { type: 'mrkdwn', text: `*Priority*\n${priorityEmoji[priority] || ''} ${priority.charAt(0).toUpperCase() + priority.slice(1)}` }
      ]
    }
  ];

  // Add event-specific details
  switch (eventType) {
    case 'created':
      if (ticket.requester_name) {
        blocks.push({
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `Created by *${ticket.requester_name}*` }
          ]
        });
      }
      break;

    case 'assigned':
      if (eventDetails.assignee_name || ticket.assignee_name) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:bust_in_silhouette: Assigned to *${eventDetails.assignee_name || ticket.assignee_name}*`
          }
        });
      }
      break;

    case 'resolved':
      if (eventDetails.resolution_comment || ticket.resolution_comment) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:memo: *Resolution:*\n${truncate(eventDetails.resolution_comment || ticket.resolution_comment, 300)}`
          }
        });
      }
      if (eventDetails.resolved_by_name) {
        blocks.push({
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `Resolved by *${eventDetails.resolved_by_name}*` }
          ]
        });
      }
      break;

    case 'status_changed':
      if (eventDetails.previous_status && eventDetails.new_status) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:arrows_counterclockwise: Status changed from *${eventDetails.previous_status}* to *${eventDetails.new_status}*`
          }
        });
      }
      break;

    case 'comment':
      if (eventDetails.comment_text) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:speech_balloon: *Comment:*\n${truncate(eventDetails.comment_text, 300)}`
          }
        });
      }
      if (eventDetails.commenter_name) {
        blocks.push({
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `Comment by *${eventDetails.commenter_name}*` }
          ]
        });
      }
      break;

    case 'priority_changed':
      if (eventDetails.previous_priority && eventDetails.new_priority) {
        const prevEmoji = priorityEmoji[eventDetails.previous_priority] || '';
        const newEmoji = priorityEmoji[eventDetails.new_priority] || '';
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:rotating_light: Priority changed from ${prevEmoji} *${eventDetails.previous_priority}* to ${newEmoji} *${eventDetails.new_priority}*`
          }
        });
      }
      break;
  }

  // Add divider and quick actions
  blocks.push({ type: 'divider' });

  const actions = {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View Details', emoji: true },
        url: `${SERVIFLOW_URL}/ticket/${ticket.id}`,
        action_id: 'open_ticket_details'
      }
    ]
  };

  // Add assign button for unassigned tickets
  if (!ticket.assignee_id && eventType !== 'resolved') {
    actions.elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Assign to Me', emoji: true },
      style: 'primary',
      action_id: `assign_ticket_${ticket.id}`,
      value: String(ticket.id)
    });
  }

  blocks.push(actions);

  // Add timestamp context
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `<!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|${new Date().toISOString()}>` }
    ]
  });

  return blocks;
}

/**
 * Build simple text notification for fallback
 */
function buildSimpleNotification(eventType, ticket) {
  const config = eventConfig[eventType] || eventConfig.status_changed;
  return `${config.emoji} *${config.title}*\nTicket #${ticket.id}: ${ticket.title}\n<${SERVIFLOW_URL}/ticket/${ticket.id}|View Ticket>`;
}

module.exports = {
  buildNotificationBlocks,
  buildSimpleNotification
};
