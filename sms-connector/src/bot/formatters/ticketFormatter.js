/**
 * Plain-text ticket formatters for SMS responses.
 * SMS is limited so we keep responses concise.
 */

/**
 * Format a date for SMS display
 */
function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Truncate text to a max length
 */
function truncate(text, maxLen = 60) {
  if (!text) return '';
  return text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
}

/**
 * Format ticket created response
 */
function formatTicketCreated(ticket, ticketUrl) {
  let msg = `Ticket #${ticket.id} created!\n`;
  msg += `Status: ${ticket.status} | Priority: ${ticket.priority || 'Medium'}`;
  if (ticketUrl) {
    msg += `\nView: ${ticketUrl}`;
  }
  return msg;
}

/**
 * Format ticket detail response
 */
function formatTicketDetail(ticket, ticketUrl) {
  let msg = `#${ticket.id}: ${truncate(ticket.title, 50)}\n`;
  msg += `Status: ${ticket.status} | Priority: ${ticket.priority || 'N/A'}\n`;
  msg += `Assignee: ${ticket.assignee_name || 'Unassigned'}\n`;
  msg += `Created: ${formatDate(ticket.created_at)}`;
  if (ticketUrl) {
    msg += `\nView: ${ticketUrl}`;
  }
  return msg;
}

/**
 * Format ticket list response (max 5 tickets)
 */
function formatTicketList(tickets, title) {
  if (!tickets || tickets.length === 0) {
    return 'No tickets found.';
  }

  const maxDisplay = 5;
  const displayed = tickets.slice(0, maxDisplay);

  let msg = `${title} (${tickets.length}):\n`;
  for (const t of displayed) {
    msg += `#${t.id} ${t.status} - ${truncate(t.title, 40)}\n`;
  }

  if (tickets.length > maxDisplay) {
    msg += `+${tickets.length - maxDisplay} more`;
  }

  msg += `\nReply #ID for details`;
  return msg;
}

/**
 * Format help message
 */
function formatHelp() {
  return `ServiFlow SMS:\n` +
    `new: [desc] - Create ticket\n` +
    `#123 - Ticket detail\n` +
    `my tickets - Your tickets\n` +
    `mode expert/customer - Switch\n` +
    `resolve 123 [comment] - Resolve\n` +
    `assign 123 - Assign to self\n` +
    `help - Commands`;
}

/**
 * Format mode status
 */
function formatMode(mode, isExpert) {
  const emoji = mode === 'expert' ? 'Expert' : 'Customer';
  let msg = `Mode: ${emoji}`;
  if (isExpert) {
    msg += `\nReply "mode expert" or "mode customer" to switch`;
  }
  return msg;
}

/**
 * Format mode switch confirmation
 */
function formatModeSwitch(newMode) {
  const features = newMode === 'expert'
    ? 'View assigned, resolve, assign tickets'
    : 'View your tickets, create new tickets';
  return `Mode switched to ${newMode.charAt(0).toUpperCase() + newMode.slice(1)}.\n${features}`;
}

module.exports = {
  formatTicketCreated,
  formatTicketDetail,
  formatTicketList,
  formatHelp,
  formatMode,
  formatModeSwitch,
  formatDate,
  truncate
};
