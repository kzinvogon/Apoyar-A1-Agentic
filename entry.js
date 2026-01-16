#!/usr/bin/env node
/**
 * Entry point that routes to the correct app based on APP_MODE
 */

console.log('=== entry.js executing ===');
console.log('APP_MODE:', process.env.APP_MODE);

if (process.env.APP_MODE === 'teams') {
  console.log('🤖 Starting Teams Connector...');
  require('./teams-connector/server.js');
} else if (process.env.APP_MODE === 'slack') {
  console.log('💬 Starting Slack Connector...');
  require('./slack-connector/server.js');
} else {
  console.log('🚀 Starting ServiFlow Main App...');
  require('./server.js');
}
