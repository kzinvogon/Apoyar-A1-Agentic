/**
 * Slack Block Kit builders for tickets
 * Equivalent to Teams Adaptive Cards
 */

const SERVIFLOW_URL = process.env.SERVIFLOW_URL || 'https://app.serviflow.app';

const statusEmoji = {
  'open': ':large_blue_circle:',
  'Open': ':large_blue_circle:',
  'in_progress': ':large_yellow_circle:',
  'In Progress': ':large_yellow_circle:',
  'pending': ':large_orange_circle:',
  'Pending': ':large_orange_circle:',
  'paused': ':large_orange_circle:',
  'Paused': ':large_orange_circle:',
  'resolved': ':white_check_mark:',
  'Resolved': ':white_check_mark:',
  'closed': ':black_circle:',
  'Closed': ':black_circle:'
};

const priorityEmoji = {
  'low': ':white_circle:',
  'medium': ':large_yellow_circle:',
  'high': ':large_orange_circle:',
  'critical': ':red_circle:'
};

function formatDate(dateString) {
  if (!dateString) return 'Unknown';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function truncate(text, length) {
  if (!text) return '';
  if (text.length <= length) return text;
  return text.substring(0, length) + '...';
}

/**
 * Build ticket detail blocks
 */
function buildTicketBlocks(ticket, options = {}) {
  const { mode } = options;
  const priority = (ticket.priority || 'medium').toLowerCase();
  const status = ticket.status || 'Open';

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `Ticket #${ticket.id}`,
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${truncate(ticket.title, 100)}*`
      }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status*\n${statusEmoji[status] || ''} ${status}` },
        { type: 'mrkdwn', text: `*Priority*\n${priorityEmoji[priority] || ''} ${priority.charAt(0).toUpperCase() + priority.slice(1)}` },
        { type: 'mrkdwn', text: `*Assignee*\n${ticket.assignee_name || 'Unassigned'}` },
        { type: 'mrkdwn', text: `*Requester*\n${ticket.requester_name || 'Unknown'}` }
      ]
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Created*\n${formatDate(ticket.created_at)}` },
        { type: 'mrkdwn', text: `*Category*\n${ticket.category || 'General'}` }
      ]
    }
  ];

  // Add description if present
  if (ticket.description) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Description*\n${truncate(ticket.description, 500)}`
      }
    });
  }

  // Add AI analysis if present
  if (ticket.sentiment || ticket.category) {
    const sentimentEmoji = {
      positive: ':slightly_smiling_face:',
      neutral: ':neutral_face:',
      negative: ':slightly_frowning_face:',
      frustrated: ':angry:'
    };

    let aiText = '*:robot_face: AI Analysis*\n';
    if (ticket.sentiment) {
      aiText += `Sentiment: ${sentimentEmoji[ticket.sentiment] || ''} ${ticket.sentiment}\n`;
    }
    if (ticket.confidence_score) {
      aiText += `Confidence: ${Math.round(ticket.confidence_score * 100)}%`;
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: aiText }
    });
  }

  // Add CMDB item if linked
  if (ticket.cmdb_item_name) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:desktop_computer: *Linked CMDB Item:* ${ticket.cmdb_item_name}`
      }
    });
  }

  // Add divider before actions
  blocks.push({ type: 'divider' });

  // Add action buttons
  const actions = {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View in ServiFlow', emoji: true },
        url: `${SERVIFLOW_URL}/ticket/${ticket.id}`,
        action_id: 'open_serviflow'
      }
    ]
  };

  // Add expert actions if in expert mode and ticket is not resolved
  if (mode === 'expert' && status !== 'Resolved' && status !== 'Closed') {
    actions.elements.push(
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Assign to Me', emoji: true },
        style: 'primary',
        action_id: `assign_ticket_${ticket.id}`,
        value: String(ticket.id)
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Resolve', emoji: true },
        style: 'danger',
        action_id: `resolve_ticket_${ticket.id}`,
        value: String(ticket.id)
      }
    );
  }

  blocks.push(actions);

  // Add mode indicator
  if (mode) {
    const modeEmoji = mode === 'expert' ? ':necktie:' : ':bust_in_silhouette:';
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${modeEmoji} ${mode}` }
      ]
    });
  }

  return blocks;
}

/**
 * Build ticket list blocks
 */
function buildTicketListBlocks(tickets, title = 'My Tickets', options = {}) {
  const { mode } = options;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${title} (${tickets.length})`, emoji: true }
    }
  ];

  // Add each ticket as a section
  tickets.slice(0, 10).forEach(ticket => {
    const status = ticket.status || 'Open';
    const priority = (ticket.priority || 'medium').toLowerCase();

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*#${ticket.id}* ${truncate(ticket.title, 50)}\n${statusEmoji[status] || ''} ${status} | ${priorityEmoji[priority] || ''} ${priority}`
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View', emoji: true },
        action_id: `view_ticket_${ticket.id}`,
        value: String(ticket.id)
      }
    });
  });

  if (tickets.length > 10) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `_...and ${tickets.length - 10} more_` }
      ]
    });
  }

  blocks.push({ type: 'divider' });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View All in ServiFlow', emoji: true },
        url: `${SERVIFLOW_URL}/tickets`,
        action_id: 'open_serviflow_tickets'
      }
    ]
  });

  // Add mode indicator
  if (mode) {
    const modeEmoji = mode === 'expert' ? ':necktie:' : ':bust_in_silhouette:';
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${modeEmoji} ${mode}` }
      ]
    });
  }

  return blocks;
}

/**
 * Build help blocks
 */
function buildHelpBlocks(mode = 'expert') {
  const isExpert = mode === 'expert';
  const modeEmoji = isExpert ? ':necktie:' : ':bust_in_silhouette:';
  const modeLabel = isExpert ? 'Expert' : 'Customer';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'ServiFlow Bot Commands', emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${modeEmoji} Current mode: *${modeLabel}*` }
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Common Commands*\n' +
          '`/ticket create [description]` - Create a new ticket\n' +
          '`/ticket status #123` - View ticket details\n' +
          '`/ticket list` - List your tickets\n' +
          '`/ticket mode` - Show/switch mode\n' +
          '`/ticket help` - Show this help'
      }
    }
  ];

  if (isExpert) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Expert Commands*\n' +
          '`/ticket assign #123` - Assign ticket to yourself\n' +
          '`/ticket resolve #123 [comment]` - Resolve a ticket\n' +
          '`/ticket trends` - View ticket analytics'
      }
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open ServiFlow', emoji: true },
        url: SERVIFLOW_URL,
        action_id: 'open_serviflow_main'
      }
    ]
  });

  return blocks;
}

/**
 * Build mode selection blocks
 */
function buildModeBlocks(currentMode, isExpert, userName) {
  const modeEmoji = currentMode === 'expert' ? ':necktie:' : ':bust_in_silhouette:';
  const modeLabel = currentMode.charAt(0).toUpperCase() + currentMode.slice(1);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${modeEmoji} Bot Mode Settings`, emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Hello, ${userName}!` }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Current Mode*\n${modeLabel}` },
        { type: 'mrkdwn', text: `*Account Type*\n${isExpert ? 'Expert/Staff' : 'Customer'}` }
      ]
    }
  ];

  // Add mode description
  if (currentMode === 'expert') {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Expert Mode Features:*\n• View tickets assigned to you\n• Resolve and assign tickets\n• Access trends\n• Create internal tickets'
      }
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Customer Mode Features:*\n• View tickets you have raised\n• Create new support tickets\n• Check ticket status'
      }
    });
  }

  // Add switch buttons if eligible
  if (isExpert) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'actions',
      elements: currentMode === 'expert' ? [
        {
          type: 'button',
          text: { type: 'plain_text', text: ':bust_in_silhouette: Switch to Customer Mode', emoji: true },
          action_id: 'set_mode_customer',
          value: 'customer'
        }
      ] : [
        {
          type: 'button',
          text: { type: 'plain_text', text: ':necktie: Switch to Expert Mode', emoji: true },
          action_id: 'set_mode_expert',
          value: 'expert'
        }
      ]
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '_You are registered as a customer. Expert mode is not available._' }
      ]
    });
  }

  return blocks;
}

/**
 * Build create ticket modal
 */
function buildCreateTicketModal() {
  return {
    type: 'modal',
    callback_id: 'create_ticket_modal',
    title: { type: 'plain_text', text: 'Create Ticket' },
    submit: { type: 'plain_text', text: 'Create' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'title_block',
        element: {
          type: 'plain_text_input',
          action_id: 'title_input',
          placeholder: { type: 'plain_text', text: 'Brief description of the issue' }
        },
        label: { type: 'plain_text', text: 'Title' }
      },
      {
        type: 'input',
        block_id: 'description_block',
        element: {
          type: 'plain_text_input',
          action_id: 'description_input',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Detailed description...' }
        },
        label: { type: 'plain_text', text: 'Description' },
        optional: true
      },
      {
        type: 'input',
        block_id: 'priority_block',
        element: {
          type: 'static_select',
          action_id: 'priority_select',
          initial_option: {
            text: { type: 'plain_text', text: 'Medium' },
            value: 'medium'
          },
          options: [
            { text: { type: 'plain_text', text: 'Low' }, value: 'low' },
            { text: { type: 'plain_text', text: 'Medium' }, value: 'medium' },
            { text: { type: 'plain_text', text: 'High' }, value: 'high' },
            { text: { type: 'plain_text', text: 'Critical' }, value: 'critical' }
          ]
        },
        label: { type: 'plain_text', text: 'Priority' }
      }
    ]
  };
}

module.exports = {
  buildTicketBlocks,
  buildTicketListBlocks,
  buildHelpBlocks,
  buildModeBlocks,
  buildCreateTicketModal
};
