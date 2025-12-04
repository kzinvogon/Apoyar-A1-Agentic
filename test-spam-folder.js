const Imap = require('imap');
const { simpleParser } = require('mailparser');

// Test script to check Gmail Spam folder
async function checkSpamFolder() {
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

      // Try to open the Spam folder
      imap.openBox('[Gmail]/Spam', false, (err, box) => {
        if (err) {
          console.error('❌ Error opening Spam folder:', err);
          console.log('\n📁 Listing all available folders...');

          // If Spam doesn't work, list all folders
          imap.getBoxes((err, boxes) => {
            if (err) {
              console.error('Error listing boxes:', err);
            } else {
              console.log('\nAvailable folders:');
              console.log(JSON.stringify(boxes, null, 2));
            }
            imap.end();
            return reject(new Error('Could not open Spam folder'));
          });
          return;
        }

        console.log(`📬 Spam folder - Total messages: ${box.messages.total}`);

        if (box.messages.total === 0) {
          console.log('No messages in Spam folder');
          imap.end();
          return resolve([]);
        }

        // Search for all emails from sustentus.com
        console.log('\n🔍 Searching for emails from sustentus.com in Spam...');

        imap.search(['ALL'], (err, results) => {
          if (err) {
            console.error('❌ Error searching:', err);
            imap.end();
            return reject(err);
          }

          if (!results || results.length === 0) {
            console.log('No emails found in Spam');
            imap.end();
            return resolve([]);
          }

          console.log(`📨 Found ${results.length} email(s) in Spam folder\n`);

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

                  console.log(`--- Email #${seqno} ---`);
                  console.log(`From: ${fromEmail}`);
                  console.log(`Domain: ${domain}`);
                  console.log(`Subject: ${parsed.subject}`);
                  console.log(`Date: ${parsed.date}`);
                  console.log(`Is sustentus.com: ${domain === 'sustentus.com' ? '✅ YES' : '❌ NO'}\n`);

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
            console.log('✅ Finished scanning Spam folder');

            const sustentusEmails = emails.filter(e => e.domain === 'sustentus.com');
            if (sustentusEmails.length > 0) {
              console.log(`\n🎯 Found ${sustentusEmails.length} email(s) from sustentus.com in SPAM:`);
              sustentusEmails.forEach(e => {
                console.log(`  - ${e.cleanEmail}: "${e.subject}" (${e.date})`);
              });
            } else {
              console.log('\n⚠️  No emails from sustentus.com in Spam folder');
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

checkSpamFolder()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
