const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (!GOOGLE_CLIENT_ID) {
  console.warn(
    '⚠️  GOOGLE_CLIENT_ID is not set. "Sign in with Google" will not work until you add it to .env.\n' +
    '   See the setup steps for getting a Client ID from Google Cloud Console.'
  );
}

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// Verifies the ID token Google's Sign-In button hands back to the browser.
// Throws if the token is invalid, expired, or was issued for a different
// Client ID — never trust a token without this check.
async function verifyGoogleToken(idToken) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  // payload.email_verified is Google's own confirmation that this address
  // is real and reachable — worth checking since we skip our own OTP step
  // entirely for Google sign-ins.
  if (!payload.email_verified) {
    throw new Error('Google account email is not verified.');
  }
  return {
    email: payload.email,
    fullName: payload.name || payload.email.split('@')[0],
  };
}

module.exports = { verifyGoogleToken };