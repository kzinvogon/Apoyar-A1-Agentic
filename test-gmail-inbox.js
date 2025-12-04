const Imap = require('imap');
const { simpleParser } = require('mailparser');

// Test script to check Gmail inbox for emails from sustentus.com
async function testGmailInbox() {
  const imap = new Imap({
    user: 'kzinvogon@gmail.com',
    password: 'utgcyuskajsfmhvf',
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  return new Promise((resolve, reject) => {
    imap.once('ready', () => {
      console.log('✅ Connected to Gmail IMAP');

      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          console.error('❌ Error opening INBOX:', err);
          imap.end();
          return reject(err);
        }

        console.log(`📬 Total messages in inbox: ${box.messages.total}`);
        console.log(`📧 Unread messages: ${box.messages.new}`);

        // Search for ALL emails from the last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        console.log('\n🔍 Searching for all emails from last 7 days...');

        imap.search([['SINCE', sevenDaysAgo]], (err, results) => {
          if (err) {
            console.error('❌ Error searching:', err);
            imap.end();
            return reject(err);
          }

          if (!results || results.length === 0) {
            console.log('No emails found in last 7 days');
            imap.end();
            return resolve([]);
          }

          console.log(`📨 Found ${results.length} email(s) from last 7 days\n`);

          const emails = [];
          const fetch = imap.fetch(results, { bodies: '', markSeen: false });

          fetch.on('message', (msg, seqno) => {
            msg.on('body', (stream, info) => {
              let buffer = '';
              stream.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
              });

              stream.once('end', async () => {
                try {
                  const parsed = await simpleParser(buffer);

                  const fromEmail = parsed.from?.text || parsed.from?.value?.[0]?.address || '';
                  const emailMatch = fromEmail.match(/<(.+?)>/) || fromEmail.match(/([^\s]+@[^\s]+)/);
                  const cleanEmail = emailMatch ? emailMatch[1] : fromEmail;
                  const domain = cleanEmail.split('@')[1];

                  console.log(`\n--- Email #${seqno} ---`);
                  console.log(`From: ${fromEmail}`);
                  console.log(`Clean Email: ${cleanEmail}`);
                  console.log(`Domain: ${domain}`);
                  console.log(`Subject: ${parsed.subject}`);
                  console.log(`Date: ${parsed.date}`);
                  console.log(`Is sustentus.com: ${domain === 'sustentus.com' ? '✅ YES' : '❌ NO'}`);

                  emails.push({ fromEmail, cleanEmail, domain, subject: parsed.subject, date: parsed.date });
                } catch (parseError) {
                  console.error(`Error parsing email #${seqno}:`, parseError);
                }
              });
            });
          });

          fetch.once('error', (err) => {
            console.error('❌ Fetch error:', err);
            reject(err);
          });

          fetch.once('end', () => {
            console.log('\n✅ Finished scanning inbox');

            // Filter for sustentus.com emails
            const sustentusEmails = emails.filter(e => e.domain === 'sustentus.com');
            if (sustentusEmails.length > 0) {
              console.log(`\n🎯 Found ${sustentusEmails.length} email(s) from sustentus.com:`);
              sustentusEmails.forEach(e => {
                console.log(`  - ${e.cleanEmail}: "${e.subject}" (${e.date})`);
              });
            } else {
              console.log('\n⚠️  No emails from sustentus.com found');
            }

            imap.end();
            resolve(emails);
          });
        });
      });
    });

    imap.once('error', (err) => {
      console.error('❌ IMAP connection error:', err.message);
      reject(err);
    });

    imap.once('end', () => {
      console.log('\n🔌 Disconnected from Gmail');
    });

    imap.connect();
  });
}

testGmailInbox()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
