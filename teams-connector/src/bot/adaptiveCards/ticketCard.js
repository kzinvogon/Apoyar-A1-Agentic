const SERVIFLOW_URL = process.env.SERVIFLOW_URL || 'https://serviflow.app';

const priorityColors = {
  low: 'good',
  medium: 'warning',
  high: 'attention',
  critical: 'attention'
};

const statusEmoji = {
  'open': '🔵',
  'Open': '🔵',
  'in_progress': '🟡',
  'In Progress': '🟡',
  'pending': '🟠',
  'Pending': '🟠',
  'paused': '🟠',
  'Paused': '🟠',
  'resolved': '🟢',
  'Resolved': '🟢',
  'closed': '⚫',
  'Closed': '⚫'
};

function buildTicketCard(ticket) {
  const priority = (ticket.priority || 'medium').toLowerCase();
  const status = ticket.status || 'Open';

  return {
    type: 'AdaptiveCard',
    version: '1.4',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [
      {
        type: 'Container',
        style: priorityColors[priority] || 'default',
        items: [
          {
            type: 'ColumnSet',
            columns: [
              {
                type: 'Column',
                width: 'stretch',
                items: [
                  {
                    type: 'TextBlock',
                    text: `Ticket #${ticket.id}`,
                    weight: 'bolder',
                    size: 'large',
                    color: 'default'
                  }
                ]
              },
              {
                type: 'Column',
                width: 'auto',
                items: [
                  {
                    type: 'TextBlock',
                    text: `${priority.toUpperCase()}`,
                    weight: 'bolder',
                    size: 'small',
                    color: priority === 'critical' || priority === 'high' ? 'attention' : 'default'
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        type: 'TextBlock',
        text: ticket.title,
        wrap: true,
        size: 'medium',
        weight: 'bolder',
        spacing: 'medium'
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Status', value: `${statusEmoji[status] || ''} ${status}` },
          { title: 'Priority', value: priority.charAt(0).toUpperCase() + priority.slice(1) },
          { title: 'Assignee', value: ticket.assignee_name || ticket.assignee_full_name || 'Unassigned' },
          { title: 'Requester', value: ticket.requester_name || ticket.customer_name || 'Unknown' },
          { title: 'Created', value: formatDate(ticket.created_at) }
        ],
        spacing: 'medium'
      },
      {
        type: 'TextBlock',
        text: truncate(ticket.description, 200),
        wrap: true,
        maxLines: 3,
        isSubtle: true,
        spacing: 'medium'
      }
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'View in ServiFlow',
        url: `${SERVIFLOW_URL}/ticket/${ticket.id}`
      },
      {
        type: 'Action.Submit',
        title: 'Assign to Me',
        data: { action: 'assignToMe', ticketId: ticket.id }
      },
      {
        type: 'Action.Submit',
        title: 'Resolve',
        data: { action: 'resolveTicket', ticketId: ticket.id }
      }
    ]
  };
}

function buildTicketListCard(tickets) {
  const ticketItems = tickets.slice(0, 10).map(ticket => ({
    type: 'Container',
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
                text: `#${ticket.id}`,
                weight: 'bolder',
                size: 'small'
              }
            ]
          },
          {
            type: 'Column',
            width: 'stretch',
            items: [
              {
                type: 'TextBlock',
                text: truncate(ticket.title, 50),
                wrap: true,
                size: 'small'
              }
            ]
          },
          {
            type: 'Column',
            width: 'auto',
            items: [
              {
                type: 'TextBlock',
                text: `${statusEmoji[ticket.status] || ''} ${ticket.status}`,
                size: 'small'
              }
            ]
          }
        ],
        selectAction: {
          type: 'Action.Submit',
          data: { action: 'viewTicket', ticketId: ticket.id }
        }
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
        type: 'TextBlock',
        text: `My Assigned Tickets (${tickets.length})`,
        weight: 'bolder',
        size: 'large'
      },
      ...ticketItems,
      ...(tickets.length > 10 ? [{
        type: 'TextBlock',
        text: `...and ${tickets.length - 10} more`,
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

function buildHelpCard() {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [
      {
        type: 'TextBlock',
        text: 'ServiFlow Bot Commands',
        weight: 'bolder',
        size: 'large'
      },
      {
        type: 'TextBlock',
        text: 'Use these commands to manage tickets:',
        wrap: true,
        spacing: 'medium'
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'create <title>', value: 'Create a new ticket' },
          { title: 'status #123', value: 'View ticket details' },
          { title: 'my tickets', value: 'List your assigned tickets' },
          { title: 'assign #123', value: 'Assign ticket to yourself' },
          { title: 'resolve #123 <comment>', value: 'Resolve a ticket' },
          { title: 'help', value: 'Show this help message' }
        ]
      }
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Open ServiFlow',
        url: SERVIFLOW_URL
      }
    ]
  };
}

function buildCreateTicketForm() {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [
      {
        type: 'TextBlock',
        text: 'Create New Ticket',
        weight: 'bolder',
        size: 'large'
      },
      {
        type: 'Input.Text',
        id: 'title',
        label: 'Title',
        placeholder: 'Brief description of the issue',
        isRequired: true
      },
      {
        type: 'Input.Text',
        id: 'description',
        label: 'Description',
        placeholder: 'Detailed description...',
        isMultiline: true
      },
      {
        type: 'Input.ChoiceSet',
        id: 'priority',
        label: 'Priority',
        value: 'medium',
        choices: [
          { title: 'Low', value: 'low' },
          { title: 'Medium', value: 'medium' },
          { title: 'High', value: 'high' },
          { title: 'Critical', value: 'critical' }
        ]
      }
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: 'Create Ticket',
        data: { action: 'createTicket' }
      }
    ]
  };
}

// Helper functions
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

module.exports = {
  buildTicketCard,
  buildTicketListCard,
  buildHelpCard,
  buildCreateTicketForm
};
