const nodemailer = require('nodemailer');
const dns = require('dns');

// Render's network has no outbound IPv6 route, so any connection attempt
// over IPv6 fails instantly with ENETUNREACH. Node/nodemailer sometimes
// still pick the IPv6 address for smtp.gmail.com despite setting
// family:4/ipv4first (that setting isn't always honored depending on the
// Node version's internal DNS resolution path). To make this unambiguous,
// we resolve the IPv4 address ourselves and connect to that literal IP,
// while keeping the real hostname for TLS certificate validation (SNI).

const GMAIL_ADDRESS = process.env.GMAIL_ADDRESS;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

if (!GMAIL_ADDRESS || !GMAIL_APP_PASSWORD) {
  console.warn(
    '⚠️  GMAIL_ADDRESS / GMAIL_APP_PASSWORD are not set. Emails will fail to send.\n' +
    '   Create a .env file (see .env.example) and start the server with: npm start'
  );
}

function resolveIPv4(hostname) {
  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses || !addresses.length) return reject(err || new Error('No IPv4 address found'));
      resolve(addresses[0]);
    });
  });
}

// Cache the resolved IP for a few minutes so we're not doing a fresh DNS
// lookup on every single email.
let cachedIp = null;
let cachedIpAt = 0;
const IP_CACHE_MS = 5 * 60 * 1000;

async function getTransporter() {
  const now = Date.now();
  if (!cachedIp || now - cachedIpAt > IP_CACHE_MS) {
    cachedIp = await resolveIPv4('smtp.gmail.com');
    cachedIpAt = now;
  }
  return nodemailer.createTransport({
    host: cachedIp,
    port: 465,
    secure: true,
    tls: { servername: 'smtp.gmail.com' }, // keep real hostname for TLS/SNI + cert check
    auth: { user: GMAIL_ADDRESS, pass: GMAIL_APP_PASSWORD },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000,
  });
}

// Gmail occasionally has a brief hiccup connecting from a cloud server even
// with everything configured correctly. Rather than fail the user's signup
// on the first blip, retry a couple of times with a short pause first.
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function sendWithRetry(mailOptions, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const transporter = await getTransporter();
      return await transporter.sendMail(mailOptions);
    } catch (err) {
      lastErr = err;
      console.log(`Email send attempt ${i + 1} of ${attempts} failed:`, err.code || '', err.message);
      cachedIp = null; // force a fresh DNS lookup on retry, in case the cached IP is bad
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
