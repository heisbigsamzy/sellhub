// Email sending — via Resend (https://resend.com), a dedicated email-sending
// service reached over plain HTTPS.
//
// We used to send through Gmail's SMTP server directly. That kept failing on
// Render with "ENETUNREACH" because Render's network can't make outgoing
// SMTP connections over IPv6, which is what Node tries first. Rather than
// keep patching around Gmail (which isn't built to send mail from a server
// anyway — it's built for a person checking their own inbox), this switches
// to a real transactional email API. It's a normal HTTPS request, the same
// kind this app already makes successfully to Paystack, so there's no SMTP/
// IPv6 pitfall to hit.
//
// Setup (one-time):
//   1. Create a free account at https://resend.com
//   2. Create an API key (Dashboard -> API Keys -> Create API Key)
//   3. In Render -> Environment, add RESEND_API_KEY with that key
//
// Until you verify your own domain with Resend, emails are sent from
// "SellHub <onboarding@resend.dev>" — Resend's shared sending address made
// for exactly this (works immediately, no domain setup, no verification
// wait). You can switch FROM_EMAIL below once you verify your own domain.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'SellHub <onboarding@resend.dev>';

if (!RESEND_API_KEY) {
  console.warn(
    '⚠️  RESEND_API_KEY is not set. Emails will fail to send.\n' +
    '   Sign up free at https://resend.com, create an API key, and add it\n' +
    '   to Render -> Environment as RESEND_API_KEY.'
  );
}

async function sendViaResend(toEmail, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [toEmail],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch (e) { /* ignore */ }
    throw new Error(`Resend API error (${res.status}): ${detail || res.statusText}`);
  }

  return res.json();
}

function sendOTPEmail(toEmail, code) {
  return sendViaResend(
    toEmail,
    'Your SellHub verification code',
    `<p>Your SellHub verification code is:</p><h1 style="letter-spacing:4px;">${code}</h1><p>This code expires in 10 minutes.</p>`
  );
}

function sendEmail(toEmail, subject, html) {
  return sendViaResend(toEmail, subject, html);
}

module.exports = { sendOTPEmail, sendEmail };
