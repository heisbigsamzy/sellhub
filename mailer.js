// Email sending — via EmailJS (https://emailjs.com), reached over plain
// HTTPS. This connects to your own real Gmail account (via a simple
// "Connect with Google" click in their dashboard, not a manual OAuth setup)
// and sends through it — no business review process like some other
// services, since you're just authorizing your own existing Gmail account.
//
// One-time setup:
//   1. Create a free account at https://www.emailjs.com (just name + email,
//      no credit card, no business verification).
//   2. Dashboard -> Email Services -> Add New Service -> choose Gmail ->
//      click "Connect Account" -> sign in with heisbigsamzy@gmail.com and
//      approve. Copy the "Service ID" shown.
//   3. Dashboard -> Email Templates -> Create New Template. Set:
//        Subject: {{subject}}
//        Content: {{message}}
//      (just those two placeholders, nothing else needed). Save, then copy
//      the "Template ID".
//      Also set the template's "To email" field to {{to_email}}.
//   4. Dashboard -> Account -> General -> copy your "Public Key".
//      Dashboard -> Account -> Security -> copy your "Private Key", and
//      turn ON "Allow EmailJS API for non-browser applications" (this app
//      is a server, not a browser, so this must be switched on).
//   5. In Render -> Environment, add:
//        EMAILJS_SERVICE_ID  = Service ID from step 2
//        EMAILJS_TEMPLATE_ID = Template ID from step 3
//        EMAILJS_PUBLIC_KEY  = Public Key from step 4
//        EMAILJS_PRIVATE_KEY = Private Key from step 4

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY) {
  console.warn(
    '⚠️  EmailJS is not fully configured. Emails will fail to send.\n' +
    '   Needs EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY and\n' +
    '   EMAILJS_PRIVATE_KEY set in Render -> Environment. See mailer.js for setup steps.'
  );
}

async function sendViaEmailJs(toEmail, subject, html) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: toEmail,
        subject: subject,
        message: html,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`EmailJS API error (${res.status}): ${text}`);
  }
  return res.text();
}

function sendOTPEmail(toEmail, code) {
  return sendViaEmailJs(
    toEmail,
    'Your SellHub verification code',
    `<p>Your SellHub verification code is:</p><h1 style="letter-spacing:4px;">${code}</h1><p>This code expires in 10 minutes.</p>`
  );
}

function sendEmail(toEmail, subject, html) {
  return sendViaEmailJs(toEmail, subject, html);
}

module.exports = { sendOTPEmail, sendEmail };
