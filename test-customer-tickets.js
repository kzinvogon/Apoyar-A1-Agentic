const jwt = require('jsonwebtoken');

// Create a token for customer user (ID 3)
const token = jwt.sign(
  { userId: 3, role: 'customer', username: 'customer', tenant: 'apoyar' },
  'your-secret-key-change-in-production'
);

// Make the API request
const fetch = require('node-fetch');

fetch('http://localhost:3000/api/tickets/apoyar', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
})
.then(res => res.json())
.then(data => {
  if (data.success) {
    console.log(`✅ Found ${data.tickets.length} tickets for customer user:`);
    data.tickets.forEach(t => {
      console.log(`   - Ticket #${t.id}: ${t.title} (requester_id: ${t.requester_id})`);
    });
  } else {
    console.log('❌ Failed:', data.message);
  }
})
.catch(err => {
  console.error('❌ Error:', err.message);
});
