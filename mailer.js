// Email sending — via EmailJS (https://emailjs.com), reached over plain
// HTTPS. This connects to your own real Gmail account (via a simple
// "Connect with Google" click in their dashboard) and sends through it —
// no business review process, since you're just authorizing your own
// existing Gmail account.
//
// Uses EmailJS's built-in "One-Time Password" template, which expects
// these exact variable names in its fields:
//   To Email field:  {{email}}
//   Content:         {{passcode}}  and  {{time}}
//
// One-time setup:
//   1. Create a free account at https://www.emailjs.com
//   2. Email Services -> Add New Service -> Gmail -> Connect Account ->
//      sign in with heisbigsamzy@gmail.com. Copy the "Service ID".
//   3. Email Templates -> use/create the "One-Time Password" template.
//      Replace "[Company Name]" with "SellHub" wherever it appears. Leave
//      {{email}}, {{passcode}}, {{time}} exactly as they are. Save, copy
//      the "Template ID".
//   4. Account -> General -> copy "Public Key".
//      Account -> Security -> copy "Private Key", and turn ON
//      "Allow EmailJS API for non-browser applications".
//   5. In Render -> Environment, add:
//        EMAILJS_SERVICE_ID  = Service ID from step 2
//        EMAILJS_TEMPLATE_ID = Template ID from step 3
//        EMAILJS_PUBLIC_KEY  = Public Key from step 4
//        EMAILJS_PRIVATE_KEY = Private Key from step 4

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

if (!process.env.RESEND_API_KEY && (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY)) {
  console.warn(
    '⚠️  EmailJS is not fully configured. Emails will fail to send.\n' +
    '   Needs EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY and\n' +
    '   EMAILJS_PRIVATE_KEY set in Render -> Environment. See mailer.js for setup steps.'
  );
}

async function callEmailJs(templateParams) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: templateParams,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`EmailJS API error (${res.status}): ${text}`);
  }
  return res.text();
}

// ---------- RESEND (preferred once a domain is verified) ----------
// Set RESEND_API_KEY and RESEND_FROM (e.g. "SellHub <no-reply@yourdomain.com>")
// in Render -> Environment. While RESEND_API_KEY is missing, everything keeps
// going through EmailJS exactly as before.
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const RESEND_FROM = (process.env.RESEND_FROM || '').trim();
const resendEnabled = !!(RESEND_API_KEY && RESEND_FROM);
if (RESEND_API_KEY && !RESEND_FROM) {
  console.warn('⚠️  RESEND_API_KEY is set but RESEND_FROM is not — using EmailJS instead.');
}

async function callResend(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend API error (${res.status}): ${text}`);
  }
  return res.text();
}

function sendOTPEmail(toEmail, code) {
  if (resendEnabled) {
    return callResend(toEmail, `Your SellHub verification code: ${code}`,
      `<div style="font-family:Arial,sans-serif;max-width:420px">` +
      `<h2 style="margin:0 0 12px">SellHub</h2>` +
      `<p>Your verification code is:</p>` +
      `<p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:8px 0">${code}</p>` +
      `<p style="color:#666">It expires in 10 minutes. If you didn't request it, ignore this email.</p></div>`);
  }
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const timeString = expiresAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return callEmailJs({
    email: toEmail,
    passcode: code,
    time: timeString,
  });
}

// Other parts of the app send a free-form subject + HTML body (order
// updates, etc.) rather than a short code. The OTP template doesn't have a
// field for that, so we fit it into the "passcode" slot for now — it'll
// look plain rather than styled, but it will arrive. Worth a dedicated
// template later if these emails need to look nicer.
function sendEmail(toEmail, subject, html) {
  if (resendEnabled) return callResend(toEmail, subject, html);
  const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return callEmailJs({
    email: toEmail,
    passcode: `${subject}: ${plainText}`,
    time: '',
  });
}

module.exports = { sendOTPEmail, sendEmail };
