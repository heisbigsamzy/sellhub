const nodemailer = require('nodemailer');

// Credentials now come from environment variables — never hardcode them here.
// Create a .env file (see .env.example) with GMAIL_ADDRESS and GMAIL_APP_PASSWORD.
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
