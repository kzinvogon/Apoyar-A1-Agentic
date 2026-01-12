/**
 * SLA Selector Service
 *
 * Resolves which SLA definition should apply to a ticket based on
 * priority order: ticket override → customer → category → cmdb → default
 */

const { getTenantConnection } = require('../config/database');

/**
 * Resolve the applicable SLA for a ticket
 *
 * Priority order:
 * 1) Ticket override (explicit sla_definition_id)
 * 2) Customer/Contract SLA (via requester → customer_company)
 * 3) Category SLA (via category_sla_mappings)
 * 4) CMDB item SLA
 * 5) Default SLA
 *
 * @param {Object} options
 * @param {string} options.tenantCode - Tenant code for database connection
 * @param {Object} options.ticketPayload - Ticket data containing potential SLA sources
 * @param {number} [options.ticketPayload.sla_definition_id] - Explicit SLA override
 * @param {number} [options.ticketPayload.requester_id] - Requester user ID (for customer lookup)
 * @param {string} [options.ticketPayload.category] - Category string
 * @param {number} [options.ticketPayload.cmdb_item_id] - CMDB item ID
 *
 * @returns {Promise<{slaId: number|null, source: string}>}
 */
async function resolveApplicableSLA({ tenantCode, ticketPayload = {} }) {
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

    // 2) Customer/Contract SLA via requester chain
    if (ticketPayload.requester_id) {
      const slaId = await getCustomerSLA(connection, ticketPayload.requester_id);
      if (slaId) {
        return { slaId, source: 'customer' };
      }
    }

    // 3) Category SLA via category_sla_mappings
    if (ticketPayload.category) {
      const slaId = await getCategorySLA(connection, ticketPayload.category);
      if (slaId) {
        return { slaId, source: 'category' };
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
 * Get SLA from customer's company via requester chain
 * Lookup: requester_id → customers.user_id → customer_companies.sla_definition_id
 * Fallback: If sla_definition_id not set, try to match sla_level text to SLA definition name
 */
async function getCustomerSLA(connection, requesterId) {
  try {
    const [rows] = await connection.query(`
      SELECT cc.sla_definition_id, cc.sla_level
      FROM customers c
      JOIN customer_companies cc ON cc.id = c.customer_company_id
      WHERE c.user_id = ?
      LIMIT 1
    `, [requesterId]);

    if (rows.length > 0) {
      // First try explicit sla_definition_id
      if (rows[0].sla_definition_id) {
        const validId = await validateSLAExists(connection, rows[0].sla_definition_id);
        if (validId) return validId;
      }

      // Fallback: Try to match sla_level text to SLA definition name
      if (rows[0].sla_level) {
        const slaId = await getSLAByName(connection, rows[0].sla_level);
        if (slaId) return slaId;
      }
    }
    return null;
  } catch (error) {
    console.error('[SLA_SELECTOR] Error getting customer SLA:', error.message);
    return null;
  }
}

/**
 * Get SLA definition by name (case-insensitive partial match)
 */
async function getSLAByName(connection, slaName) {
  try {
    const [rows] = await connection.query(`
      SELECT id FROM sla_definitions
      WHERE LOWER(name) LIKE CONCAT('%', LOWER(?), '%')
        AND is_active = 1
      ORDER BY
        CASE WHEN LOWER(name) = LOWER(?) THEN 0 ELSE 1 END,
        id ASC
      LIMIT 1
    `, [slaName, slaName]);
    return rows.length > 0 ? rows[0].id : null;
  } catch (error) {
    console.error('[SLA_SELECTOR] Error getting SLA by name:', error.message);
    return null;
  }
}

/**
 * Get SLA from category mapping (exact match, categories stored lowercase)
 */
async function getCategorySLA(connection, category) {
  try {
    // Normalize input to lowercase for exact match against stored lowercase categories
    const normalizedCategory = category.trim().toLowerCase();
    const [rows] = await connection.query(`
      SELECT sla_definition_id
      FROM category_sla_mappings
      WHERE category = ?
        AND is_active = 1
      LIMIT 1
    `, [normalizedCategory]);

    if (rows.length > 0 && rows[0].sla_definition_id) {
      // Validate the SLA is still active
      return await validateSLAExists(connection, rows[0].sla_definition_id);
    }
    return null;
  } catch (error) {
    console.error('[SLA_SELECTOR] Error getting category SLA:', error.message);
    return null;
  }
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
