const nodemailer = require('nodemailer');
const dns = require('dns');

// Render's network doesn't support outgoing IPv6, but Node tries IPv6 first
// by default. That makes every connection to Gmail's SMTP server fail with
// "ENETUNREACH" before it even reaches Gmail. Forcing IPv4 first fixes it.
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');

// Credentials come from environment variables already set in Render:
// GMAIL_ADDRESS and GMAIL_APP_PASSWORD.
const GMAIL_ADDRESS = process.env.GMAIL_ADDRESS;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

if (!GMAIL_ADDRESS || !GMAIL_APP_PASSWORD) {
  console.warn(
    '⚠️  GMAIL_ADDRESS / GMAIL_APP_PASSWORD are not set. Emails will fail to send.\n' +
    '   Create a .env file (see .env.example) and start the server with: npm start'
  );
}

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  family: 4, // force IPv4 — see note above about Render + IPv6
  auth: { user: GMAIL_ADDRESS, pass: GMAIL_APP_PASSWORD },
  connectionTimeout: 20000,
  greetingTimeout: 20000,
  socketTimeout: 20000,
});

// Gmail occasionally has a brief hiccup connecting from a cloud server even
// with everything configured correctly. Rather than fail the user's signup
// on the first blip, retry a couple of times with a short pause first.
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function sendWithRetry(mailOptions, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await transporter.sendMail(mailOptions);
    } catch (err) {
      lastErr = err;
      console.log(`Email send attempt ${i + 1} of ${attempts} failed:`, err.code || '', err.message);
      if (i < attempts - 1) await wait(1500 * (i + 1)); // 1.5s, then 3s
    }
  }
  throw lastErr;
}

function sendOTPEmail(toEmail, code) {
  return sendWithRetry({
    from: `"SellHub" <${GMAIL_ADDRESS}>`,
    to: toEmail,
    subject: 'Your SellHub verification code',
    html: `<p>Your SellHub verification code is:</p><h1 style="letter-spacing:4px;">${code}</h1><p>This code expires in 10 minutes.</p>`
  });
}

function sendEmail(toEmail, subject, html) {
  return sendWithRetry({
    from: `"SellHub" <${GMAIL_ADDRESS}>`,
    to: toEmail,
    subject,
    html
  });
}

module.exports = { sendOTPEmail, sendEmail };
