const https = require('http');

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

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test() {
  console.log('🧪 Testing Customer Management API\n');

  // 1. Login
  console.log('1️⃣  Logging in as admin...');
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

  // 2. Get all customers
  console.log('2️⃣  Fetching all customers...');
  const customersRes = await makeRequest('GET', '/api/customers', token);

  if (!customersRes.data.success) {
    console.error('❌ Failed to fetch customers:', customersRes.data.message);
    return;
  }

  console.log(`✅ Found ${customersRes.data.customers.length} customers`);
  customersRes.data.customers.forEach(c => {
    console.log(`   - ${c.full_name || c.username} (${c.company_name || 'N/A'}) - Domain: ${c.company_domain || 'N/A'}`);
  });
  console.log();

  // 3. Create new customer
  console.log('3️⃣  Creating new customer...');
  const newCustomer = {
    username: 'test_customer',
    email: 'test@testcompany.com',
    full_name: 'Test Customer',
    company_name: 'Test Company Inc',
    company_domain: 'testcompany.com',
    contact_phone: '+1-555-0199',
    address: '123 Test Street, Test City',
    sla_level: 'premium'
  };

  const createRes = await makeRequest('POST', '/api/customers', token, newCustomer);

  if (!createRes.data.success) {
    console.error('❌ Failed to create customer:', createRes.data.message);
  } else {
    console.log('✅ Customer created successfully!');
    console.log(`   Username: ${createRes.data.customer.username}`);
    console.log(`   Temp Password: ${createRes.data.tempPassword}`);
    console.log(`   Domain: ${createRes.data.customer.company_domain}`);
    console.log(`   SLA Level: ${createRes.data.customer.sla_level}`);
    console.log();

    // 4. Update customer
    console.log('4️⃣  Updating customer domain...');
    const updateRes = await makeRequest('PUT', `/api/customers/${createRes.data.customer.id}`, token, {
      company_domain: 'newtestcompany.com',
      sla_level: 'enterprise'
    });

    if (!updateRes.data.success) {
      console.error('❌ Failed to update customer:', updateRes.data.message);
    } else {
      console.log('✅ Customer updated successfully!');
      console.log(`   New Domain: ${updateRes.data.customer.company_domain}`);
      console.log(`   New SLA Level: ${updateRes.data.customer.sla_level}`);
      console.log();
    }

    // 5. Get single customer
    console.log('5️⃣  Fetching single customer...');
    const singleRes = await makeRequest('GET', `/api/customers/${createRes.data.customer.id}`, token);

    if (!singleRes.data.success) {
      console.error('❌ Failed to fetch customer:', singleRes.data.message);
    } else {
      const c = singleRes.data.customer;
      console.log('✅ Customer details:');
      console.log(`   Name: ${c.full_name}`);
      console.log(`   Email: ${c.email}`);
      console.log(`   Company: ${c.company_name}`);
      console.log(`   Domain: ${c.company_domain}`);
      console.log(`   SLA: ${c.sla_level}`);
      console.log();
    }

    // 6. Delete customer
    console.log('6️⃣  Deactivating customer...');
    const deleteRes = await makeRequest('DELETE', `/api/customers/${createRes.data.customer.id}`, token);

    if (!deleteRes.data.success) {
      console.error('❌ Failed to delete customer:', deleteRes.data.message);
    } else {
      console.log('✅ Customer deactivated successfully\n');
    }
  }

  console.log('✅ All tests completed!\n');
}

test().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
