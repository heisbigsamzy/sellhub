// Email sending — via Mailjet (https://mailjet.com), reached over plain
// HTTPS. SMTP2GO's signup page kept erroring, so this uses Mailjet instead
// — same idea: a dedicated email service, verify one sender email address
// (no domain needed), then send to anyone.
//
// One-time setup:
//   1. Create a free account at https://mailjet.com
//   2. Go to My Account -> Sender addresses & domains -> Add a sender
//      address -> enter heisbigsamzy@gmail.com -> Mailjet emails you a
//      confirmation link, click it.
//   3. Go to Account Settings -> API Key Management -> copy your
//      "API Key" and "Secret Key".
//   4. In Render -> Environment, add:
//        MAILJET_API_KEY    = the API Key from step 3
//        MAILJET_SECRET_KEY = the Secret Key from step 3
//        SENDER_EMAIL       = the exact address verified in step 2

const MAILJET_API_KEY = process.env.MAILJET_API_KEY;
const MAILJET_SECRET_KEY = process.env.MAILJET_SECRET_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL;

if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY || !SENDER_EMAIL) {
  console.warn(
    '⚠️  MAILJET_API_KEY / MAILJET_SECRET_KEY / SENDER_EMAIL are not set. Emails will fail to send.\n' +
    '   Sign up free at https://mailjet.com, verify a sender email address,\n' +
    '   create an API key, and add all three to Render -> Environment.'
  );
}

async function sendViaMailjet(toEmail, subject, html) {
  const basicAuth = Buffer.from(`${MAILJET_API_KEY}:${MAILJET_SECRET_KEY}`).toString('base64');

  const res = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: JSON.stringify({
      Messages: [
        {
          From: { Email: SENDER_EMAIL, Name: 'SellHub' },
          To: [{ Email: toEmail }],
          Subject: subject,
          HTMLPart: html,
        },
      ],
    }),
  });

  const data = await res.json();
  const failed = !res.ok || (data.Messages && data.Messages[0] && data.Messages[0].Status !== 'success');
  if (failed) {
    throw new Error(`Mailjet API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function sendOTPEmail(toEmail, code) {
  return sendViaMailjet(
    toEmail,
    'Your SellHub verification code',
    `<p>Your SellHub verification code is:</p><h1 style="letter-spacing:4px;">${code}</h1><p>This code expires in 10 minutes.</p>`
  );
}

function sendEmail(toEmail, subject, html) {
  return sendViaMailjet(toEmail, subject, html);
}

module.exports = { sendOTPEmail, sendEmail };
