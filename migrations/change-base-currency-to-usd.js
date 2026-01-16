/**
 * Migration: Change Base Currency from AUD to USD
 * Updates exchange rates relative to USD
 *
 * Run with: node migrations/change-base-currency-to-usd.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || 'railway'
};

async function runMigration() {
  console.log('Changing base currency from AUD to USD...');
  console.log(`Connecting to database: ${config.database}`);

  const connection = await mysql.createConnection(config);

  try {
    // First, remove base status from AUD
    await connection.query(`
      UPDATE currencies SET is_base = FALSE WHERE code = 'AUD'
    `);
    console.log('✅ Removed base status from AUD');

    // Set USD as base currency
    await connection.query(`
      UPDATE currencies SET is_base = TRUE, exchange_rate = 1.0000 WHERE code = 'USD'
    `);
    console.log('✅ Set USD as base currency');

    // Update exchange rates relative to USD (approximate rates as of early 2025)
    // These are "1 USD = X of currency" rates
    const rates = [
      ['AUD', 1.5400, 1.00],   // 1 USD = 1.54 AUD
      ['GBP', 0.7900, 1.00],   // 1 USD = 0.79 GBP
      ['EUR', 0.9200, 1.00],   // 1 USD = 0.92 EUR
      ['INR', 83.0000, 1.00],  // 1 USD = 83 INR (round to nearest rupee)
      ['NZD', 1.6900, 1.00],   // 1 USD = 1.69 NZD
      ['CAD', 1.3500, 1.00],   // 1 USD = 1.35 CAD
      ['SGD', 1.3400, 1.00]    // 1 USD = 1.34 SGD
    ];

    for (const [code, rate, roundTo] of rates) {
      await connection.query(`
        UPDATE currencies
        SET exchange_rate = ?, last_rate_update = NOW()
        WHERE code = ?
      `, [rate, code]);
      console.log(`✅ Updated ${code}: 1 USD = ${rate} ${code}`);
    }

    // Update INR rounding to be sensible for the new rates
    await connection.query(`
      UPDATE currencies SET round_to = 1.00 WHERE code = 'INR'
    `);
    console.log('✅ Updated INR rounding to 1.00');

    // Update display order to put USD first
    await connection.query(`
      UPDATE currencies SET display_order = 1 WHERE code = 'USD'
    `);
    await connection.query(`
      UPDATE currencies SET display_order = 2 WHERE code = 'AUD'
    `);
    console.log('✅ Updated display order (USD first)');

    console.log('\n✅ Migration completed successfully!');
    console.log('\nBase currency is now USD ($)');
    console.log('All prices in the system should be entered in USD');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
