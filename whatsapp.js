// whatsapp.js — sends WhatsApp notifications through Green API.
// Green API is a QR-code-paired WhatsApp provider: no phone/SMS verification
// needed to set up (unlike Twilio). Scan a QR code once from your console at
// green-api.com to link the SellHub WhatsApp number, then put the instance's
// idInstance / apiTokenInstance into .env.
//
// This module exports the exact same function signature as before
// (sendWhatsApp(rawPhone, message)), so nothing in server.js needs to change.

const GREENAPI_ID_INSTANCE = process.env.GREENAPI_ID_INSTANCE || '';
const GREENAPI_API_TOKEN = process.env.GREENAPI_API_TOKEN || '';
const GREENAPI_URL = (process.env.GREENAPI_URL || 'https://api.greenapi.com').replace(/\/+$/, '');

const whatsappEnabled = !!(GREENAPI_ID_INSTANCE && GREENAPI_API_TOKEN);

if (!whatsappEnabled) {
  console.warn(
    '⚠️  GREENAPI_ID_INSTANCE / GREENAPI_API_TOKEN are not set. WhatsApp notifications will be skipped.\n' +
    '   Create a free instance at https://green-api.com, scan the QR code to link your WhatsApp\n' +
    '   number, then add GREENAPI_ID_INSTANCE and GREENAPI_API_TOKEN to your .env file.'
  );
}

// Normalizes a raw phone number into E.164 format (e.g. "+2348012345678").
// Handles two common cases for SellHub's Nigerian sellers/customers:
//  1. A full number with country code but a stray leading 0 after it
//     (e.g. "+234 0801..." -> "+234801...") — a common typing habit.
//  2. A local Nigerian number typed with NO country code at all
//     (e.g. "08012345678", straight from a plain phone-number field on the
//     seller onboarding form) — assumed to be Nigerian and given +234.
function toE164(rawPhone) {
  if (!rawPhone) return null;
  let digits = String(rawPhone).replace(/[^\d+]/g, '');

  if (digits.startsWith('+')) {
    // Already has a country code — just drop a stray 0 right after it.
    digits = digits.replace(/^(\+\d{1,3})0(\d{6,})$/, '$1$2');
  } else if (digits.startsWith('0')) {
    // Local format with no country code at all — assume Nigeria (+234)
    // and drop the leading 0, e.g. "08012345678" -> "+234801234567".
    digits = '+234' + digits.slice(1);
  } else {
    digits = '+' + digits;
  }

  return /^\+\d{8,15}$/.test(digits) ? digits : null;
}

// Green API chat IDs are the phone number digits (no +) followed by @c.us
// for a direct chat, or @g.us for a group chat.
function toChatId(e164) {
  return e164.replace('+', '') + '@c.us';
}

// Fire-and-forget style: never throws. Always resolves to { ok, ... } so a
// failed WhatsApp send never blocks the order/status/reminder flow that
// called it.
async function sendWhatsApp(rawPhone, message) {
  if (!whatsappEnabled) {
    return { ok: false, reason: 'not_configured' };
  }

  const e164 = toE164(rawPhone);
  if (!e164) {
    console.log('WhatsApp skipped: no usable phone number for', rawPhone);
    return { ok: false, reason: 'bad_number' };
  }

  try {
    const url = `${GREENAPI_URL}/waInstance${GREENAPI_ID_INSTANCE}/sendMessage/${GREENAPI_API_TOKEN}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: toChatId(e164), message })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.log('WhatsApp send failed:', res.status, data.message || JSON.stringify(data));
      return { ok: false, reason: data.message || res.status };
    }

    return { ok: true, id: data.idMessage };
  } catch (err) {
    console.log('WhatsApp send error:', err.message);
    return { ok: false, reason: 'network_error' };
  }
}

module.exports = { sendWhatsApp, toE164, toChatId, whatsappEnabled };