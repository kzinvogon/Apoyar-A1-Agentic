const fetch = require('node-fetch');

const API_URL = process.env.SERVIFLOW_API_URL || 'https://web-production-11114.up.railway.app';
const TENANT_CODE = process.env.SERVIFLOW_TENANT_CODE || 'apoyar';

// Cache for service account token
let serviceToken = null;
let tokenExpiry = null;

async function getServiceToken() {
  // Check if we have a valid cached token
  if (serviceToken && tokenExpiry && Date.now() < tokenExpiry) {
    return serviceToken;
  }

  // Login as service account
  const response = await fetch(`${API_URL}/api/auth/tenant/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.SERVIFLOW_SERVICE_USER || 'teams-bot',
      password: process.env.SERVIFLOW_SERVICE_PASSWORD,
      tenant_code: TENANT_CODE
    })
  });

  const data = await response.json();

  if (!data.success) {
    throw new Error(`Failed to authenticate service account: ${data.message}`);
  }

  serviceToken = data.token;
  // Token expires in 24h, refresh after 23h
  tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);

  return serviceToken;
}

async function makeRequest(endpoint, options = {}) {
  const token = await getServiceToken();

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers
    }
  });

  const data = await response.json();
  return data;
}

// Ticket Operations

async function createTicket({ title, description, priority, source, requester_email }) {
  // First, find or create customer by email
  let customerId = null;

  try {
    // Try to find existing customer by email
    const customers = await makeRequest(`/api/customers/${TENANT_CODE}?email=${encodeURIComponent(requester_email)}`);
    if (customers.success && customers.customers && customers.customers.length > 0) {
      customerId = customers.customers[0].id;
    }
  } catch (error) {
    console.log('[API] Could not find customer by email, will create ticket without customer_id');
  }

  const ticketData = {
    title,
    description: description || `Created from Microsoft Teams`,
    priority: priority || 'medium',
    customer_id: customerId
  };

  const result = await makeRequest(`/api/tickets/${TENANT_CODE}`, {
    method: 'POST',
    body: JSON.stringify(ticketData)
  });

  return result;
}

async function getTicket(ticketId) {
  const result = await makeRequest(`/api/tickets/${TENANT_CODE}/${ticketId}`);
  return result;
}

async function getTickets(filters = {}) {
  const params = new URLSearchParams(filters);
  const result = await makeRequest(`/api/tickets/${TENANT_CODE}?${params}`);
  return result;
}

async function getMyTickets(userEmail) {
  // Get user by email first
  let userId = null;

  try {
    const experts = await makeRequest(`/api/experts/${TENANT_CODE}`);
    if (experts.success && experts.experts) {
      const user = experts.experts.find(e => e.email.toLowerCase() === userEmail.toLowerCase());
      if (user) {
        userId = user.id;
      }
    }
  } catch (error) {
    console.log('[API] Could not find user by email');
  }

  if (!userId) {
    return { success: false, message: 'User not found in ServiFlow', tickets: [] };
  }

  // Get tickets assigned to this user
  const result = await makeRequest(`/api/tickets/${TENANT_CODE}?assignee_id=${userId}&status=open,in_progress,pending`);

  return {
    success: true,
    tickets: result.tickets || []
  };
}

async function updateTicket(ticketId, updates) {
  const result = await makeRequest(`/api/tickets/${TENANT_CODE}/${ticketId}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  });

  return result;
}

async function assignTicket(ticketId, userEmail) {
  // Get user by email first
  let userId = null;

  try {
    const experts = await makeRequest(`/api/experts/${TENANT_CODE}`);
    if (experts.success && experts.experts) {
      const user = experts.experts.find(e => e.email.toLowerCase() === userEmail.toLowerCase());
      if (user) {
        userId = user.id;
      }
    }
  } catch (error) {
    console.log('[API] Could not find user by email');
  }

  if (!userId) {
    return { success: false, message: 'User not found in ServiFlow. Please ensure your Teams email matches your ServiFlow account.' };
  }

  // Assign ticket
  const result = await updateTicket(ticketId, { assignee_id: userId });
  return result;
}

async function resolveTicket(ticketId, userEmail, comment) {
  const result = await updateTicket(ticketId, {
    status: 'Resolved',
    comment: comment || 'Resolved via Microsoft Teams'
  });

  return result;
}

// User Operations

async function getUserByTeamsId(teamsUserId) {
  // This would query the teams_user_mappings table
  // For now, return null - users need to link accounts
  return null;
}

async function linkTeamsUser(teamsUserId, teamsEmail, serviflowUserId) {
  // This would create a mapping in teams_user_mappings
  // Implementation depends on database migration
  return { success: true };
}

module.exports = {
  createTicket,
  getTicket,
  getTickets,
  getMyTickets,
  updateTicket,
  assignTicket,
  resolveTicket,
  getUserByTeamsId,
  linkTeamsUser,
  getServiceToken,
  makeRequest
};
