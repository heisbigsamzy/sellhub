// Email sending — via SMTP2GO (https://smtp2go.com), a dedicated
// transactional email service reached over plain HTTPS.
//
// We tried sending through a personal Gmail account before. Gmail's SMTP
// server isn't built for a live website to send mail from 24/7 — it works
// sometimes and then silently stops (connection blocks, intermittent
// "suspicious sign-in" flags on cloud servers, daily sending caps meant for
// a person, not a business). We also tried Resend, a proper email API, but
// its free tier only allows sending to your own address until you verify a
// full domain — not workable without owning a domain.
//
// SMTP2GO's free plan lets you verify a SINGLE EMAIL ADDRESS (no domain
// needed) and then send to any recipient, with 1,000 emails/month free,
// forever. It's a plain HTTPS POST, same as this app's existing calls to
// Paystack, so there's no SMTP/IPv6 connection issue like before.
//
// One-time setup:
//   1. Create a free account at https://www.smtp2go.com
//   2. Go to Sending -> Verified Senders -> Single Sender Emails, and
//      verify an email address you own (e.g. your Gmail address) — SMTP2GO
//      emails you a confirmation link, click it.
//   3. Go to Settings -> API Keys -> create a new key.
//   4. In Render -> Environment, add:
//        SMTP2GO_API_KEY   = the key from step 3
//        SENDER_EMAIL      = the exact email address you verified in step 2

const SMTP2GO_API_KEY = process.env.SMTP2GO_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL;

if (!SMTP2GO_API_KEY || !SENDER_EMAIL) {
  console.warn(
    '⚠️  SMTP2GO_API_KEY / SENDER_EMAIL are not set. Emails will fail to send.\n' +
    '   Sign up free at https://www.smtp2go.com, verify a single sender email,\n' +
    '   create an API key, and add both to Render -> Environment.'
  );
}

async function sendViaSmtp2go(toEmail, subject, html) {
  const res = await fetch('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'accept': 'application/json',
      'X-Smtp2go-Api-Key': SMTP2GO_API_KEY,
    },
    body: JSON.stringify({
      api_key: SMTP2GO_API_KEY,
      sender: `SellHub <${SENDER_EMAIL}>`,
      to: [toEmail],
      subject,
      html_body: html,
    }),
  });

  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }

  const failed = !res.ok || (data && data.data && data.data.failed > 0);
  if (failed) {
    throw new Error(`SMTP2GO API error (${res.status}): ${JSON.stringify(data)}`);
  }

  return data;
}

function sendOTPEmail(toEmail, code) {
  return sendViaSmtp2go(
    toEmail,
    'Your SellHub verification code',
    `<p>Your SellHub verification code is:</p><h1 style="letter-spacing:4px;">${code}</h1><p>This code expires in 10 minutes.</p>`
  );
}

function sendEmail(toEmail, subject, html) {
  return sendViaSmtp2go(toEmail, subject, html);
}

module.exports = { sendOTPEmail, sendEmail };
