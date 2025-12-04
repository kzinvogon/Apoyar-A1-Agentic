const Imap = require('imap');
require('dotenv').config();

const imap = new Imap({
  user: process.env.SMTP_EMAIL,
  password: process.env.SMTP_PASSWORD,
  host: 'imap.gmail.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
});

function openInbox(cb) {
  imap.openBox('[Gmail]/All Mail', false, cb);
}

imap.once('ready', function() {
  openInbox(function(err, box) {
    if (err) throw err;

    console.log('📧 Gmail Inbox Status:\n');
    console.log(`Total messages: ${box.messages.total}`);
    console.log(`New messages: ${box.messages.new}`);
    console.log(`Unseen messages: ${box.messages.unseen || 0}`);
    console.log();

    // Search for unseen emails
    imap.search(['UNSEEN'], function(err, results) {
      if (err) {
        console.error('Error searching:', err);
        imap.end();
        return;
      }

      console.log(`🔍 Unseen email IDs: ${results.length > 0 ? results.join(', ') : 'None'}`);
      console.log();

      // Search for emails from nagiosalerts@apoyar.eu
      imap.search([['FROM', 'nagiosalerts@apoyar.eu']], function(err, results) {
        if (err) {
          console.error('Error searching nagios emails:', err);
          imap.end();
          return;
        }

        console.log(`📨 Total emails from nagiosalerts@apoyar.eu: ${results.length}`);

        if (results.length > 0) {
          console.log(`   Latest 5 email IDs: ${results.slice(-5).join(', ')}`);

          // Check if any are unseen
          imap.search([['FROM', 'nagiosalerts@apoyar.eu'], 'UNSEEN'], function(err, unseenResults) {
            if (err) {
              console.error('Error:', err);
              imap.end();
              return;
            }

            console.log(`   Unseen from nagiosalerts@apoyar.eu: ${unseenResults.length}`);
            console.log();

            console.log('💡 Solution:');
            if (unseenResults.length === 0) {
              console.log('   All emails are marked as READ.');
              console.log('   New emails will be processed automatically.');
              console.log('   To reprocess old emails, mark them as UNREAD in Gmail.');
            } else {
              console.log('   There are unread emails that should be processed!');
              console.log('   Check email processor settings and logs.');
            }

            imap.end();
          });
        } else {
          console.log('   No emails found from this sender.');
          imap.end();
        }
      });
    });
  });
});

imap.once('error', function(err) {
  console.error('❌ IMAP Error:', err.message);
  process.exit(1);
});

imap.once('end', function() {
  console.log('\n✅ Connection closed');
});

imap.connect();
