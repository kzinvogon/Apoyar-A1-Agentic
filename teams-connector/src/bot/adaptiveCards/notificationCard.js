const SERVIFLOW_URL = process.env.SERVIFLOW_URL || 'https://app.serviflow.app';

const eventConfigs = {
  created: {
    title: 'New Ticket Created',
    color: 'accent',
    emoji: '🆕'
  },
  assigned: {
    title: 'Ticket Assigned',
    color: 'good',
    emoji: '👤'
  },
  resolved: {
    title: 'Ticket Resolved',
    color: 'good',
    emoji: '✅'
  },
  status_changed: {
    title: 'Status Updated',
    color: 'warning',
    emoji: '🔄'
  },
  comment: {
    title: 'New Comment Added',
    color: 'default',
    emoji: '💬'
  },
  priority_changed: {
    title: 'Priority Changed',
    color: 'attention',
    emoji: '⚠️'
  }
};

function buildNotificationCard(eventType, ticket, details = {}, options = {}) {
  const config = eventConfigs[eventType] || { title: 'Ticket Updated', color: 'default', emoji: '📋' };
  const ticketUrl = options.ticketUrl || `${SERVIFLOW_URL}/ticket/${ticket.id}`;

  const body = [
    {
      type: 'Container',
      style: config.color,
      items: [
        {
          type: 'ColumnSet',
          columns: [
            {
              type: 'Column',
              width: 'auto',
              items: [
                {
                  type: 'TextBlock',
                  text: config.emoji,
                  size: 'large'
                }
              ]
            },
            {
              type: 'Column',
              width: 'stretch',
              items: [
                {
                  type: 'TextBlock',
                  text: config.title,
                  weight: 'bolder',
                  size: 'medium'
                }
              ]
            }
          ]
        }
      ]
    },
    {
      type: 'TextBlock',
      text: `**Ticket #${ticket.id}:** ${ticket.title}`,
      wrap: true,
      spacing: 'medium'
    },
    {
      type: 'FactSet',
      facts: [
        { title: 'Priority', value: formatPriority(ticket.priority) },
        { title: 'Status', value: ticket.status || 'Open' },
        { title: 'Assignee', value: ticket.assignee_name || 'Unassigned' }
      ]
    }
  ];

  // Add event-specific details
  if (details.previousStatus && eventType === 'status_changed') {
    body.push({
      type: 'TextBlock',
      text: `Status changed from **${details.previousStatus}** to **${ticket.status}**`,
      wrap: true,
      isSubtle: true
    });
  }

  if (details.assignedTo && eventType === 'assigned') {
    body.push({
      type: 'TextBlock',
      text: `Assigned to **${details.assignedTo}**`,
      wrap: true,
      isSubtle: true
    });
  }

  if (details.comment && eventType === 'comment') {
    body.push({
      type: 'TextBlock',
      text: `"${truncate(details.comment, 150)}"`,
      wrap: true,
      isSubtle: true
    });
  }

  if (details.resolutionComment && eventType === 'resolved') {
    body.push({
      type: 'TextBlock',
      text: `Resolution: ${truncate(details.resolutionComment, 150)}`,
      wrap: true,
      isSubtle: true
    });
  }

  return {
    type: 'AdaptiveCard',
    version: '1.4',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: body,
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'View Details',
        url: ticketUrl
      },
      {
        type: 'Action.Submit',
        title: 'Assign to Me',
        data: { action: 'assignToMe', ticketId: ticket.id }
      }
    ]
  };
}

function buildBatchNotificationCard(tickets, eventType) {
  const config = eventConfigs[eventType] || { title: 'Tickets Updated', color: 'default', emoji: '📋' };

  const ticketList = tickets.slice(0, 5).map(ticket => ({
    type: 'Container',
    items: [
      {
        type: 'TextBlock',
        text: `#${ticket.id} - ${truncate(ticket.title, 40)}`,
        wrap: true,
        size: 'small'
      }
    ],
    separator: true
  }));

  return {
    type: 'AdaptiveCard',
    version: '1.4',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [
      {
        type: 'Container',
        style: config.color,
        items: [
          {
            type: 'TextBlock',
            text: `${config.emoji} ${tickets.length} ${config.title}`,
            weight: 'bolder',
            size: 'medium'
          }
        ]
      },
      ...ticketList,
      ...(tickets.length > 5 ? [{
        type: 'TextBlock',
        text: `...and ${tickets.length - 5} more`,
        isSubtle: true,
        size: 'small'
      }] : [])
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'View All in ServiFlow',
        url: `${SERVIFLOW_URL}/tickets`
      }
    ]
  };
}

// Helper functions
function formatPriority(priority) {
  if (!priority) return 'Medium';
  return priority.charAt(0).toUpperCase() + priority.slice(1).toLowerCase();
}

function truncate(text, length) {
  if (!text) return '';
  if (text.length <= length) return text;
  return text.substring(0, length) + '...';
}

module.exports = {
  buildNotificationCard,
  buildBatchNotificationCard
};
