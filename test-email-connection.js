const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function testEmailConnection() {
  try {
    console.log('1. Logging in as tenant admin...');

    // Step 1: Login as admin user
    const loginResponse = await axios.post(`${BASE_URL}/api/auth/login`, {
      tenant: 'apoyar',
      username: 'admin',
      password: process.env.SMOKE_PASS || 'changeme'
    });

    if (!loginResponse.data.success) {
      console.error('Login failed:', loginResponse.data.message);
      return;
    }

    console.log('✅ Login successful');
    console.log('User info:', JSON.stringify(loginResponse.data.user, null, 2));

    const token = loginResponse.data.token;
    console.log('Token:', token.substring(0, 50) + '...');

    // Decode token to see what's in it
    const tokenParts = token.split('.');
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
    console.log('Token payload:', JSON.stringify(payload, null, 2));

    // Step 2: Call test connection endpoint
    console.log('\n2. Testing email connection...');

    const testResponse = await axios.post(
      `${BASE_URL}/api/email-ingest/apoyar/test-connection`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Test connection response:', JSON.stringify(testResponse.data, null, 2));

  } catch (error) {
    if (error.response) {
      console.error('❌ API Error:', error.response.status, error.response.statusText);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('❌ Error:', error.message);
    }
  }
}

testEmailConnection();
