const fetch = require('node-fetch');

async function testAIEndpoint() {
  try {
    // First, login to get a token
    console.log('1️⃣  Logging in...');
    const loginResponse = await fetch('http://localhost:3000/api/auth/tenant/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'password123',
        tenant_code: 'apoyar'
      })
    });

    const loginData = await loginResponse.json();
    console.log('Login response:', loginData);

    if (!loginData.token) {
      console.error('❌ No token received');
      return;
    }

    const token = loginData.token;
    console.log('✅ Token received:', token.substring(0, 20) + '...');

    // Now test the AI insights endpoint
    console.log('\n2️⃣  Testing AI insights endpoint...');
    const aiResponse = await fetch('http://localhost:3000/api/analytics/apoyar/ai-insights?period=7', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    console.log('Response status:', aiResponse.status);

    const aiData = await aiResponse.json();
    console.log('\n3️⃣  AI Insights Response:');
    console.log(JSON.stringify(aiData, null, 2));

    if (aiData.success) {
      console.log('\n✅ AI Insights endpoint working!');
      console.log(`📊 Insights: ${aiData.data.insights?.length || 0}`);
      console.log(`📈 Tickets analyzed: ${aiData.data.performance?.total_analyzed || 0}`);
    } else {
      console.log('\n❌ AI Insights endpoint returned error');
    }

  } catch (error) {
    console.error('❌ Error testing endpoint:', error.message);
    console.error(error.stack);
  }
}

testAIEndpoint();
