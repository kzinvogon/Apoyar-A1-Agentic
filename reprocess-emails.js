const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { getTenantConnection } = require('./config/database');
const { EmailProcessor } = require('./services/email-processor');
require('dotenv').config();

async function reprocessEmails(searchCriteria, limit = 10) {
  console.log('🔄 Email Reprocessing Tool\n');
  console.log('Search criteria:', searchCriteria);
  console.log('Limit:', limit, 'emails\n');

  const imap = new Imap({
    user: process.env.SMTP_EMAIL,
    password: process.env.SMTP_PASSWORD,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  return new Promise((resolve, reject) => {
    imap.once('ready', function() {
      imap.openBox('[Gmail]/All Mail', false, function(err, box) {
        if (err) {
          reject(err);
          return;
        }

        console.log('📧 Connected to Gmail\n');

        // Search for emails matching criteria (even if already read)
        imap.search(searchCriteria, function(err, results) {
          if (err) {
            reject(err);
            return;
          }

          if (!results || results.length === 0) {
            console.log('❌ No emails found matching criteria');
            imap.end();
            resolve([]);
            return;
          }

          console.log(`✅ Found ${results.length} emails matching criteria`);
          console.log(`📊 Processing latest ${Math.min(limit, results.length)} emails...\n`);

          // Take only the most recent N emails
          const emailsToProcess = results.slice(-limit);

          const fetch = imap.fetch(emailsToProcess, { bodies: '' });
          const processedEmails = [];
          let count = 0;

          fetch.on('message', function(msg, seqno) {
            count++;
            console.log(`[${count}/${emailsToProcess.length}] Processing email #${seqno}...`);

            msg.on('body', function(stream, info) {
              let buffer = '';

              stream.on('data', function(chunk) {
                buffer += chunk.toString('utf8');
              });

              stream.once('end', async function() {
                try {
                  const parsed = await simpleParser(buffer);

                  const emailData = {
                    from: parsed.from?.text || parsed.from?.value?.[0]?.address || '',
                    subject: parsed.subject || '(No Subject)',
                    body: parsed.text || parsed.html || '(No content)',
                    messageId: parsed.messageId || `msg-${Date.now()}`,
                    date: parsed.date
                  };

                  console.log(`   From: ${emailData.from}`);
                  console.log(`   Subject: ${emailData.subject.substring(0, 60)}...`);

                  // Process the email
                  const connection = await getTenantConnection('apoyar');
                  const processor = new EmailProcessor('apoyar');

                  try {
                    const result = await processor.processEmail(connection, emailData);
                    connection.release();

                    if (result.success) {
                      console.log(`   ✅ Ticket #${result.ticketId} created`);
                      processedEmails.push({
                        seqno,
                        ticketId: result.ticketId,
                        from: emailData.from,
                        subject: emailData.subject
                      });
                    } else {
                      console.log(`   ⚠️  ${result.reason || 'Failed'}`);
                    }
                  } catch (error) {
                    connection.release();
                    console.log(`   ❌ Error: ${error.message}`);
                  }

                  console.log();
                } catch (parseError) {
                  console.error(`   ❌ Parse error: ${parseError.message}`);
                }
              });
            });
          });

          fetch.once('error', function(err) {
            console.error('❌ Fetch error:', err);
            reject(err);
          });

          fetch.once('end', function() {
            console.log(`\n✅ Finished processing ${count} emails`);
            console.log(`📊 Created ${processedEmails.length} tickets\n`);

            if (processedEmails.length > 0) {
              console.log('🎫 Tickets created:');
              processedEmails.forEach(e => {
                console.log(`   #${e.ticketId} - ${e.subject}`);
              });
            }

            imap.end();
            resolve(processedEmails);
          });
        });
      });
    });

    imap.once('error', function(err) {
      console.error('❌ IMAP Error:', err.message);
      reject(err);
    });

    imap.once('end', function() {
      console.log('\n✅ Connection closed');
    });

    imap.connect();
  });
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
📧 Email Reprocessing Tool

Usage:
  node reprocess-emails.js <search-criteria> [limit]

Examples:
  # Reprocess last 5 emails from nagiosalerts@apoyar.eu
  node reprocess-emails.js "FROM nagiosalerts@apoyar.eu" 5

  # Reprocess last 10 emails with subject containing "CRITICAL"
  node reprocess-emails.js "SUBJECT CRITICAL" 10

  # Reprocess emails from specific date
  node reprocess-emails.js "SINCE 24-Nov-2025" 20

Common IMAP search criteria:
  FROM <email>      - From specific sender
  SUBJECT <text>    - Subject contains text
  SINCE <date>      - Since date (format: DD-Mon-YYYY)
  BEFORE <date>     - Before date
  UNSEEN            - Unread emails only
  ALL               - All emails
  `);
  process.exit(0);
}

const searchString = args[0];
const limit = args[1] ? parseInt(args[1]) : 10;

// Convert search string to IMAP search array
let searchCriteria;
if (searchString.startsWith('FROM ')) {
  searchCriteria = [['FROM', searchString.substring(5)]];
} else if (searchString.startsWith('SUBJECT ')) {
  searchCriteria = [['SUBJECT', searchString.substring(8)]];
} else if (searchString.startsWith('SINCE ')) {
  searchCriteria = [['SINCE', searchString.substring(6)]];
} else if (searchString === 'UNSEEN') {
  searchCriteria = ['UNSEEN'];
} else if (searchString === 'ALL') {
  searchCriteria = ['ALL'];
} else {
  searchCriteria = [['SUBJECT', searchString]];
}

reprocessEmails(searchCriteria, limit)
  .then(() => {
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Failed:', error.message);
    process.exit(1);
  });
