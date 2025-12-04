const { getTenantConnection } = require('./config/database');
const bcrypt = require('bcrypt');

async function createTicketManually() {
  console.log('🎫 Manual Ticket Creation Test\n');

  try {
    const connection = await getTenantConnection('apoyar');

    try {
      // Email data from the Nagios alert
      const emailData = {
        from: 'nagiosalerts@apoyar.eu',
        subject: '** PROBLEM Service Alert: Volumes/FreeNAS is CRITICAL **',
        body: `***** Nagios *****
Notification Type: PROBLEM
Service: Volumes
Host: FreeNAS
Address: san
State: CRITICAL
Date/Time: Mon Nov 24 02:29:08 GMT 2025
Additional Info:

CRITICAL - Volume Apoyar is DEGRADED`,
        messageId: 'test-manual-' + Date.now(),
        date: new Date()
      };

      console.log('📧 Email Details:');
      console.log(`   From: ${emailData.from}`);
      console.log(`   Subject: ${emailData.subject}`);
      console.log();

      // Step 1: Extract domain
      const fromEmail = emailData.from.toLowerCase();
      const domain = fromEmail.split('@')[1];
      console.log(`🔍 Extracted domain: ${domain}`);

      // Step 2: Check if domain exists
      const [domainCustomers] = await connection.query(
        'SELECT * FROM customers WHERE company_domain = ?',
        [domain]
      );

      if (domainCustomers.length === 0) {
        console.log(`❌ Domain ${domain} not found in customers table`);
        connection.release();
        return;
      }

      console.log(`✅ Found customer: ${domainCustomers[0].company_name}`);
      console.log();

      // Step 3: Check if email exists in users
      const [existingUsers] = await connection.query(
        'SELECT u.id as user_id, c.id as customer_id FROM users u ' +
        'LEFT JOIN customers c ON u.id = c.user_id ' +
        'WHERE u.email = ? AND u.role = "customer"',
        [fromEmail]
      );

      let userId;
      if (existingUsers.length > 0) {
        userId = existingUsers[0].user_id;
        console.log(`✅ User exists with ID: ${userId}`);
      } else {
        // Create new user
        console.log(`⚠️  User ${fromEmail} does not exist, creating...`);

        const username = fromEmail.split('@')[0].replace(/[^a-z0-9]/g, '_');
        const tempPassword = Math.random().toString(36).slice(-10);
        const passwordHash = await bcrypt.hash(tempPassword, 10);

        const [userResult] = await connection.query(
          'INSERT INTO users (username, password_hash, role, email, full_name) VALUES (?, ?, ?, ?, ?)',
          [username, passwordHash, 'customer', fromEmail, 'Nagios Alerts']
        );

        userId = userResult.insertId;
        console.log(`✅ Created user ID: ${userId} (username: ${username})`);
      }
      console.log();

      // Step 4: Analyze priority
      const title = emailData.subject;
      const description = emailData.body;
      let priority = 'medium';

      const urgentKeywords = ['urgent', 'critical', 'emergency', 'asap', 'down', 'problem'];
      const emailText = (title + ' ' + description).toLowerCase();

      if (urgentKeywords.some(keyword => emailText.includes(keyword))) {
        priority = 'high';
      }

      console.log(`📊 Priority detected: ${priority}`);

      // Step 5: Calculate SLA
      const slaHours = priority === 'high' ? 4 : 24;
      const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000);
      console.log(`⏰ SLA deadline: ${slaDeadline.toLocaleString()} (${slaHours}h)`);
      console.log();

      // Step 6: Create ticket
      console.log('🎫 Creating ticket...');
      const [result] = await connection.query(
        'INSERT INTO tickets (title, description, status, priority, category, requester_id, sla_deadline) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [title, description, 'open', priority, 'Email', userId, slaDeadline]
      );

      const ticketId = result.insertId;
      console.log(`✅ Ticket #${ticketId} created successfully!`);

      // Step 7: Log activity
      await connection.query(
        'INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description) VALUES (?, ?, ?, ?)',
        [ticketId, userId, 'created', `Ticket created from email: ${emailData.from}`]
      );

      console.log(`✅ Activity logged`);
      console.log();

      // Verify
      const [ticket] = await connection.query(
        'SELECT * FROM tickets WHERE id = ?',
        [ticketId]
      );

      console.log('📋 Ticket Details:');
      console.log(`   ID: ${ticket[0].id}`);
      console.log(`   Title: ${ticket[0].title}`);
      console.log(`   Status: ${ticket[0].status}`);
      console.log(`   Priority: ${ticket[0].priority}`);
      console.log(`   Requester ID: ${ticket[0].requester_id}`);
      console.log(`   SLA Deadline: ${ticket[0].sla_deadline}`);
      console.log();

      console.log('✅ SUCCESS! Email successfully processed and ticket created.');

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

createTicketManually()
  .then(() => {
    console.log('\n✅ Test completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  });
