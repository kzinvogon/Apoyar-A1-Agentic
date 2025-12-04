const { getTenantConnection } = require('./config/database');

async function checkCriticalTickets() {
  console.log('🎫 Checking for Critical Nagios Tickets\n');

  try {
    const connection = await getTenantConnection('apoyar');

    try {
      // Check for Volumes/FreeNAS tickets
      console.log('📊 Searching for Volumes/FreeNAS tickets...\n');

      const [volumeTickets] = await connection.query(`
        SELECT id, title, status, priority, created_at
        FROM tickets
        WHERE title LIKE '%Volumes%' OR title LIKE '%FreeNAS%' OR title LIKE '%DEGRADED%'
        ORDER BY id DESC
        LIMIT 10
      `);

      if (volumeTickets.length > 0) {
        console.log(`✅ Found ${volumeTickets.length} Volumes/FreeNAS ticket(s):\n`);
        volumeTickets.forEach(ticket => {
          console.log(`   Ticket #${ticket.id}`);
          console.log(`   Title: ${ticket.title}`);
          console.log(`   Status: ${ticket.status}`);
          console.log(`   Priority: ${ticket.priority}`);
          console.log(`   Created: ${ticket.created_at}`);
          console.log();
        });
      } else {
        console.log('❌ No Volumes/FreeNAS tickets found');
      }

      // Check total tickets created today
      console.log('📊 Recent tickets from Nagios alerts:\n');
      const [recentTickets] = await connection.query(`
        SELECT t.id, t.title, t.status, t.priority, t.created_at, u.email
        FROM tickets t
        JOIN users u ON t.requester_id = u.id
        WHERE u.email = 'nagiosalerts@apoyar.eu'
        ORDER BY t.id DESC
        LIMIT 20
      `);

      console.log(`✅ Total Nagios tickets: ${recentTickets.length}\n`);
      recentTickets.forEach(ticket => {
        const titlePreview = ticket.title.substring(0, 80);
        console.log(`   #${ticket.id} [${ticket.priority}] ${titlePreview}${ticket.title.length > 80 ? '...' : ''}`);
      });

      console.log('\n📈 Ticket Summary:');
      console.log(`   Total tickets from nagiosalerts@apoyar.eu: ${recentTickets.length}`);
      console.log(`   Volumes/FreeNAS related: ${volumeTickets.length}`);

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  }
}

checkCriticalTickets()
  .then(() => {
    console.log('\n✅ Check completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Check failed:', error.message);
    process.exit(1);
  });
