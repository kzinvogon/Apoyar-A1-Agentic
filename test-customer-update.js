const http = require('http');

async function makeRequest(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` })
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test() {
  console.log('🧪 Testing Customer Update Issue\n');

  // 1. Login
  console.log('1️⃣  Logging in...');
  const loginRes = await makeRequest('POST', '/api/auth/tenant/login', null, {
    username: 'admin',
    password: 'password123',
    tenant_code: 'apoyar'
  });

  if (!loginRes.data.success) {
    console.error('❌ Login failed:', loginRes.data.message);
    return;
  }

  const token = loginRes.data.token;
  console.log('✅ Login successful\n');

  // 2. Get all customers to find one to update
  console.log('2️⃣  Fetching customers...');
  const customersRes = await makeRequest('GET', '/api/customers', token);

  if (!customersRes.data.success || customersRes.data.customers.length === 0) {
    console.error('❌ No customers found');
    return;
  }

  const customer = customersRes.data.customers[0];
  console.log(`✅ Found customer: ${customer.full_name || customer.username} (ID: ${customer.id})`);
  console.log(`   Current domain: ${customer.company_domain || 'N/A'}`);
  console.log(`   Current SLA: ${customer.sla_level || 'N/A'}`);
  console.log();

  // 3. Try to update the customer
  console.log('3️⃣  Attempting update...');
  console.log('   Updating domain to: test-update.com');
  console.log('   Updating SLA to: premium');

  const updateData = {
    company_domain: 'test-update.com',
    sla_level: 'premium',
    company_name: customer.company_name || 'Updated Company'
  };

  console.log('   Request body:', JSON.stringify(updateData, null, 2));

  const updateRes = await makeRequest('PUT', `/api/customers/${customer.id}`, token, updateData);

  console.log(`   Response status: ${updateRes.status}`);
  console.log('   Response data:', JSON.stringify(updateRes.data, null, 2));

  if (updateRes.data.success) {
    console.log('✅ Update successful!\n');

    // 4. Verify the update
    console.log('4️⃣  Verifying update...');
    const verifyRes = await makeRequest('GET', `/api/customers/${customer.id}`, token);

    if (verifyRes.data.success) {
      const updated = verifyRes.data.customer;
      console.log('✅ Verification results:');
      console.log(`   Domain: ${updated.company_domain}`);
      console.log(`   SLA: ${updated.sla_level}`);
      console.log(`   Company: ${updated.company_name}`);

      if (updated.company_domain === 'test-update.com' && updated.sla_level === 'premium') {
        console.log('\n✅ UPDATE WORKING CORRECTLY!');
      } else {
        console.log('\n❌ UPDATE NOT PERSISTED!');
        console.log('Expected domain: test-update.com, Got:', updated.company_domain);
        console.log('Expected SLA: premium, Got:', updated.sla_level);
      }
    }
  } else {
    console.error('❌ Update failed:', updateRes.data.message);
  }
}

test().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
