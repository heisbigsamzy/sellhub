// Email sending — via the official Gmail API, using OAuth2 (not a plain
// password login).
//
// What we tried before and why it wasn't reliable enough:
//   - Gmail SMTP with an "app password": works sometimes, then silently
//     fails other times. Google's security systems can flag a plain
//     password login from an unfamiliar server (like Render) as
//     suspicious and quietly block it, even with the right password.
//   - Resend / SMTP2GO (third-party email services): either require you
//     to own a domain, or depend on another company's service being up.
//
// The Gmail API is Google's own official, supported way for an app to send
// mail as a Gmail account. It authenticates with OAuth2 (the same system
// "Sign in with Google" uses) instead of a password, so it isn't subject to
// the same suspicious-login blocking, and it's a plain HTTPS call — no SMTP,
// no IPv6 connection issues like before.
//
// One-time setup (uses the same Google Cloud project already set up for
// "Sign in with Google" — no new accounts or services needed):
//   1. Google Cloud Console -> APIs & Services -> Library -> search
//      "Gmail API" -> Enable.
//   2. APIs & Services -> Credentials -> open the existing OAuth 2.0 Client
//      (the one used for Google Sign-In) -> copy its "Client secret".
//   3. Go to https://developers.google.com/oauthplayground
//        - Click the gear icon (top right) -> check "Use your own OAuth
//          credentials" -> paste the Client ID and Client secret from
//          step 2.
//        - In the left-hand list of APIs, find "Gmail API v1" and tick the
//          scope: https://www.googleapis.com/auth/gmail.send
//        - Click "Authorize APIs", sign in with the Gmail account you want
//          to send from, and approve.
//        - Click "Exchange authorization code for tokens" -> copy the
//          "Refresh token" shown.
//   4. In Render -> Environment, add:
//        GOOGLE_CLIENT_SECRET = the secret from step 2
//        GOOGLE_REFRESH_TOKEN = the refresh token from step 3
//        SENDER_EMAIL          = the Gmail address you authorized in step 3
//      (GOOGLE_CLIENT_ID is already set from the Google Sign-In setup.)

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const SENDER_EMAIL = process.env.SENDER_EMAIL;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !SENDER_EMAIL) {
  console.warn(
    '⚠️  Gmail API email sending is not fully configured. Emails will fail to send.\n' +
    '   Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN and\n' +
    '   SENDER_EMAIL set in Render -> Environment. See mailer.js for setup steps.'
  );
}

// Access tokens expire after about an hour. Cache the current one and only
// ask Google for a new one once it's actually expired.
let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status}): ${JSON.stringify(data)}`);
  }

  cachedAccessToken = data.access_token;
  // Refresh a little early (60s buffer) rather than cutting it exactly at expiry.
  cachedAccessTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedAccessToken;
}

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildRawEmail(toEmail, subject, html) {
  const message =
    `From: "SellHub" <${SENDER_EMAIL}>\r\n` +
    `To: ${toEmail}\r\n` +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset="UTF-8"\r\n\r\n` +
    html;
  return base64UrlEncode(message);
}

async function sendViaGmailApi(toEmail, subject, html) {
  const accessToken = await getAccessToken();

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: buildRawEmail(toEmail, subject, html) }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gmail API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function sendOTPEmail(toEmail, code) {
  return sendViaGmailApi(
    toEmail,
    'Your SellHub verification code',
    `<p>Your SellHub verification code is:</p><h1 style="letter-spacing:4px;">${code}</h1><p>This code expires in 10 minutes.</p>`
  );
}

function sendEmail(toEmail, subject, html) {
  return sendViaGmailApi(toEmail, subject, html);
}

module.exports = { sendOTPEmail, sendEmail };
