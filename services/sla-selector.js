/**
 * SLA Selector Service
 *
 * Resolves which SLA definition should apply to a ticket based on
 * priority order: ticket override → customer → service → cmdb → default
 */

const { getTenantConnection } = require('../config/database');

/**
 * Resolve the applicable SLA for a ticket
 *
 * @param {Object} options
 * @param {string} options.tenantCode - Tenant code for database connection
 * @param {number} [options.ticketId] - Existing ticket ID (for re-application)
 * @param {Object} options.ticketPayload - Ticket data containing potential SLA sources
 * @param {number} [options.ticketPayload.sla_definition_id] - Explicit SLA override
 * @param {number} [options.ticketPayload.customer_id] - Customer/requester user ID
 * @param {number} [options.ticketPayload.service_id] - Service ID (future use)
 * @param {number} [options.ticketPayload.category_id] - Category ID (future use)
 * @param {number} [options.ticketPayload.cmdb_item_id] - CMDB item ID
 *
 * @returns {Promise<{slaId: number|null, source: string}>}
 */
async function resolveApplicableSLA({ tenantCode, ticketId, ticketPayload = {} }) {
  let connection;

  try {
    connection = await getTenantConnection(tenantCode);

    // 1) Explicit ticket override - highest priority
    if (ticketPayload.sla_definition_id) {
      const slaId = await validateSLAExists(connection, ticketPayload.sla_definition_id);
      if (slaId) {
        return { slaId, source: 'ticket' };
      }
      // If invalid SLA ID provided, fall through to other sources
    }

    // 2) Customer's company SLA
    if (ticketPayload.customer_id) {
      const slaId = await getCustomerSLA(connection, ticketPayload.customer_id);
      if (slaId) {
        return { slaId, source: 'customer' };
      }
    }

    // 3) Service/Category SLA (future - no services table yet)
    if (ticketPayload.service_id || ticketPayload.category_id) {
      const slaId = await getServiceSLA(connection, ticketPayload.service_id, ticketPayload.category_id);
      if (slaId) {
        return { slaId, source: 'service' };
      }
    }

    // 4) CMDB Item SLA
    if (ticketPayload.cmdb_item_id) {
      const slaId = await getCMDBItemSLA(connection, ticketPayload.cmdb_item_id);
      if (slaId) {
        return { slaId, source: 'cmdb' };
      }
    }

    // 5) Default SLA - lowest priority
    const defaultSlaId = await getDefaultSLAId(connection);
    return { slaId: defaultSlaId, source: 'default' };

  } catch (error) {
    console.error('[SLA_SELECTOR] Error resolving SLA:', error.message);
    // On error, return null to let caller handle gracefully
    return { slaId: null, source: 'error' };
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Validate that an SLA definition exists and is active
 */
async function validateSLAExists(connection, slaId) {
  try {
    const [rows] = await connection.query(
      'SELECT id FROM sla_definitions WHERE id = ? AND is_active = 1',
      [slaId]
    );
    return rows.length > 0 ? rows[0].id : null;
  } catch (error) {
    console.error('[SLA_SELECTOR] Error validating SLA:', error.message);
    return null;
  }
}

/**
 * Get SLA from customer's company
 * Lookup: customer_id → customers.customer_company_id → customer_companies.sla_definition_id
 */
async function getCustomerSLA(connection, customerId) {
  try {
    const [rows] = await connection.query(`
      SELECT cc.sla_definition_id
      FROM customers c
      JOIN customer_companies cc ON c.customer_company_id = cc.id
      WHERE c.user_id = ?
        AND cc.sla_definition_id IS NOT NULL
        AND cc.is_active = 1
    `, [customerId]);

    if (rows.length > 0 && rows[0].sla_definition_id) {
      // Validate the SLA is still active
      return await validateSLAExists(connection, rows[0].sla_definition_id);
    }
    return null;
  } catch (error) {
    console.error('[SLA_SELECTOR] Error getting customer SLA:', error.message);
    return null;
  }
}

/**
 * Get SLA from service/category
 * Placeholder - services table doesn't exist yet
 */
async function getServiceSLA(connection, serviceId, categoryId) {
  // TODO: Implement when services/categories table with sla_definition_id exists
  // For now, return null to fall through to next source
  return null;
}

/**
 * Get SLA from CMDB item
 */
async function getCMDBItemSLA(connection, cmdbItemId) {
  try {
    const [rows] = await connection.query(`
      SELECT sla_definition_id
      FROM cmdb_items
      WHERE id = ?
        AND sla_definition_id IS NOT NULL
        AND status = 'active'
    `, [cmdbItemId]);

    if (rows.length > 0 && rows[0].sla_definition_id) {
      // Validate the SLA is still active
      return await validateSLAExists(connection, rows[0].sla_definition_id);
    }
    return null;
  } catch (error) {
    console.error('[SLA_SELECTOR] Error getting CMDB item SLA:', error.message);
    return null;
  }
}

/**
 * Get default SLA (first active SLA definition)
 */
async function getDefaultSLAId(connection) {
  try {
    const [rows] = await connection.query(`
      SELECT id FROM sla_definitions
      WHERE is_active = 1
      ORDER BY id ASC
      LIMIT 1
    `);
    return rows.length > 0 ? rows[0].id : null;
  } catch (error) {
    console.error('[SLA_SELECTOR] Error getting default SLA:', error.message);
    return null;
  }
}

module.exports = {
  resolveApplicableSLA
};
