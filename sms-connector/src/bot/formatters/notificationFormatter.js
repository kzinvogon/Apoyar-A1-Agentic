/**
 * Plain-text notification formatters for outbound SMS notifications.
 */

const { truncate } = require('./ticketFormatter');

/**
 * Format a proactive notification message
 * @param {string} eventType - created, assigned, resolved, status_changed, comment
 * @param {object} ticket - Ticket data
 * @param {object} details - Event-specific details
 * @param {string} ticketUrl - Optional URL
 * @returns {string}
 */
function formatNotification(eventType, ticket, details = {}, ticketUrl) {
  const title = truncate(ticket.title, 40);
  let msg = '';

  switch (eventType) {
    case 'created':
      msg = `New ticket #${ticket.id}: ${title}\n`;
      msg += `Priority: ${ticket.priority || 'Medium'}`;
      if (ticket.requester_name) {
        msg += ` | From: ${ticket.requester_name}`;
      }
      break;

    case 'assigned':
      msg = `Ticket #${ticket.id} assigned to ${details.assignedTo || 'you'}\n`;
      msg += `${title}`;
      break;

    case 'resolved':
      msg = `Ticket #${ticket.id} resolved\n`;
      msg += `${title}`;
      if (details.resolutionComment) {
        msg += `\n${truncate(details.resolutionComment, 60)}`;
      }
      break;

    case 'status_changed':
      msg = `Ticket #${ticket.id} status changed`;
      if (details.previousStatus) {
        msg += ` from ${details.previousStatus}`;
      }
      msg += ` to ${ticket.status}\n`;
      msg += `${title}`;
      break;

    case 'comment':
      msg = `New comment on #${ticket.id}: ${title}`;
      if (details.comment) {
        msg += `\n${truncate(details.comment, 80)}`;
      }
      break;

    default:
      msg = `Ticket #${ticket.id} updated: ${title}`;
  }

  if (ticketUrl) {
    msg += `\nView: ${ticketUrl}`;
  }

  return msg;
}

module.exports = { formatNotification };
