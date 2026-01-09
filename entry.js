#!/usr/bin/env node
/**
 * Entry point that routes to the correct app based on APP_MODE
 */

if (process.env.APP_MODE === 'teams') {
  console.log('🤖 Starting Teams Connector...');
  require('./teams-connector/server.js');
} else {
  console.log('🚀 Starting ServiFlow Main App...');
  require('./server.js');
}
