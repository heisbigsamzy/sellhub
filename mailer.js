const nodemailer = require('nodemailer');
const dns = require('dns');

// Render's network doesn't support outgoing IPv6, but Node tries IPv6 first
// by default. That makes every connection to Gmail's SMTP server fail with
// "ENETUNREACH" before it even reaches Gmail. Forcing IPv4 first fixes it.
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');

// Credentials come from environment variables — never hardcode them here.
// Set these in Render -> Environment: GMAIL_ADDRESS and GMAIL_APP_PASSWORD
// (the app password is a 16-character code from your Google Account's
// "App passwords" page — not your normal Gmail password).
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

function sendOTPEmail(toEmail, code) {
  return transporter.sendMail({
    from: `"SellHub" <${GMAIL_ADDRESS}>`,
    to: toEmail,
    subject: 'Your SellHub verification code',
    html: `<p>Your SellHub verification code is:</p><h1 style="letter-spacing:4px;">${code}</h1><p>This code expires in 10 minutes.</p>`
  });
}

function sendEmail(toEmail, subject, html) {
  return transporter.sendMail({
    from: `"SellHub" <${GMAIL_ADDRESS}>`,
    to: toEmail,
    subject,
    html
  });
}

module.exports = { sendOTPEmail, sendEmail };
