const { TeamsActivityHandler, CardFactory, MessageFactory } = require('botbuilder');
const { buildTicketCard } = require('./adaptiveCards/ticketCard');
const { buildNotificationCard } = require('./adaptiveCards/notificationCard');
const { buildHelpCard, buildTicketListCard, buildCreateTicketForm } = require('./adaptiveCards/ticketCard');
const serviflowApi = require('../services/serviflowApi');

class ServiFlowBot extends TeamsActivityHandler {
  constructor() {
    super();

    // Handle incoming messages
    this.onMessage(async (context, next) => {
      await this.handleMessage(context);
      await next();
    });

    // Handle when bot is added to a team/channel
    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded;
      for (const member of membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            'Hello! I\'m the ServiFlow Bot. I can help you manage support tickets.\n\n' +
            'Try commands like:\n' +
            '- `create <title>` - Create a new ticket\n' +
            '- `status #123` - Check ticket status\n' +
            '- `my tickets` - List your assigned tickets\n' +
            '- `help` - Show all commands'
          );
        }
      }
      await next();
    });

    // Handle adaptive card actions
    this.onAdaptiveCardInvoke(async (context, invokeValue) => {
      const action = invokeValue.action;
      const data = action.data || {};

      try {
        switch (data.action) {
          case 'viewTicket':
            await this.handleViewTicket(context, data.ticketId);
            break;
          case 'assignToMe':
            await this.handleAssignToMe(context, data.ticketId);
            break;
          case 'resolveTicket':
            await this.handleResolveTicket(context, data.ticketId);
            break;
          case 'createTicket':
            await this.handleCreateTicketSubmit(context, data);
            break;
          default:
            await context.sendActivity('Unknown action');
        }
        return { statusCode: 200 };
      } catch (error) {
        console.error('Card action error:', error);
        await context.sendActivity(`Error: ${error.message}`);
        return { statusCode: 500 };
      }
    });
  }

  async handleMessage(context) {
    const text = this.removeBotMention(context.activity.text || '').trim().toLowerCase();
    const teamsUserId = context.activity.from.aadObjectId;
    const teamsUserEmail = context.activity.from.email || context.activity.from.userPrincipalName;

    console.log(`[Bot] Message from ${teamsUserEmail}: ${text}`);

    try {
      if (text.startsWith('create ')) {
        await this.handleCreateTicket(context, text.slice(7).trim());
      } else if (text.startsWith('status ') || text.startsWith('status#')) {
        const ticketId = text.replace('status', '').replace('#', '').trim();
        await this.handleViewTicket(context, ticketId);
      } else if (text.includes('my tickets') || text === 'assigned' || text === 'list') {
        await this.handleMyTickets(context);
      } else if (text.startsWith('resolve ') || text.startsWith('resolve#')) {
        const parts = text.replace('resolve', '').trim().split(' ');
        const ticketId = parts[0].replace('#', '');
        const comment = parts.slice(1).join(' ') || 'Resolved via Teams';
        await this.handleResolveTicket(context, ticketId, comment);
      } else if (text.startsWith('assign ') || text.startsWith('assign#')) {
        const ticketId = text.replace('assign', '').replace('#', '').trim();
        await this.handleAssignToMe(context, ticketId);
      } else if (text === 'help' || text === '?' || text === 'commands') {
        await this.sendHelpCard(context);
      } else {
        await this.sendHelpCard(context);
      }
    } catch (error) {
      console.error('[Bot] Error handling message:', error);
      await context.sendActivity(`Error: ${error.message}`);
    }
  }

  async handleCreateTicket(context, title) {
    if (!title) {
      // Show create ticket form
      const card = buildCreateTicketForm();
      await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
      return;
    }

    const userEmail = context.activity.from.email || context.activity.from.userPrincipalName;

    try {
      const result = await serviflowApi.createTicket({
        title: title,
        description: `Created from Microsoft Teams by ${userEmail}`,
        priority: 'medium',
        source: 'teams',
        requester_email: userEmail
      });

      if (result.success) {
        const card = buildTicketCard(result.ticket);
        await context.sendActivity({
          text: `Ticket #${result.ticket.id} created successfully!`,
          attachments: [CardFactory.adaptiveCard(card)]
        });
      } else {
        await context.sendActivity(`Failed to create ticket: ${result.message}`);
      }
    } catch (error) {
      console.error('[Bot] Create ticket error:', error);
      await context.sendActivity(`Failed to create ticket: ${error.message}`);
    }
  }

  async handleCreateTicketSubmit(context, data) {
    const userEmail = context.activity.from.email || context.activity.from.userPrincipalName;

    try {
      const result = await serviflowApi.createTicket({
        title: data.title,
        description: data.description || `Created from Microsoft Teams by ${userEmail}`,
        priority: data.priority || 'medium',
        source: 'teams',
        requester_email: userEmail
      });

      if (result.success) {
        const card = buildTicketCard(result.ticket);
        await context.sendActivity({
          text: `Ticket #${result.ticket.id} created successfully!`,
          attachments: [CardFactory.adaptiveCard(card)]
        });
      } else {
        await context.sendActivity(`Failed to create ticket: ${result.message}`);
      }
    } catch (error) {
      await context.sendActivity(`Failed to create ticket: ${error.message}`);
    }
  }

  async handleViewTicket(context, ticketId) {
    try {
      const result = await serviflowApi.getTicket(ticketId);

      if (result.success) {
        const card = buildTicketCard(result.ticket);
        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
      } else {
        await context.sendActivity(`Ticket #${ticketId} not found.`);
      }
    } catch (error) {
      console.error('[Bot] View ticket error:', error);
      await context.sendActivity(`Failed to get ticket: ${error.message}`);
    }
  }

  async handleMyTickets(context) {
    const userEmail = context.activity.from.email || context.activity.from.userPrincipalName;

    try {
      const result = await serviflowApi.getMyTickets(userEmail);

      if (result.success && result.tickets.length > 0) {
        const card = buildTicketListCard(result.tickets);
        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
      } else if (result.success) {
        await context.sendActivity('You have no assigned tickets.');
      } else {
        await context.sendActivity(`Failed to get tickets: ${result.message}`);
      }
    } catch (error) {
      console.error('[Bot] My tickets error:', error);
      await context.sendActivity(`Failed to get tickets: ${error.message}`);
    }
  }

  async handleAssignToMe(context, ticketId) {
    const userEmail = context.activity.from.email || context.activity.from.userPrincipalName;

    try {
      const result = await serviflowApi.assignTicket(ticketId, userEmail);

      if (result.success) {
        await context.sendActivity(`Ticket #${ticketId} has been assigned to you.`);
        // Show updated ticket
        await this.handleViewTicket(context, ticketId);
      } else {
        await context.sendActivity(`Failed to assign ticket: ${result.message}`);
      }
    } catch (error) {
      console.error('[Bot] Assign ticket error:', error);
      await context.sendActivity(`Failed to assign ticket: ${error.message}`);
    }
  }

  async handleResolveTicket(context, ticketId, comment = 'Resolved via Teams') {
    const userEmail = context.activity.from.email || context.activity.from.userPrincipalName;

    try {
      const result = await serviflowApi.resolveTicket(ticketId, userEmail, comment);

      if (result.success) {
        await context.sendActivity(`Ticket #${ticketId} has been resolved.`);
        // Show updated ticket
        await this.handleViewTicket(context, ticketId);
      } else {
        await context.sendActivity(`Failed to resolve ticket: ${result.message}`);
      }
    } catch (error) {
      console.error('[Bot] Resolve ticket error:', error);
      await context.sendActivity(`Failed to resolve ticket: ${error.message}`);
    }
  }

  async sendHelpCard(context) {
    const card = buildHelpCard();
    await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
  }

  removeBotMention(text) {
    // Remove bot mention from message (format: <at>BotName</at>)
    return text.replace(/<at>.*?<\/at>/gi, '').trim();
  }
}

module.exports = { ServiFlowBot };
