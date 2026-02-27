const Imap = require('imap');
const { simpleParser } = require('mailparser');

// Test script to check Gmail hidden screener folder
async function checkScreenerFolder() {
  const imap = new Imap({
    user: process.env.GMAIL_USER || 'kzinvogon@gmail.com',
    password: process.env.GMAIL_APP_PASSWORD,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  return new Promise((resolve, reject) => {
    imap.once('ready', () => {
      console.log('✅ Connected to Gmail IMAP');

      // Try [Gmail]/All Mail which contains all emails
      let folderToTry = '[Gmail]/All Mail';

      console.log(`\n🔍 Opening folder: ${folderToTry}`);

      imap.openBox(folderToTry, false, (err, box) => {
        if (err) {
          console.error(`❌ Error opening folder "${folderToTry}":`, err);
          imap.end();
          return reject(err);
        }

        console.log(`📬 Folder opened - Total messages: ${box.messages.total}`);

        // Search for emails from sustentus.com in the last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        console.log('\n🔍 Searching for emails from sustentus.com...');

        imap.search([['SINCE', sevenDaysAgo]], (err, results) => {
          if (err) {
            console.error('❌ Error searching:', err);
            imap.end();
            return reject(err);
          }

          if (!results || results.length === 0) {
            console.log('No emails found from last 7 days');
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

                  if (domain === 'sustentus.com') {
                    console.log(`\n🎯 FOUND sustentus.com email:`);
                    console.log(`--- Email #${seqno} ---`);
                    console.log(`From: ${fromEmail}`);
                    console.log(`Clean Email: ${cleanEmail}`);
                    console.log(`Domain: ${domain}`);
                    console.log(`Subject: ${parsed.subject}`);
                    console.log(`Date: ${parsed.date}`);
                    console.log(`Body preview: ${(parsed.text || '').substring(0, 100)}...`);

                    emails.push({ fromEmail, cleanEmail, domain, subject: parsed.subject, date: parsed.date });
                  }
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
            console.log('\n✅ Finished scanning folder');

            if (emails.length > 0) {
              console.log(`\n🎯 Total sustentus.com emails found: ${emails.length}`);
              emails.forEach(e => {
                console.log(`  - ${e.cleanEmail}: "${e.subject}" (${e.date})`);
              });
            } else {
              console.log('\n⚠️  No emails from sustentus.com found in All Mail');
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

checkScreenerFolder()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
