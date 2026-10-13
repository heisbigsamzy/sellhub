const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sendOTPEmail, sendEmail } = require('./mailer');
const { verifyGoogleToken } = require('./googleAuth');
const { sendWhatsApp } = require('./whatsapp');
const { backupFile: upstashBackup, restoreAllFiles } = require('./dataBackup');
const pgstore = require('./pgStore');
// Every save goes to the optional Upstash copy and the optional PostgreSQL database (each does nothing until configured).
function backupFile(name, text) { upstashBackup(name, text); pgstore.save(name, text); }

// ---------- DATA STORAGE ----------
// Render's free tier has no permanent disk: every time the service redeploys,
// restarts, OR just goes idle and spins back down, anything written to the
// local filesystem is wiped. Setting DATA_DIR to a path on a Render
// *persistent disk* (Render dashboard → service → Disks) makes every wallet
// balance, order and withdrawal survive all of that. Without DATA_DIR set,
// behavior is unchanged — files live next to server.js, same as before.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILES = [
  'admin-withdrawals.json', 'customers.json', 'disputes.json', 'notifications.json',
  'orders.json', 'payments.json', 'products.json', 'reviews.json',
  'seller-notifications.json', 'sellers.json', 'settings.json', 'withdrawals.json'
];
// The very first time a persistent disk is attached, it's empty. Seed it
// once from whatever's already sitting next to server.js (your current
// sellers/products/settings) so the site doesn't start from zero — after
// that, the disk's own copies are always used and never overwritten here.
// True only when this disk has never held SellHub data (brand-new or wiped).
// Only then is the Upstash copy allowed to overwrite the disk at boot; on a
// disk that already has data, the disk is the source of truth and a possibly
// older backup must never replace it.
let freshDisk = false;
if (DATA_DIR !== __dirname) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  freshDisk = ['sellers.json', 'customers.json', 'products.json'].every(f => !fs.existsSync(path.join(DATA_DIR, f)));
  for (const file of DATA_FILES) {
    const dest = path.join(DATA_DIR, file);
    const src = path.join(__dirname, file);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log('Seeded', file, 'onto the persistent disk.');
    }
  }
  console.log('💾 Using persistent storage at', DATA_DIR);
} else {
  console.warn('⚠️  No DATA_DIR set — data lives on the temporary server disk and WILL be lost on every restart/redeploy/idle spin-down. Set DATA_DIR to a Render persistent disk path to fix this.');
}

const PORT = 3000;
const pendingSignups = {};
const pendingSellerSignups = {};
const resetCodes = {};

// These three are the OTP codes people are actively typing in right now
// (signup, seller signup, password reset). They used to live ONLY in
// memory, which meant a Render restart/redeploy/idle spin-down between
// "code sent" and "code entered" silently wiped them — the next request
// would get "❌ Wrong code" for a code that was actually correct. That's
// the most likely explanation for "sometimes it says incorrect while it
// works sometimes": it depends on whether the free-tier instance happened
// to restart in the minute or two it took the person to find the email
// (often in spam — see mailer.js) and type the code in.
// Backed up to the same free Upstash store as the data files (a no-op
// until that's configured — see dataBackup.js) and restored on boot, so
// these survive exactly like everything else now does.
const CODE_STATE_FILES = ['pendingSignups.json', 'pendingSellerSignups.json', 'resetCodes.json', 'sessions.json'];
function persistCodeState() {
  backupFile('sessions.json', JSON.stringify(sessions));
  backupFile('pendingSignups.json', JSON.stringify(pendingSignups));
  backupFile('pendingSellerSignups.json', JSON.stringify(pendingSellerSignups));
  backupFile('resetCodes.json', JSON.stringify(resetCodes));
}

// ---------- ADMIN WHATSAPP ALERTS ----------
// Your own WhatsApp number, so you (the admin) get pinged the moment
// something needs your attention: a new verification submission, a
// withdrawal request, or a customer dispute. Set this in .env.
const ADMIN_WHATSAPP_PHONE = process.env.ADMIN_WHATSAPP_PHONE || '';

if (!ADMIN_WHATSAPP_PHONE) {
  console.warn('⚠️  ADMIN_WHATSAPP_PHONE is not set — admin WhatsApp alerts (verifications, withdrawals, disputes) are switched off.');
}

// Your own email address, so the same admin alerts also land in your inbox
// — a second channel in case WhatsApp is down or over its plan limit.
// Set ADMIN_EMAIL in Render -> Environment.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim();

if (!ADMIN_EMAIL) {
  console.warn('⚠️  ADMIN_EMAIL is not set — admin alerts will only go to WhatsApp, not email.');
}

// Fire-and-forget: never throws, never blocks the request that triggered it.
// Goes out on both channels (WhatsApp and email) — each is skipped on its
// own if it isn't configured, and one failing never stops the other.
function notifyAdmin(message) {
  if (ADMIN_WHATSAPP_PHONE) {
    sendWhatsApp(ADMIN_WHATSAPP_PHONE, message).catch(err => console.log('WhatsApp error (admin alert):', err.message));
  }
  if (ADMIN_EMAIL) {
    sendEmail(ADMIN_EMAIL, 'SellHub admin alert', `<p>${message}</p>`)
      .catch(err => console.log('Email error (admin alert):', err.message));
  }
}

// Tells a seller the outcome of their withdrawal request — paid, or refunded
// to their wallet — by WhatsApp and email. Fire-and-forget like the rest.
function notifySellerWithdrawal(seller, withdrawal, paid) {
  if (!seller) return;
  const bankLine = `${withdrawal.bank || 'your bank'} account ending ${String(withdrawal.accountNumber || '').slice(-4)}`;
  const text = paid
    ? `✅ Your withdrawal of ₦${withdrawal.netAmount.toLocaleString()} has been paid to your ${bankLine}.`
    : `⚠️ Your withdrawal of ₦${withdrawal.amount.toLocaleString()} was not approved, so the full amount has been returned to your SellHub wallet.` + (withdrawal.rejectReason ? ` Reason: ${withdrawal.rejectReason}` : ' Please check your bank details and try again.');

  const phone = seller.whatsappNumber || seller.businessPhone || seller.phone;
  if (phone) {
    sendWhatsApp(phone, `SellHub: ${text}`).catch(err => console.log('WhatsApp error (withdrawal):', err.message));
  }
  sendEmail(
    seller.email,
    paid ? 'Your SellHub withdrawal has been paid' : 'Your SellHub withdrawal was returned to your wallet',
    `<p>Hello ${seller.fullName || ''},</p><p>${text}</p>`
  ).catch(err => console.log('Email error (withdrawal):', err.message));
}

// ---------- PAYSTACK (real money) ----------
// The secret key lives ONLY in .env on the server. It must never be put in
// any .html file or sent to the browser — anyone holding it can move your money.
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const APP_BASE_URL = (process.env.APP_BASE_URL || ('http://localhost:' + PORT)).replace(/\/+$/, '');
const MIN_DEPOSIT_NAIRA = 100;
const MAX_DEPOSIT_NAIRA = 1000000;

// Paystack's Nigerian fee for local payments: 1.5% + ₦100, where the ₦100 is
// waived when the payment is under ₦2,500, and the whole fee is capped at ₦2,000.
// (Source: Paystack's "Transactions pricing" help page.) When a customer adds
// ₦X to their wallet we charge them a little more than ₦X, so that after
// Paystack takes its fee, you still receive the full ₦X. This is completely
// separate from SellHub's own fees (the checkout % and withdrawal %).
const PAYSTACK_RATE = 0.015;
const PAYSTACK_FLAT_KOBO = 10000;      // ₦100
const PAYSTACK_WAIVER_KOBO = 250000;   // ₦2,500
const PAYSTACK_CAP_KOBO = 200000;      // ₦2,000

// Returns the total (in whole naira) to charge so that `priceNaira` reaches you
// after Paystack's fee, using Paystack's published "pass the fee" formulas.
function paystackTotalNaira(priceNaira) {
  const price = priceNaira * 100; // kobo
  // Small payments: the ₦100 is waived while the total stays under ₦2,500.
  const withoutFlat = Math.ceil(price / (1 - PAYSTACK_RATE)) + 1;
  let total;
  if (withoutFlat < PAYSTACK_WAIVER_KOBO) {
    total = withoutFlat;
  } else if ((PAYSTACK_RATE * price) + PAYSTACK_FLAT_KOBO > PAYSTACK_CAP_KOBO) {
    total = price + PAYSTACK_CAP_KOBO;                       // fee hits the ₦2,000 cap
  } else {
    total = Math.ceil((price + PAYSTACK_FLAT_KOBO) / (1 - PAYSTACK_RATE)) + 1;
  }
  return Math.ceil(total / 100); // round up to a whole naira so the customer sees a clean number
}

// Works out what a deposit costs. The setting can be switched off in
// settings.json ("passPaystackFeeToCustomer": false) if you ever prefer to
// absorb Paystack's fee yourself.
function depositQuote(amount) {
  let settings = {};
  try { settings = getSettings(); } catch (e) {}
  const total = settings.passPaystackFeeToCustomer === false ? amount : paystackTotalNaira(amount);
  return { amount, fee: total - amount, total };
}

if (!PAYSTACK_SECRET_KEY) {
  console.warn('⚠️  PAYSTACK_SECRET_KEY is not set in .env — wallet deposits are switched off until you add it.');
} else if (PAYSTACK_SECRET_KEY.startsWith('sk_live_')) {
  console.warn('💰 Paystack is in LIVE mode — deposits use REAL money.');
} else {
  console.log('🧪 Paystack is in TEST mode — no real money moves.');
}

// Calls Paystack from the server (never from the browser).
async function paystackRequest(method, path, body) {
  const res = await fetch('https://api.paystack.co' + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + PAYSTACK_SECRET_KEY,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.status) {
    throw new Error(json.message || ('Paystack error ' + res.status));
  }
  return json.data;
}

// ---------- PAYSTACK TRANSFERS (automatic payouts to sellers/admin) ----------
// Paystack's list of Nigerian banks rarely changes, so it's cached in memory
// for an hour instead of calling the API on every page load.
let bankListCache = null;
let bankListCacheAt = 0;
async function getBankList() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (bankListCache && (Date.now() - bankListCacheAt) < ONE_HOUR) return bankListCache;
  const data = await paystackRequest('GET', '/bank?currency=NGN');
  bankListCache = data.map(b => ({ name: b.name, code: b.code }));
  bankListCacheAt = Date.now();
  return bankListCache;
}

// Confirms an account number actually belongs to the name on file at that
// bank, before any money is sent to it — catches typos and wrong accounts.
async function resolveBankAccount(accountNumber, bankCode) {
  const data = await paystackRequest('GET', `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
  return data.account_name;
}

// A "transfer recipient" is Paystack's record of who to pay; it has to be
// created once before a transfer can be sent to that account.
async function createTransferRecipient(name, accountNumber, bankCode) {
  const data = await paystackRequest('POST', '/transferrecipient', {
    type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency: 'NGN'
  });
  return data.recipient_code;
}

// Sends real money out of the SellHub Paystack balance to a recipient.
// `reference` is our own id (e.g. "seller-wd-123") so the webhook can later
// match the result back to the right withdrawal record.
async function initiateTransfer(amount, recipientCode, reason, reference) {
  return paystackRequest('POST', '/transfer', {
    source: 'balance', amount: Math.round(amount * 100), recipient: recipientCode, reason, reference
  });
}

// payments.json is created automatically the first time it's needed.
function readPayments() {
  try { return readJSON('payments.json'); } catch (e) { return []; }
}

// Credits a customer's wallet for a Paystack payment — but ONLY if Paystack
// itself confirmed it, the amount matches what we asked for, and we haven't
// already credited it. Everything here is synchronous (no `await`), so even if
// the browser callback and Paystack's webhook arrive at the same instant, only
// one of them can get past the "already credited" check.
function creditPaystackPayment(reference, tx) {
  const payments = readPayments();
  const payment = payments.find(p => p.reference === reference);
  if (!payment) return { ok: false, reason: 'unknown_reference' };
  if (payment.status === 'success') return { ok: true, alreadyCredited: true };
  // A payment flagged for a wrong amount stays frozen until YOU review it in
  // payments.json — it must never be credited automatically later.
  if (payment.status === 'amount_mismatch') return { ok: false, reason: 'flagged_for_review' };

  if (!tx || tx.status !== 'success') return { ok: false, reason: 'not_successful' };
  if (tx.reference !== reference) return { ok: false, reason: 'reference_mismatch' };
  if (tx.currency !== 'NGN') return { ok: false, reason: 'wrong_currency' };
  // What the customer should have paid = the deposit + Paystack's fee.
  // (Older records made before fees were passed on have no `total`.)
  const expectedKobo = Math.round((payment.total || payment.amount) * 100);
  if (Number(tx.amount) !== expectedKobo) {
    // Paid amount differs from what we asked for — never credit; flag for review.
    payment.status = 'amount_mismatch';
    payment.paidKobo = tx.amount;
    writeJSON('payments.json', payments);
    console.error('Paystack amount mismatch for', reference, 'expected', expectedKobo, 'got', tx.amount);
    return { ok: false, reason: 'amount_mismatch' };
  }

  const customers = readJSON('customers.json');
  const customer = customers.find(c => c.email === payment.email);
  if (!customer) return { ok: false, reason: 'no_customer' };

  // Mark the payment as done FIRST. If anything crashes after this line, the
  // worst case is a customer who needs a manual top-up (visible in
  // payments.json) — never a double credit, which would cost you money.
  payment.status = 'success';
  payment.creditedAt = new Date().toISOString();
  if (typeof tx.fees === 'number') payment.paystackFeeKobo = tx.fees; // Paystack's real fee, for your records
  writeJSON('payments.json', payments);

  customer.walletBalance = (customer.walletBalance || 0) + payment.amount;
  customer.transactions = customer.transactions || [];
  customer.transactions.unshift({ type: 'deposit', amount: payment.amount, reference, date: payment.creditedAt });
  writeJSON('customers.json', customers);

  notifyAdmin(
    `💰 Deposit received: ₦${payment.amount.toLocaleString()} from ${customer.fullName || customer.email} (${customer.email}). New wallet balance: ₦${customer.walletBalance.toLocaleString()}.`
  );

  return { ok: true, alreadyCredited: false };
}

// Confirms (or rolls back) a Paystack transfer once it finishes. `reference`
// is the one we set ourselves in initiateTransfer: "seller-wd-<id>" or
// "admin-wd-<id>" — that's how we know which record this result belongs to.
// Guarded against Paystack sending the same webhook more than once: a
// withdrawal only gets acted on while it's still "Processing".
function handleTransferWebhook(eventType, reference, failReason) {
  const succeeded = eventType === 'transfer.success';

  if (reference.startsWith('seller-wd-')) {
    const id = Number(reference.slice('seller-wd-'.length));
    const withdrawals = readJSON('withdrawals.json');
    const withdrawal = withdrawals.find(w => w.id === id);
    if (!withdrawal || withdrawal.status !== 'Processing') return;

    withdrawal.status = succeeded ? 'Approved' : 'Rejected';
    if (!succeeded) withdrawal.failReason = failReason || eventType;
    writeJSON('withdrawals.json', withdrawals);

    const sellers = readJSON('sellers.json');
    const seller = sellers.find(s => s.email === withdrawal.sellerEmail);
    if (seller) {
      const txn = (seller.transactions || []).find(t => t.type === 'withdrawal' && t.status === 'Processing' && t.amount === withdrawal.amount);
      if (txn) txn.status = withdrawal.status;
      if (!succeeded) {
        // The payout never arrived — give the seller their money back.
        seller.walletBalance = (seller.walletBalance || 0) + withdrawal.amount;
      }
      writeJSON('sellers.json', sellers);

      const phone = seller.whatsappNumber || seller.businessPhone || seller.phone;
      if (succeeded) {
        sendWhatsApp(phone, `✅ Your withdrawal of ₦${withdrawal.netAmount.toLocaleString()} has been paid to your ${withdrawal.bank} account ending ${String(withdrawal.accountNumber).slice(-4)}.`);
      } else {
        sendWhatsApp(phone, `⚠️ Your withdrawal of ₦${withdrawal.amount.toLocaleString()} could not be paid out, so it's been refunded to your SellHub wallet. Please check your bank details and try again.`);
      }
    }
    notifyAdmin(succeeded
      ? `SellHub: Payout of ₦${withdrawal.netAmount.toLocaleString()} to ${withdrawal.storeName || withdrawal.sellerEmail} succeeded ✅`
      : `SellHub: Payout to ${withdrawal.storeName || withdrawal.sellerEmail} FAILED ❌ (₦${withdrawal.amount.toLocaleString()}, refunded to their wallet). Reason: ${failReason || eventType}`);

  } else if (reference.startsWith('admin-wd-')) {
    const id = Number(reference.slice('admin-wd-'.length));
    const adminWithdrawals = readJSON('admin-withdrawals.json');
    const withdrawal = adminWithdrawals.find(w => w.id === id);
    if (!withdrawal || withdrawal.status !== 'Processing') return;

    withdrawal.status = succeeded ? 'Approved' : 'Failed';
    if (!succeeded) withdrawal.failReason = failReason || eventType;
    writeJSON('admin-withdrawals.json', adminWithdrawals);

    notifyAdmin(succeeded
      ? `SellHub: Your withdrawal of ₦${withdrawal.amount.toLocaleString()} to your bank succeeded ✅`
      : `SellHub: Your withdrawal of ₦${withdrawal.amount.toLocaleString()} FAILED ❌ — no money left the account. Reason: ${failReason || eventType}`);
  }
}

// Reads the request body exactly as sent (needed to check Paystack's signature).
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1000000) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- EMAIL NORMALIZATION ----------
// Every account lookup (signup duplicate-check, login, password reset,
// Google sign-in) has to use the exact same key for the exact same person,
// or two different-cased/whitespace-padded typings of one email silently
// become two different accounts. Trimming + lowercasing at every entry
// point — not just storage — is what makes "Sam@Gmail.com" at signup and
// "sam@gmail.com" at login resolve to the same record.
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

// ---------- SESSIONS ----------
// In-memory session store: token -> { email, accountType, expiresAt }.
// Resets when the server restarts — fine for an MVP, but note that a real
// deployment should move this to a persistent store (e.g. Redis) so sessions
// survive restarts and work across multiple server instances.
// Sessions are now saved (debounced) to the persistent disk and the Upstash
// backup, so a Render restart or redeploy no longer logs everyone out. Only a
// SHA-256 hash of each token is stored, never the token itself, so a leaked
// backup can't be used to log in as someone.
const sessions = {};
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
let sessionSaveTimer = null;

function saveSessions() {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    const now = Date.now();
    for (const k of Object.keys(sessions)) if (sessions[k].expiresAt < now) delete sessions[k];
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); } catch (e) { console.log('Could not save sessions:', e.message); }
    backupFile('sessions.json', JSON.stringify(sessions));
  }, 1000);
}

function loadSessionsFromDisk() {
  try { Object.assign(sessions, JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'))); } catch (e) { /* none yet */ }
}

function createSession(email, accountType) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[hashToken(token)] = { email, accountType, expiresAt: Date.now() + SESSION_TTL_MS };
  saveSessions();
  return token;
}

function getSession(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const key = hashToken(token);
  const session = sessions[key];
  if (!session) return null;
  if (session.expiresAt < Date.now()) { delete sessions[key]; saveSessions(); return null; }
  return session;
}

// Call this at the top of any protected route. Sends a 401 and returns null
// if there's no valid session (optionally requiring a specific account type).
function requireAuth(req, res, accountType) {
  const session = getSession(req);
  if (!session || (accountType && session.accountType !== accountType)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: 'Please log in again.' }));
    return null;
  }
  return session;
}

// ---------- FEES ----------
// Kept in a plain JSON file so an admin dashboard can edit these later
// without touching code. Server-side only — never trust a fee percentage
// sent from the client.
function getSettings() {
  return readJSON('settings.json');
}

// Platform revenue has two sources: the customer service fee taken on every
// order, and the seller withdrawal fee — but the withdrawal fee only counts
// once a withdrawal is actually Approved (a Rejected one refunds the seller
// their full amount, fee included, so nothing was really earned from it).
// Only REAL money counts. Wallets could only be funded for free by the old
// demo deposit until the first real Paystack payment was credited, so any
// order or withdrawal dated before that moment is demo data and is ignored.
// With no real deposit yet, revenue is exactly 0.
function getRealMoneyStart() {
  let earliest = Infinity;
  for (const p of readPayments()) {
    if (p.status !== 'success') continue;
    const t = Date.parse(p.creditedAt || p.createdAt);
    if (!isNaN(t) && t < earliest) earliest = t;
  }
  return earliest;
}

function getPlatformRevenue() {
  const start = getRealMoneyStart();
  const isReal = r => Date.parse(r.date) >= start;
  const orders = readJSON('orders.json').filter(isReal);
  const withdrawals = readJSON('withdrawals.json').filter(isReal);

  const customerFeeRevenue = orders.reduce((sum, o) => sum + (o.serviceFee || 0), 0);
  const withdrawalFeeRevenue = withdrawals
    .filter(w => w.status === 'Approved')
    .reduce((sum, w) => sum + (w.fee || 0), 0);

  return customerFeeRevenue + withdrawalFeeRevenue;
}

// Creates an in-app notification for a customer. This is the single place
// that writes to notifications.json, so every notification — regardless of
// what triggered it — has the same shape.
function createNotification(customerEmail, orderId, type, title, message) {
  const notifications = readJSON('notifications.json');
  const notification = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    customerEmail, orderId, type, title, message,
    date: new Date().toISOString(),
    read: false
  };
  notifications.unshift(notification);
  writeJSON('notifications.json', notifications);
  return notification;
}

// Same idea as createNotification above, but for sellers — used for things
// like a customer's delivery reminder, so the seller sees it in-app and
// isn't relying on email alone.
function createSellerNotification(sellerEmail, orderId, type, title, message) {
  const notifications = readJSON('seller-notifications.json');
  const notification = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    sellerEmail, orderId, type, title, message,
    date: new Date().toISOString(),
    read: false
  };
  notifications.unshift(notification);
  writeJSON('seller-notifications.json', notifications);
  return notification;
}

// One copy source for both the in-app notification and the email that goes
// out for each order status, so the two can never drift out of sync.
const ORDER_STATUS_COPY = {
  'Order Received': {
    subject: 'Your Order Has Been Placed',
    heading: 'Order Confirmed',
    line: (order) => `Your order #${order.id} has been received and is being prepared.`
  },
  'Processing': {
    subject: 'Your Order Is Being Processed',
    heading: 'Order Processing',
    line: (order) => `Your order #${order.id} is now being processed by the seller.`
  },
  'Shipped': {
    subject: 'Your Order Has Been Shipped',
    heading: 'Order Shipped',
    line: (order) => `Your order #${order.id} has been shipped and is now on its way.`
  },
  'Out for Delivery': {
    subject: 'Your Order Is Out for Delivery',
    heading: 'Out for Delivery',
    line: (order) => `Your order #${order.id} is out for delivery.`
  },
  'Delivered': {
    subject: 'Your Order Has Been Delivered',
    heading: 'Order Delivered',
    line: (order) => `Your order #${order.id} has been delivered successfully.`
  },
  'Cancelled': {
    subject: 'Your Order Has Been Cancelled',
    heading: 'Order Cancelled',
    line: (order) => `Your order #${order.id} has been cancelled.`
  }
};

// Fires both the in-app notification and the email for a status change.
// Called from exactly one place per status transition, so seller dashboard,
// customer dashboard, notifications and email all reflect the same event.
// One order line can hold several units of the same product (item.quantity).
// effectivePrice is always the price of ONE unit, so every total multiplies by quantity.
const itemQty = i => Math.max(1, Math.floor(Number(i && i.quantity) || 1));
const lineTotal = i => (i.effectivePrice || i.price) * itemQty(i);
const itemLabel = i => itemQty(i) > 1 ? `${i.name} ×${itemQty(i)}` : i.name;

function notifyOrderStatus(order, status) {
  const copy = ORDER_STATUS_COPY[status];
  if (!copy) return;

  createNotification(order.customerEmail, order.id, status, copy.heading, copy.line(order));

  const itemsList = order.items.map(itemLabel).join(', ');
  const toEmail = order.deliveryEmail || order.customerEmail;
  const html = `
    <p>Hello ${order.fullName || ''},</p>
    <p>${copy.line(order)}</p>
    <p><b>Order:</b> ${itemsList}<br><b>Total:</b> ₦${order.total.toLocaleString()}</p>
    <p>You can log in to your account to track your order.</p>
    <p>Thank you for shopping with SellHub.</p>
  `;
  sendEmail(toEmail, copy.subject, html).catch(err => console.log('Email error:', err.message));

  if (order.phone) {
    sendWhatsApp(order.phone, `SellHub: ${copy.line(order)}\nItems: ${itemsList}\nTotal: ₦${order.total.toLocaleString()}`)
      .catch(err => console.log('WhatsApp error:', err.message));
  }
}

// Pays every seller in the order their share immediately at purchase time
// (rather than waiting for delivery). Groups by seller since one order can
// contain products from more than one store.
function creditSellersForOrder(order) {
  const sellers = readJSON('sellers.json');
  const shareBySeller = {};
  order.items.forEach(item => {
    shareBySeller[item.sellerEmail] = (shareBySeller[item.sellerEmail] || 0) + lineTotal(item);
  });

  Object.entries(shareBySeller).forEach(([sellerEmail, amount]) => {
    const seller = sellers.find(s => s.email === sellerEmail);
    if (!seller || amount <= 0) return;
    seller.walletBalance = (seller.walletBalance || 0) + amount;
    seller.transactions = seller.transactions || [];
    seller.transactions.unshift({
      type: 'sale', amount, orderId: order.id, date: new Date().toISOString()
    });
  });
  writeJSON('sellers.json', sellers);
}

// Tells each seller in the order — by WhatsApp and in-app notification — the
// moment a paid order comes in, so they don't have to keep checking the
// dashboard to notice new business.
function notifySellerNewOrder(order) {
  const sellers = readJSON('sellers.json');
  const itemsBySeller = {};
  order.items.forEach(item => {
    if (!itemsBySeller[item.sellerEmail]) itemsBySeller[item.sellerEmail] = [];
    itemsBySeller[item.sellerEmail].push(item);
  });

  Object.entries(itemsBySeller).forEach(([sellerEmail, items]) => {
    const seller = sellers.find(s => s.email === sellerEmail);
    if (!seller) return;
    const payout = items.reduce((sum, i) => sum + lineTotal(i), 0);
    const itemsList = items.map(itemLabel).join(', ');

    createSellerNotification(
      sellerEmail, order.id, 'New Order',
      'New order received!',
      `New order #${order.id} from ${order.fullName || 'a customer'}: ${itemsList}. Your payout: ₦${payout.toLocaleString()}.`
    );

    const sellerPhone = seller.whatsappNumber || seller.businessPhone;
    if (sellerPhone) {
      sendWhatsApp(
        sellerPhone,
        `SellHub: New order #${order.id} from ${order.fullName || 'a customer'}!\nItems: ${itemsList}\nYour payout: ₦${payout.toLocaleString()}`
      ).catch(err => console.log('WhatsApp error:', err.message));
    }

    sendEmail(
      sellerEmail,
      `New order #${order.id} on SellHub`,
      `<p>Hello ${seller.fullName || ''},</p><p>You have a new order #${order.id} from ${order.fullName || 'a customer'}.</p><p>Items: ${itemsList}</p><p>Your payout: ₦${payout.toLocaleString()}</p><p>Open your seller dashboard to process it.</p>`
    ).catch(err => console.log('Email error (new order):', err.message));
  });
}

// If an order is cancelled after sellers were already paid, this reverses
// their share and refunds the customer, so money doesn't end up stuck with
// a seller for an order that never completed.
// Put the quantities of a cancelled order back into the sellers' stock (only once per order).
function restoreStockForOrder(order) {
  if (order.stockRestored) return;
  const products = readJSON('products.json');
  let changed = false;
  (order.items || []).forEach(item => {
    const p = products.find(x => x.id === item.id);
    if (p && typeof p.stock === 'number') {
      p.stock += itemQty(item);
      p.status = 'In Stock';
      changed = true;
    }
  });
  if (changed) writeJSON('products.json', products);
  order.stockRestored = true;
}
function reverseSellerCreditsAndRefundCustomer(order) {
  const sellers = readJSON('sellers.json');
  const shareBySeller = {};
  order.items.forEach(item => {
    shareBySeller[item.sellerEmail] = (shareBySeller[item.sellerEmail] || 0) + lineTotal(item);
  });

  Object.entries(shareBySeller).forEach(([sellerEmail, amount]) => {
    const seller = sellers.find(s => s.email === sellerEmail);
    if (!seller || amount <= 0) return;
    seller.walletBalance = (seller.walletBalance || 0) - amount;
    seller.transactions = seller.transactions || [];
    seller.transactions.unshift({
      type: 'sale-reversed', amount: -amount, orderId: order.id, date: new Date().toISOString()
    });
  });
  writeJSON('sellers.json', sellers);

  const customers = readJSON('customers.json');
  const customer = customers.find(c => c.email === order.customerEmail);
  if (customer) {
    customer.walletBalance = (customer.walletBalance || 0) + order.total;
    customer.transactions = customer.transactions || [];
    customer.transactions.unshift({
      type: 'refund', amount: order.total, orderId: order.id, date: new Date().toISOString()
    });
    writeJSON('customers.json', customers);
  }
}

// Text typed by users must never be able to carry HTML: angle brackets are removed from every text field
// (passwords, codes, tokens and photo data are left alone).
const KEEP_KEYS = /^(password|newPassword|oldPassword|currentPassword|pin|code|otp|token|credential|idToken|thumbs|images|image|logo|selfie|photo|document)/i;
function cleanText(node, key) {
  if (typeof node === 'string') {
    if (KEEP_KEYS.test(key || '') || node.startsWith('data:') || node.startsWith('/blob/')) return node;
    return node.replace(/[<>]/g, '');
  }
  if (Array.isArray(node)) return node.map(n => cleanText(n, key));
  if (node && typeof node === 'object') { for (const k of Object.keys(node)) node[k] = cleanText(node[k], k); return node; }
  return node;
}
const MAX_BODY = 25 * 1024 * 1024; // photos arrive inside the body, so this is generous
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '', size = 0, dead = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { dead = true; body = ''; req.destroy(); reject(new Error('Request too large')); return; }
      if (!dead) body += chunk;
    });
    req.on('end', () => {
      if (dead) return;
      try { resolve(body ? cleanText(JSON.parse(body), '') : {}); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}
// ---------- RATE LIMITING (stops password guessing and code spamming) ----------
const rateHits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of rateHits) if (v.reset < now) rateHits.delete(k); }, 5 * 60 * 1000).unref();
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
// Returns true (and answers 429) when this key has been used more than `max` times in `windowMs`.
function tooMany(req, res, bucket, max, windowMs, extra) {
  const key = bucket + ':' + (extra !== undefined ? extra : clientIp(req));
  const now = Date.now();
  let h = rateHits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; rateHits.set(key, h); }
  h.n++;
  if (h.n > max) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': Math.ceil((h.reset - now) / 1000) });
    res.end(JSON.stringify({ ok: false, message: 'Too many attempts. Please wait a few minutes and try again.' }));
    return true;
  }
  return false;
}
function readJSON(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8')); }
// ---------- IMAGE FILES (kept out of the JSON data) ----------
// Photos arrive as huge base64 "data:" strings (ID photos, selfies, CAC
// documents, store logos, product photos). Inside sellers.json/products.json
// they made the files so big that the free Upstash backup could refuse them.
// Now, every time a data file is saved, any such string is written to its own
// file in DATA_DIR/blobs and replaced by a short link (/blob/<random-id>.jpg).
// Pages use that link in <img src> exactly like they used the inline data.
// The ids are long and random, so a link can't be guessed.
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const BLOB_TYPES = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
const BLOB_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };
const DATA_URL_RE = /^data:([a-z]+\/[a-z]+);base64,/i;

function externalizeBlob(str) {
  const m = DATA_URL_RE.exec(str);
  const ext = m && BLOB_TYPES[m[1].toLowerCase()];
  if (!ext) return str;
  const id = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(BLOB_DIR, { recursive: true });
    const buf = Buffer.from(str.slice(m[0].length), 'base64');
    fs.writeFileSync(path.join(BLOB_DIR, `${id}.${ext}`), buf);
    pgstore.saveBlob(`${id}.${ext}`, buf, m[1].toLowerCase());
  } catch (e) {
    console.log('Could not save image file, keeping it inline:', e.message);
    return str;
  }
  return `/blob/${id}.${ext}`;
}

// Walks the data in place; returns true if anything was moved out.
function externalizeBlobs(node) {
  let changed = false;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === 'string') {
        if (node[i].length > 2000 && node[i].startsWith('data:')) { const r = externalizeBlob(node[i]); if (r !== node[i]) { node[i] = r; changed = true; } }
      } else if (node[i] && typeof node[i] === 'object') changed = externalizeBlobs(node[i]) || changed;
    }
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string') {
        if (v.length > 2000 && v.startsWith('data:')) { const r = externalizeBlob(v); if (r !== v) { node[k] = r; changed = true; } }
      } else if (v && typeof v === 'object') changed = externalizeBlobs(v) || changed;
    }
  }
  return changed;
}

function writeJSON(file, data) {
  externalizeBlobs(data);
  const text = JSON.stringify(data, null, 2);
  // Write to a temp file first, then swap it in, so a crash mid-save can never leave a half-written file.
  const target = path.join(DATA_DIR, file);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
  // Free, zero-maintenance safety net — see dataBackup.js. No-ops until an
  // Upstash database is connected; never blocks or throws into the caller.
  backupFile(file, text);
}

// Keeps a copy of every data file once a day (last 7 days) inside DATA_DIR/backups.
function snapshotData() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(DATA_DIR, 'backups', day);
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    DATA_FILES.forEach(f => { try { fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f)); } catch (e) {} });
    const root = path.join(DATA_DIR, 'backups');
    fs.readdirSync(root).sort().slice(0, -7).forEach(d => { try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch (e) {} });
    console.log('Daily data snapshot saved:', day);
  } catch (e) { console.warn('Snapshot failed:', e.message); }
}
function serveFile(res, fileName, extraHeaders) {
  fs.readFile(fileName, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html' }, extraHeaders || {}));
    res.end(content);
  });
}

// Thumbnails must line up one-to-one with the photos and be small JPEGs (or links we already stored).
function cleanThumbs(thumbs, images) {
  if (!Array.isArray(thumbs) || thumbs.length !== images.length) return [];
  const ok = t => typeof t === 'string' && ((/^data:image\/jpeg;base64,/.test(t) && t.length < 400000) || /^\/blob\/[a-f0-9]{48}\.jpg$/.test(t));
  return thumbs.every(ok) ? thumbs : [];
}

// ---------- SEARCH ENGINES (SEO) ----------
const SITE_URL = (process.env.PUBLIC_URL || 'https://sellhubmarket.xyz').replace(/\/+$/, '');
// Pages that should never show up in Google (private or admin screens).
const NOINDEX_PAGES = new Set(['/dashboard', '/seller-dashboard', '/seller-onboarding', '/verification-center',
  '/admin-login', '/admin-dashboard', '/forgot-password']);
const escHtml = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SITEMAP_PAGES = [['/', 'weekly', '1.0'], ['/about', 'monthly', '0.7'], ['/help', 'monthly', '0.6'], ['/contact', 'monthly', '0.5'],
  ['/signup', 'monthly', '0.8'], ['/seller-signup', 'monthly', '0.8'], ['/login', 'monthly', '0.4'], ['/terms', 'yearly', '0.3'], ['/privacy', 'yearly', '0.3']];

// A storefront page is one shared HTML file, so before sending it we put the
// store's own name and description in the title/meta tags — that is what Google reads first.
function serveStorefront(res, slug) {
  fs.readFile('storefront.html', 'utf-8', (err, html) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const seller = readJSON('sellers.json').find(x => x.storeSlug === slug && !x.suspended);
      if (seller) {
        const name = escHtml(seller.storeName || seller.businessName || 'Store');
        const place = [seller.city, seller.state].filter(Boolean).join(', ');
        const desc = escHtml(`Shop ${seller.storeName || seller.businessName} on SellHub${place ? ' — based in ' + place : ''}. Verified Nigerian seller, secure wallet payments and order tracking.`);
        const url = `${SITE_URL}/store/${encodeURIComponent(slug)}`;
        const head = `<title>${name} — Shop on SellHub</title>\n<meta name="description" content="${desc}">\n<link rel="canonical" href="${url}">\n<meta property="og:title" content="${name} — Shop on SellHub">\n<meta property="og:description" content="${desc}">\n<meta property="og:url" content="${url}">\n<meta property="og:type" content="website">\n<meta property="og:image" content="${SITE_URL}/logo.jpg">`;
        html = /<title>[\s\S]*?<\/title>/.test(html) ? html.replace(/<title>[\s\S]*?<\/title>/, () => head) : html.replace('</head>', () => head + '\n</head>');
      }
    } catch (e) { /* fall back to the plain page */ }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
}
function sendJSON(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const pages = {
  '/': 'sellhub-landing.html',
  '/privacy': 'privacy.html',
  '/about': 'about.html',
  '/contact': 'contact.html',
  '/terms': 'terms.html',
  '/help': 'help.html',
  '/signup': 'signup.html',
  '/seller-signup': 'seller-signup.html',
  '/login': 'login.html',
  '/forgot-password': 'forgot-password.html',
  '/dashboard': 'dashboard.html',
  '/seller-dashboard': 'seller-dashboard.html',
  '/seller-onboarding': 'seller-onboarding.html',
  '/verification-center': 'verification-center.html',
  '/admin-login': 'admin-login.html',
  '/admin-dashboard': 'admin-dashboard.html',
};

// ---------- PRODUCT VIEWS ----------
// Every time a shopper opens a product its view count goes up by one and is
// saved straight away, so the seller sees it within seconds. Only a double-fire
// from the same visitor within 2 seconds (a double tap) is ignored.
const recentViewers = new Map();  // "ip|productId" -> last counted time
const VIEW_DEDUPE_MS = 2 * 1000;
setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [k, t] of recentViewers) if (t < cutoff) recentViewers.delete(k);
}, 60 * 1000).unref();

// Seller details for the admin when a customer reports, reviews or reminds about an order.
// If the seller's account was deleted we still say which store it was (from the order itself).
function describeSeller(email, orderItems, allSellers, allDisputes) {
  const s = allSellers.find(x => x.email === email);
  const snap = (orderItems || []).find(i => i.sellerEmail === email) || {};
  if (!s) return { email, found: false, deletedAccount: true, storeName: snap.storeName || '' };
  const v = s.verification || {};
  return {
    email: s.email,
    found: true,
    businessName: s.businessName || '',
    storeName: s.storeName || s.businessName || '',
    fullName: s.fullName || '',
    phone: s.businessPhone || s.phone || '',
    personalPhone: s.phone || '',
    whatsappNumber: s.whatsappNumber || '',
    state: s.state || '',
    city: s.city || '',
    bankName: v.bankName || '',
    accountNumber: v.accountNumber || '',
    accountName: v.accountName || '',
    suspended: !!s.suspended,
    warningCount: (s.warnings || []).length,
    disputeCount: allDisputes.filter(d => (d.sellerEmails || []).includes(email)).length
  };
}

// ---------- CUSTOMER REMINDERS (Mon / Wed / Fri) ----------
// Three times a week (Monday, Wednesday, Friday at 10:00 Lagos time) every customer gets an
// email and a WhatsApp message with a few new products and a nudge to check their orders.
// Customers can stop them with the unsubscribe link in every message. Switch the whole
// thing off with CUSTOMER_REMINDERS=off in Render -> Environment.
const REMINDERS_ON = String(process.env.CUSTOMER_REMINDERS || 'on').toLowerCase() !== 'off';
const REMINDER_DAYS = { Mon: 0, Wed: 1, Fri: 2 };
const REMINDER_HOUR = 10;            // Lagos time
const REMINDER_LAST_HOUR = 20;       // if the server was asleep all day, skip rather than message at night
const WA_GAP_MS = 4000;              // gap between WhatsApp messages (sending too fast can get a number blocked)
const MAIL_GAP_MS = 250;

function lagosNow() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return { weekday: parts.weekday, date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
function unsubSecret() {
  const st = getSettings();
  if (!st.unsubSecret) { st.unsubSecret = crypto.randomBytes(24).toString('hex'); writeJSON('settings.json', st); }
  return st.unsubSecret;
}
function unsubToken(email) { return crypto.createHmac('sha256', unsubSecret()).update(String(email).toLowerCase()).digest('hex').slice(0, 32); }
function unsubLink(email) { return `${SITE_URL}/unsubscribe?e=${encodeURIComponent(email)}&t=${unsubToken(email)}`; }

// Up to 4 of the newest in-stock products, one per seller first so different stores get seen.
function pickNewProducts(limit = 4) {
  const sellers = readJSON('sellers.json');
  const live = s => sellers.find(x => x.email === s && !x.suspended);
  const list = readJSON('products.json').filter(p => p.status !== 'Out of Stock' && (p.stock == null || p.stock > 0) && live(p.sellerEmail))
    .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
  const picked = [], seen = new Set();
  for (const p of list) { if (!seen.has(p.sellerEmail)) { seen.add(p.sellerEmail); picked.push(p); } if (picked.length >= limit) break; }
  for (const p of list) { if (picked.length >= limit) break; if (!picked.includes(p)) picked.push(p); }
  return picked;
}

const REMINDER_COPY = [
  { subject: n => `🛍️ ${n}, new arrivals on SellHub this week`, intro: 'Fresh products from verified sellers just landed on SellHub.' },
  { subject: n => `${n}, check out what is new on SellHub`, intro: 'New items were added since your last visit. Take a look before they sell out.' },
  { subject: n => `Weekend shopping? New on SellHub, ${n}`, intro: 'Start your weekend with something new from our verified sellers.' }
];

function buildReminder(customer, variant) {
  const first = (customer.fullName || 'there').trim().split(/\s+/)[0];
  const copy = REMINDER_COPY[variant % REMINDER_COPY.length];
  const products = pickNewProducts(4);
  const myOrders = readJSON('orders.json').filter(o => o.customerEmail === customer.email && o.status !== 'Delivered' && o.status !== 'Cancelled');
  const orderLine = myOrders.length ? `You have ${myOrders.length} order${myOrders.length > 1 ? 's' : ''} in progress. Log in to check ${myOrders.length > 1 ? 'their' : 'its'} status.` : 'You can check your orders and track deliveries anytime in your account.';
  const shopUrl = `${SITE_URL}/dashboard`;
  const unsub = unsubLink(customer.email);
  const money = n => '₦' + Number(n).toLocaleString();
  const price = p => money(p.discountPrice || p.price);

  const rows = products.map(p => {
    const img = p.images && p.images[0] ? (String(p.images[0]).startsWith('http') ? p.images[0] : SITE_URL + p.images[0]) : '';
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #e6eee9;">
      ${img ? `<img src="${img}" width="72" height="72" alt="" style="border-radius:10px;object-fit:cover;vertical-align:middle;margin-right:12px;float:left;">` : ''}
      <div style="font-weight:700;color:#0b2f1c;">${escHtml(p.name)}</div>
      <div style="color:#0b6b3a;font-weight:800;">${price(p)}</div>
      <div style="color:#5a6b61;font-size:12px;">${escHtml(p.storeName || '')}</div></td></tr>`;
  }).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0b2f1c;">
    <p>Hi ${escHtml(first)},</p>
    <p>${copy.intro}</p>
    ${rows ? `<table width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 14px;">${rows}</table>` : ''}
    <p>${orderLine}</p>
    <p style="margin:20px 0;"><a href="${shopUrl}" style="background:#0b6b3a;color:#fff;text-decoration:none;font-weight:800;padding:14px 26px;border-radius:99px;display:inline-block;">Shop new arrivals</a></p>
    <p style="color:#5a6b61;font-size:12px;">You get this because you have a SellHub account. <a href="${unsub}">Unsubscribe</a> any time.</p></div>`;
  const wa = [`Hi ${first} 👋 SellHub here.`, copy.intro, '',
    ...products.map(p => `• ${p.name}: ${price(p)}`),
    '', orderLine, `Shop now: ${shopUrl}`, '', `Stop these messages: ${unsub}`].join('\n');
  return { subject: copy.subject(first), html, wa };
}

let reminderRunning = false;
async function runCustomerReminders(opts = {}) {
  if (reminderRunning) return { ok: false, message: 'A reminder run is already in progress.' };
  reminderRunning = true;
  const variant = opts.variant != null ? opts.variant : (REMINDER_DAYS[lagosNow().weekday] || 0);
  const stats = { date: lagosNow().date, emails: 0, whatsapp: 0, failed: 0, skippedOptOut: 0, total: 0 };
  try {
    const all = readJSON('customers.json').filter(c => c.email);
    const customers = all.filter(c => { if (c.marketingOptOut) { stats.skippedOptOut++; return false; } return true; });
    stats.total = customers.length;
    for (const c of customers) {
      const msg = buildReminder(c, variant);
      try { await sendEmail(c.email, msg.subject, msg.html); stats.emails++; } catch (e) { stats.failed++; console.log('Reminder email error:', e.message); }
      await new Promise(r => setTimeout(r, MAIL_GAP_MS));
      const phone = c.phone || (c.savedAddress && c.savedAddress.phone);
      if (phone) {
        const r = await sendWhatsApp(phone, msg.wa);
        if (r && r.ok) stats.whatsapp++; else stats.failed++;
        await new Promise(r2 => setTimeout(r2, WA_GAP_MS));
      }
    }
  } catch (e) { console.log('Reminder run error:', e.message); }
  reminderRunning = false;
  const st = getSettings(); st.reminderState = Object.assign({}, st.reminderState, { lastDate: stats.date, lastRun: Object.assign({ at: new Date().toISOString() }, stats) });
  writeJSON('settings.json', st);
  notifyAdmin(`SellHub: customer reminders sent. Emails ${stats.emails}, WhatsApp ${stats.whatsapp}, failed ${stats.failed}, unsubscribed ${stats.skippedOptOut}.`);
  return { ok: true, stats };
}
function checkReminderSchedule() {
  if (!REMINDERS_ON || reminderRunning) return;
  const now = lagosNow();
  if (!(now.weekday in REMINDER_DAYS) || now.hour < REMINDER_HOUR || now.hour >= REMINDER_LAST_HOUR) return;
  const st = getSettings();
  if (st.reminderState && st.reminderState.lastDate === now.date) return;   // already sent today
  // Mark today as handled first, so a restart in the middle of a run can never double-send.
  st.reminderState = Object.assign({}, st.reminderState, { lastDate: now.date });
  writeJSON('settings.json', st);
  runCustomerReminders().catch(e => console.log('Reminder error:', e.message));
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  // Overall brake on any single address hammering the API (generous: many Nigerians share one mobile-network address).
  if (req.url.startsWith('/api/') && tooMany(req, res, 'api', 600, 60 * 1000)) return;

  // Ignore any ?query=string when matching a page, so returning from
  // Paystack to /dashboard?deposit=success still loads the dashboard.
  const pagePath = req.url.split('?')[0];
  if (req.method === 'GET' && /^\/blob\/[a-f0-9]{48}\.(jpg|png|webp|gif|pdf)$/.test(pagePath)) {
    const name = pagePath.slice(6);
    const sendBlob = img => {
      res.writeHead(200, {
        'Content-Type': BLOB_MIME[name.split('.')[1]],
        'Cache-Control': 'private, max-age=604800, immutable',
        'X-Robots-Tag': 'noindex',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(img);
    };
    fs.readFile(path.join(BLOB_DIR, name), (err, img) => {
      if (!err) return sendBlob(img);
      // Not on this server's disk (e.g. after a redeploy): fetch it from the database and keep a local copy.
      pgstore.getBlob(name).then(row => {
        if (!row) { res.writeHead(404); res.end('Not found'); return; }
        try { fs.mkdirSync(BLOB_DIR, { recursive: true }); fs.writeFileSync(path.join(BLOB_DIR, name), row.data); } catch (e) {}
        sendBlob(row.data);
      });
    });
    return;
  }
  if (req.method === 'GET' && /^\/(icon-(32|180|192|512)\.png|sellhub-logo-(transparent|on-dark|white)\.png|icon\.svg)$/.test(pagePath)) {
    const f = path.join(__dirname, 'brand', pagePath.slice(1));
    fs.readFile(f, (err, img) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': pagePath.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(img);
    });
    return;
  }
  if (req.method === 'GET' && pagePath === '/founder-photo.jpg') {
    fs.readFile(path.join(__dirname, 'founder-photo.jpg'), (err, img) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
      res.end(img);
    });
    return;
  }
  if (req.method === 'GET' && (pagePath === '/manifest.webmanifest' || pagePath === '/sw.js' || pagePath === '/offline.html')) {
    const types = { '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'application/javascript', '/offline.html': 'text/html' };
    fs.readFile(path.join(__dirname, 'brand', pagePath.slice(1)), (err, buf) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': types[pagePath], 'Cache-Control': pagePath === '/sw.js' ? 'no-cache' : 'public, max-age=3600', 'Service-Worker-Allowed': '/' });
      res.end(buf);
    });
    return;
  }
  if (req.method === 'GET' && pagePath === '/logo.jpg') {
    fs.readFile(path.join(__dirname, 'logo.jpg'), (err, img) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      res.end(img);
    });
    return;
  }
  if (req.method === 'GET' && pagePath === '/support-widget.js') {
    fs.readFile(path.join(__dirname, 'support-widget.js'), (err, js) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
      res.end(js);
    });
    return;
  }
  if (req.method === 'GET' && pagePath === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin-login\nDisallow: /admin-dashboard\nDisallow: /dashboard\nDisallow: /seller-dashboard\nDisallow: /seller-onboarding\nDisallow: /verification-center\nDisallow: /forgot-password\nDisallow: /unsubscribe\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    return;
  }
  if (req.method === 'GET' && pagePath === '/sitemap.xml') {
    let urls = SITEMAP_PAGES.map(([p, f, pr]) => `<url><loc>${SITE_URL}${p === '/' ? '/' : p}</loc><changefreq>${f}</changefreq><priority>${pr}</priority></url>`);
    try {
      readJSON('sellers.json').filter(x => x.storeSlug && !x.suspended).forEach(x => {
        urls.push(`<url><loc>${SITE_URL}/store/${encodeURIComponent(x.storeSlug)}</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`);
      });
    } catch (e) { /* pages only */ }
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
    return;
  }
  if (req.method === 'GET' && pages[pagePath]) {
    serveFile(res, pages[pagePath], NOINDEX_PAGES.has(pagePath) ? { 'X-Robots-Tag': 'noindex, nofollow' } : null);
    return;
  }

  // Every storefront shares one page (storefront.html); the page itself
  // reads the slug from the URL and fetches that seller's data.
  if (req.method === 'GET' && req.url.startsWith('/store/')) {
    let slug = '';
    try { slug = decodeURIComponent(pagePath.slice(7).replace(/\/+$/, '')); } catch (e) {}
    serveStorefront(res, slug);
    return;
  }

  // ---------- PUBLIC STOREFRONT ----------
  if (req.method === 'GET' && req.url.startsWith('/api/store-info')) {
    const slug = new URLSearchParams(req.url.split('?')[1] || '').get('slug');
    const sellers = readJSON('sellers.json');
    const seller = sellers.find(s => s.storeSlug === slug);
    if (!seller || seller.suspended) return sendJSON(res, { ok: false, message: 'Store not found.' });

    const products = readJSON('products.json').filter(p => p.sellerEmail === seller.email);
    const reviews = readJSON('reviews.json');
    const withRatings = products.map(p => {
      const productReviews = reviews.filter(r => r.productId === p.id);
      const avg = productReviews.length
        ? productReviews.reduce((s, r) => s + r.rating, 0) / productReviews.length
        : null;
      return { ...p, avgRating: avg, reviewCount: productReviews.length };
    });

    const sellerVerified = !!(seller.verification && seller.verification.identityStatus === 'Verified');
    sendJSON(res, {
      ok: true,
      store: {
        businessName: seller.businessName,
        storeSlug: seller.storeSlug,
        category: seller.category,
        state: seller.state,
        city: seller.city,
        logoImage: seller.logoImage || null,
        coverImage: seller.coverImage || null,
        sellerVerified
      },
      products: withRatings
    });
    return;
  }

  // ---------- SELLER: STORE PROFILE (logo + cover photo) ----------
  if (req.method === 'POST' && req.url === '/api/seller/store-profile') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ logoImage, coverImage }) => {
      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === session.email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });

      if (logoImage) seller.logoImage = logoImage;
      if (coverImage) seller.coverImage = coverImage;

      writeJSON('sellers.json', sellers);
      sendJSON(res, { ok: true, message: 'Store profile updated!' });
    });
    return;
  }

  // ================= ADMIN DASHBOARD =================

  if (req.method === 'POST' && req.url === '/api/admin/login') {
    if (tooMany(req, res, 'adminlogin', 10, 15 * 60 * 1000)) return;
    readBody(req).then(({ password }) => {
      const { adminPassword } = getSettings();
      const a = crypto.createHash('sha256').update(String(password || '')).digest();
      const b = crypto.createHash('sha256').update(String(adminPassword || '')).digest();
      if (!crypto.timingSafeEqual(a, b)) {
        return sendJSON(res, { ok: false, message: 'Incorrect password.' });
      }
      const token = createSession('admin', 'admin');
      sendJSON(res, { ok: true, token });
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/admin/stats') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const sellers = readJSON('sellers.json');
    const customers = readJSON('customers.json');
    const orders = readJSON('orders.json');
    const withdrawals = readJSON('withdrawals.json');
    const disputes = readJSON('disputes.json');

    const totalRevenue = getPlatformRevenue();
    // Money sitting in sellers' SellHub wallets that hasn't been withdrawn
    // yet. It lives in the SAME real bank account as your own platform
    // revenue — this number is how much of that real balance is NOT yours
    // to spend, because it's still owed to sellers.
    const totalOwedToSellers = sellers.reduce((sum, s) => sum + (s.walletBalance || 0), 0);
    const pendingWithdrawals = withdrawals.filter(w => w.status === 'Pending').length;
    const pendingVerifications = sellers.filter(s => {
      const v = s.verification || {};
      return v.identityStatus === 'Pending review' || v.bankStatus === 'Pending review' || v.businessStatus === 'Pending review';
    }).length;
    const openDisputes = disputes.filter(d => d.status !== 'Resolved').length;

    sendJSON(res, {
      ok: true,
      totalSellers: sellers.length,
      totalCustomers: customers.length,
      totalOrders: orders.length,
      totalRevenue,
      totalOwedToSellers,
      pendingWithdrawals,
      pendingVerifications,
      openDisputes
    });
    return;
  }

  // ---------- ADMIN: PLATFORM WALLET ----------
  // The platform's "balance" is every service fee ever earned, minus
  // whatever the admin has already withdrawn out to their own bank account.
  if (req.method === 'GET' && req.url === '/api/admin/wallet') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const adminWithdrawals = readJSON('admin-withdrawals.json');

    const totalRevenue = getPlatformRevenue();
    const totalWithdrawn = adminWithdrawals.reduce((sum, w) => sum + w.amount, 0);
    const balance = totalRevenue - totalWithdrawn;

    sendJSON(res, { ok: true, balance, totalRevenue, totalWithdrawn, transactions: adminWithdrawals.slice().reverse() });
    return;
  }

  // Wipes old/demo withdrawal records so the Platform Wallet balance stops
  // counting their fees. Does not touch real orders, products, or seller
  // accounts — only the withdrawal request list. Gated behind the same PIN
  // as moving real money, since it changes the revenue the dashboard shows.
  if (req.method === 'POST' && req.url === '/api/admin/withdrawals/clear-demo') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    readBody(req).then(({ pin }) => {
      const { withdrawalPin } = getSettings();
      if (!pin || pin !== withdrawalPin) {
        return sendJSON(res, { ok: false, message: 'Incorrect withdrawal PIN.' });
      }
      writeJSON('withdrawals.json', []);
      sendJSON(res, { ok: true, message: 'Cleared. Seller withdrawal history and the Platform Wallet are back to zero.' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/admin/withdraw') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    readBody(req).then(async ({ amount, bank, bankCode, accountNumber, accountName, pin }) => {
      amount = Number(amount);
      if (!amount || amount <= 0) return sendJSON(res, { ok: false, message: 'Enter a valid amount.' });
      if (!bank || !bankCode || !accountNumber || !accountName) {
        return sendJSON(res, { ok: false, message: 'Please select your bank and verify your account first.' });
      }
      // A second, separate check just for moving money out — even inside an
      // already-logged-in admin session, so a browser left open (or a
      // stolen session) still can't withdraw funds without this PIN.
      const { withdrawalPin } = getSettings();
      if (!pin || pin !== withdrawalPin) {
        return sendJSON(res, { ok: false, message: 'Incorrect withdrawal PIN.' });
      }

      const adminWithdrawals = readJSON('admin-withdrawals.json');
      const totalRevenue = getPlatformRevenue();
      const totalWithdrawn = adminWithdrawals
        .filter(w => w.status !== 'Failed')
        .reduce((sum, w) => sum + w.amount, 0);
      const balance = totalRevenue - totalWithdrawn;

      if (amount > balance) {
        return sendJSON(res, { ok: false, message: 'Amount exceeds available platform balance.' });
      }

      const withdrawal = {
        id: Date.now(),
        amount, bank, bankCode, accountNumber, accountName,
        status: 'Processing',
        date: new Date().toISOString()
      };

      // Send the money for real, right now, via Paystack. Nothing is saved
      // to admin-withdrawals.json unless the transfer actually starts, so a
      // failed attempt never looks like money that left the account.
      try {
        const recipientCode = await createTransferRecipient(accountName, accountNumber, bankCode);
        const reference = `admin-wd-${withdrawal.id}`;
        const transfer = await initiateTransfer(amount, recipientCode, 'SellHub admin withdrawal', reference);
        withdrawal.transferCode = transfer.transfer_code;
        withdrawal.transferReference = reference;
        if (transfer.status === 'otp') withdrawal.needsOtp = true;

        adminWithdrawals.push(withdrawal);
        writeJSON('admin-withdrawals.json', adminWithdrawals);

        sendJSON(res, {
          ok: true,
          message: transfer.status === 'otp'
            ? 'Transfer started — Paystack sent an OTP to finish it. Enter it below to complete the payout.'
            : 'Transfer sent! It will show as Paid once Paystack confirms it (usually under a minute).',
          balance: balance - amount,
          withdrawal
        });
      } catch (err) {
        sendJSON(res, { ok: false, message: 'Transfer failed to start: ' + err.message + '. Nothing was withdrawn — check your Paystack balance and bank details, then try again.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/admin/transfers/finalize-otp') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    readBody(req).then(({ transferCode, otp }) => {
      if (!transferCode || !otp) return sendJSON(res, { ok: false, message: 'Enter the OTP Paystack sent you.' });
      paystackRequest('POST', '/transfer/finalize_transfer', { transfer_code: transferCode, otp })
        .then(() => sendJSON(res, { ok: true, message: 'OTP accepted — the transfer will confirm shortly.' }))
        .catch(err => sendJSON(res, { ok: false, message: err.message || 'Could not finalize that transfer.' }));
    });
    return;
  }

  // ---------- ADMIN: WITHDRAWALS ----------
  if (req.method === 'GET' && req.url === '/api/admin/withdrawals') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const withdrawals = readJSON('withdrawals.json');
    const sellers = readJSON('sellers.json');
    // Enriched with the seller's actual registration info (not just the
    // store name saved on the request at submit time) so the admin can see
    // exactly who they're paying — their real name, email and phone —
    // alongside the bank account details, before sending money manually.
    const withOrders = withdrawals.slice().reverse().map(w => {
      const seller = sellers.find(s => s.email === w.sellerEmail);
      return {
        ...w,
        sellerFullName: seller ? (seller.fullName || '') : '',
        sellerBusinessName: seller ? (seller.businessName || w.storeName || '') : w.storeName,
        sellerPhone: seller ? (seller.phone || seller.businessPhone || '') : '',
        sellerWhatsapp: seller ? (seller.whatsappNumber || '') : ''
      };
    });
    sendJSON(res, { ok: true, withdrawals: withOrders });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/admin/withdrawals/decide') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    readBody(req).then(async ({ id, decision, reason }) => {
      // Seller payouts are always manual now — SellHub/Paystack never moves
      // money to a seller automatically. Approving here only marks the
      // request as approved so you know to go pay the seller yourself
      // (their own bank app, or a manual transfer from your Paystack
      // dashboard) using the account details shown on the request.
      if (!['Approved', 'Rejected'].includes(decision)) {
        return sendJSON(res, { ok: false, message: 'Invalid decision.' });
      }
      const withdrawals = readJSON('withdrawals.json');
      const withdrawal = withdrawals.find(w => w.id === id);
      if (!withdrawal) return sendJSON(res, { ok: false, message: 'Withdrawal not found.' });
      if (withdrawal.status !== 'Pending') return sendJSON(res, { ok: false, message: 'This withdrawal was already decided.' });

      if (decision === 'Rejected') {
        reason = String(reason || '').trim().slice(0, 300);
        if (reason.length < 3) return sendJSON(res, { ok: false, message: 'Please give the seller a reason for rejecting this withdrawal.' });
        withdrawal.status = 'Rejected';
        withdrawal.rejectReason = reason;
        withdrawal.rejectedAt = new Date().toISOString();
        writeJSON('withdrawals.json', withdrawals);

        const sellers = readJSON('sellers.json');
        const seller = sellers.find(s => s.email === withdrawal.sellerEmail);
        if (seller) {
          const txn = (seller.transactions || []).find(t => t.type === 'withdrawal' && t.status === 'Pending' && t.amount === withdrawal.amount);
          if (txn) { txn.status = 'Rejected'; txn.reason = reason; }
          // A rejected withdrawal returns the held funds to the seller's
          // wallet (they were deducted up-front when the request was made).
          seller.walletBalance = (seller.walletBalance || 0) + withdrawal.amount;
          writeJSON('sellers.json', sellers);
        }
        notifySellerWithdrawal(seller, withdrawal, false);
        return sendJSON(res, { ok: true, message: 'Withdrawal rejected and refunded to the seller\'s wallet.' });
      }

      // decision === 'Approved': just marks it paid. YOU still have to
      // actually send the money yourself, using the bank details on the
      // request (account name/number/bank already shown in the dashboard).
      withdrawal.status = 'Approved';
      withdrawal.paidManually = true;
      writeJSON('withdrawals.json', withdrawals);

      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === withdrawal.sellerEmail);
      if (seller) {
        const txn = (seller.transactions || []).find(t => t.type === 'withdrawal' && t.status === 'Pending' && t.amount === withdrawal.amount);
        if (txn) txn.status = 'Approved';
        writeJSON('sellers.json', sellers);
      }
      notifySellerWithdrawal(seller, withdrawal, true);
      return sendJSON(res, { ok: true, message: 'Marked as approved & paid. Remember: SellHub did NOT send any money — make sure you actually transferred it to the seller yourself.' });
    });
    return;
  }

  // ---------- ADMIN: VERIFICATIONS ----------
  if (req.method === 'GET' && req.url === '/api/admin/verifications') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const sellers = readJSON('sellers.json');

    // Newest submission first, so an admin always sees what just came in at
    // the top instead of having to scroll past everything older.
    const latestOf = (...isoStrings) => Math.max(0, ...isoStrings.filter(Boolean).map(d => new Date(d).getTime()));

    const pending = sellers
      .filter(s => {
        const v = s.verification || {};
        return v.identityStatus === 'Pending review' || v.bankStatus === 'Pending review' || v.businessStatus === 'Pending review';
      })
      .map(s => ({
        email: s.email,
        businessName: s.businessName,
        verification: s.verification,
        _sortKey: latestOf(s.verification.identitySubmittedAt, s.verification.bankSubmittedAt, s.verification.businessSubmittedAt)
      }))
      .sort((a, b) => b._sortKey - a._sortKey)
      .map(({ _sortKey, ...rest }) => rest);

    // Once a submission is decided (Verified or Rejected) it drops out of the
    // "pending" list above, but the admin should still be able to pull up the
    // documents that were reviewed — this is the permanent record of that.
    const decided = sellers
      .filter(s => {
        const v = s.verification || {};
        return v.identityStatus === 'Verified' || v.identityStatus === 'Rejected'
          || v.bankStatus === 'Verified' || v.bankStatus === 'Rejected'
          || v.businessStatus === 'Verified' || v.businessStatus === 'Rejected';
      })
      .map(s => ({
        email: s.email,
        businessName: s.businessName,
        verification: s.verification,
        _sortKey: latestOf(
          s.verification.identityDecidedAt, s.verification.bankDecidedAt, s.verification.businessDecidedAt,
          // Older records decided before decision timestamps existed fall
          // back to their submission time, so they still sort sensibly.
          s.verification.identitySubmittedAt, s.verification.bankSubmittedAt, s.verification.businessSubmittedAt
        )
      }))
      .sort((a, b) => b._sortKey - a._sortKey)
      .map(({ _sortKey, ...rest }) => rest);

    sendJSON(res, { ok: true, sellers: pending, decidedSellers: decided });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/admin/verifications/decide') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    readBody(req).then(({ email, type, decision }) => {
      if (!['identity', 'bank', 'business'].includes(type)) {
        return sendJSON(res, { ok: false, message: 'Invalid verification type.' });
      }
      if (!['Verified', 'Rejected'].includes(decision)) {
        return sendJSON(res, { ok: false, message: 'Invalid decision.' });
      }
      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === email);
      if (!seller || !seller.verification) return sendJSON(res, { ok: false, message: 'Seller not found.' });

      seller.verification[`${type}Status`] = decision;
      seller.verification[`${type}DecidedAt`] = new Date().toISOString();
      writeJSON('sellers.json', sellers);

      {
        const TYPE_LABELS = { identity: 'Identity', bank: 'Bank account', business: 'Business (CAC)' };
        const label = TYPE_LABELS[type] || type;
        let message, subject;
        if (decision === 'Verified') {
          // Identity approval is the one that unlocks posting products, so it
          // gets the "your account is verified" message; bank/business get
          // their own specific one.
          message = type === 'identity'
            ? 'SellHub: Congratulations! Your seller account has been verified ✅ You can now start posting products and selling on SellHub.'
            : `SellHub: Good news! Your ${label} verification has been approved. ✅`;
          subject = type === 'identity' ? 'Your SellHub seller account is verified' : `Your ${label} verification was approved`;
        } else {
          message = `SellHub: Your ${label} verification could not be approved. Please open the Verification Center in your seller dashboard, check that your documents are clear and match your details, and submit again.`;
          subject = `Your ${label} verification needs attention`;
        }
        // WhatsApp number from store setup first, then business phone, then
        // the phone they signed up with — so a seller is never skipped just
        // because one of those is empty.
        const sellerPhone = seller.whatsappNumber || seller.businessPhone || seller.phone;
        if (!sellerPhone) {
          console.log('Verification WhatsApp skipped for', seller.email, '— no phone number on file.');
        } else {
          sendWhatsApp(sellerPhone, message)
            .then(result => {
              // sendWhatsApp never throws; it reports failure in the result.
              // Logged here so Render's logs show exactly why a seller
              // didn't get the message (bad number, WhatsApp provider limit, etc).
              if (!result.ok) console.log('Verification WhatsApp NOT delivered to', seller.email, '— reason:', result.reason);
            })
            .catch(err => console.log('WhatsApp error:', err.message));
        }

        // Same news by email too, so the seller still hears even if the
        // WhatsApp message doesn't get through.
        sendEmail(
          seller.email,
          subject,
          `<p>Hello ${seller.fullName || ''},</p><p>${message.replace(/^SellHub:\s*/, '')}</p>`
        ).catch(err => console.log('Email error (verification decision):', err.message));
      }

      sendJSON(res, { ok: true, message: `${type} ${decision.toLowerCase()}.` });
    });
    return;
  }

  // ---------- ADMIN: FULL SELLER DIRECTORY ----------
  // Gives admins the seller's complete registration profile in one place —
  // not just what was submitted for identity/bank/business verification,
  // but everything captured at signup and store onboarding (name, contact
  // numbers, address, store details). Document images are left out here
  // (they're already viewable in the Verifications tab) to keep this list
  // light even with many sellers.
  if (req.method === 'GET' && req.url === '/api/admin/sellers') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const sellers = readJSON('sellers.json');
    const list = sellers.map(s => {
      const v = s.verification || {};
      return {
        email: s.email,
        fullName: s.fullName || '',
        businessName: s.businessName || '',
        storeName: s.storeName || '',
        storeSlug: s.storeSlug || '',
        category: s.category || '',
        phone: s.phone || '',
        businessPhone: s.businessPhone || '',
        whatsappNumber: s.whatsappNumber || '',
        state: s.state || '',
        city: s.city || '',
        businessAddress: s.businessAddress || '',
        onboardingComplete: !!s.onboardingComplete,
        walletBalance: s.walletBalance || 0,
        suspended: !!s.suspended,
        warningCount: (s.warnings || []).length,
        identityStatus: v.identityStatus || 'Not submitted',
        bankStatus: v.bankStatus || 'Not submitted',
        businessStatus: v.businessStatus || 'Not submitted'
      };
    });
    // Newest-registered seller first, same convention as every other admin
    // list (withdrawals, disputes, verifications).
    sendJSON(res, { ok: true, sellers: list.reverse() });
    return;
  }

  // ---------- ADMIN: CUSTOMERS ----------
  // Everything a customer gave us at signup, plus a little activity so the admin can
  // see who is actually buying. Passwords (even hashed) are never sent.
  if (req.method === 'GET' && req.url === '/api/admin/customers') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const orders = readJSON('orders.json');
    const list = readJSON('customers.json').map(c => {
      const mine = orders.filter(o => o.customerEmail === c.email);
      const counted = mine.filter(o => o.status !== 'Cancelled');
      const last = mine.reduce((d, o) => (!d || o.date > d ? o.date : d), null);
      const addr = c.savedAddress || {};
      const deposits = (c.transactions || []).filter(t => t.type === 'deposit');
      const lastDeposit = deposits.reduce((d, t) => (!d || (t.date || '') > d ? t.date : d), null);
      return {
        email: c.email,
        totalDeposited: deposits.reduce((sum, t) => sum + (t.amount || 0), 0),
        depositCount: deposits.length,
        lastDepositAt: lastDeposit,
        fullName: c.fullName || '',
        phone: c.phone || '',
        joinedAt: c.createdAt || null,
        signedUpWith: c.signedUpWith || 'Email',
        walletBalance: c.walletBalance || 0,
        address: addr.address || '',
        state: addr.state || '',
        city: addr.city || '',
        deliveryPhone: addr.phone || '',
        orderCount: mine.length,
        totalSpent: counted.reduce((sum, o) => sum + (o.total || 0), 0),
        lastOrderAt: last
      };
    });
    // Newest signup first (customers.json is appended in signup order).
    sendJSON(res, { ok: true, customers: list.reverse() });
    return;
  }

  // ---------- UNSUBSCRIBE FROM REMINDERS ----------
  if (req.method === 'GET' && pagePath === '/unsubscribe') {
    const q = new URL(req.url, 'http://x').searchParams;
    const email = String(q.get('e') || '').toLowerCase(), token = String(q.get('t') || '');
    const page = (title, body) => { res.writeHead(200, { 'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex' });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:Arial,sans-serif;background:#eef7f1;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><div style="background:#fff;border-radius:20px;padding:32px;max-width:420px;margin:16px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.1)"><h2 style="color:#0b6b3a">${title}</h2><p style="color:#333;line-height:1.5">${body}</p><p><a href="/" style="color:#0b6b3a;font-weight:700">Go to SellHub</a></p></div>`); };
    let valid = false;
    try { valid = email && token.length === 32 && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(unsubToken(email))); } catch (e) {}
    if (!valid) { page('Link not valid', 'This unsubscribe link is not valid. Contact support@sellhubmarket.xyz and we will remove you.'); return; }
    const customers = readJSON('customers.json');
    const c = customers.find(x => String(x.email).toLowerCase() === email);
    if (!c) { page('Not found', 'We could not find that account.'); return; }
    const undo = q.get('undo') === '1';
    c.marketingOptOut = !undo;
    writeJSON('customers.json', customers);
    if (undo) page('You are subscribed again', 'You will get our Monday, Wednesday and Friday updates again.');
    else page('You are unsubscribed', `You will no longer get our shopping reminders. Order updates about your purchases will still reach you.<br><br><a href="${unsubLink(email)}&undo=1" style="color:#0b6b3a">Changed your mind? Subscribe again</a>`);
    return;
  }

  // ---------- ADMIN: CUSTOMER REMINDERS ----------
  if (req.method === 'GET' && req.url === '/api/admin/reminders') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const st = getSettings();
    const customers = readJSON('customers.json');
    sendJSON(res, { ok: true, enabled: REMINDERS_ON, schedule: 'Monday, Wednesday and Friday at 10:00 (Lagos time)', running: reminderRunning,
      customers: customers.length, optedOut: customers.filter(c => c.marketingOptOut).length, withPhone: customers.filter(c => !c.marketingOptOut && (c.phone || (c.savedAddress && c.savedAddress.phone))).length,
      lastRun: (st.reminderState && st.reminderState.lastRun) || null });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/admin/reminders/test') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    (async () => {
      const me = { email: ADMIN_EMAIL || 'admin@sellhubmarket.xyz', fullName: 'Admin', phone: ADMIN_WHATSAPP_PHONE };
      const msg = buildReminder(me, 0);
      let emailState = 'ADMIN_EMAIL is not set', waState = 'ADMIN_WHATSAPP_PHONE is not set';
      if (ADMIN_EMAIL) { try { await sendEmail(ADMIN_EMAIL, '[TEST] ' + msg.subject, msg.html); emailState = 'sent to ' + ADMIN_EMAIL; } catch (e) { emailState = 'failed: ' + e.message; } }
      if (ADMIN_WHATSAPP_PHONE) { const r = await sendWhatsApp(ADMIN_WHATSAPP_PHONE, msg.wa); waState = r.ok ? 'sent' : 'not sent (' + r.reason + ')'; }
      sendJSON(res, { ok: true, message: `Test reminder:\nEmail: ${emailState}\nWhatsApp: ${waState}` });
    })();
    return;
  }
  if (req.method === 'POST' && req.url === '/api/admin/reminders/send-now') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    if (reminderRunning) return sendJSON(res, { ok: false, message: 'A reminder run is already in progress.' });
    runCustomerReminders().catch(e => console.log('Reminder error:', e.message));
    sendJSON(res, { ok: true, message: 'Sending now to every customer who has not unsubscribed. You will get a WhatsApp summary when it is done.' });
    return;
  }

  // ---------- ADMIN: DATABASE STATUS ----------
  if (req.method === 'GET' && req.url === '/api/admin/db-status') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    sendJSON(res, Object.assign({ ok: true }, pgstore.status()));
    return;
  }

  // ---------- ADMIN: DOWNLOAD A BACKUP OF ALL DATA ----------
  if (req.method === 'GET' && req.url === '/api/admin/backup') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const bundle = { createdAt: new Date().toISOString(), files: {} };
    DATA_FILES.forEach(f => { try { bundle.files[f] = readJSON(f); } catch (e) {} });
    const body = JSON.stringify(bundle);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="sellhub-backup-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  // ---------- ADMIN: PRODUCT THUMBNAILS (one-time speed-up for older products) ----------
  if (req.method === 'POST' && req.url === '/api/admin/products/thumbs') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    readBody(req).then(({ id, thumbs }) => {
      const products = readJSON('products.json');
      const p = products.find(x => x.id === id);
      if (!p) return sendJSON(res, { ok: false, message: 'Product not found.' });
      const clean = cleanThumbs(thumbs, (p.images || []).filter(Boolean));
      if (!clean.length) return sendJSON(res, { ok: false, message: 'Thumbnails did not match the photos.' });
      p.thumbs = clean;
      writeJSON('products.json', products);
      sendJSON(res, { ok: true });
    });
    return;
  }

  // ---------- ADMIN: ORDERS (live monitor) ----------
  if (req.method === 'GET' && req.url === '/api/admin/orders') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const customers = readJSON('customers.json');
    const allSellers = readJSON('sellers.json');
    const allDisputes = readJSON('disputes.json');
    const orders = readJSON('orders.json').slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 500).map(o => {
      const c = customers.find(x => x.email === o.customerEmail);
      return {
        id: o.id, date: o.date, status: o.status || 'Order Received',
        customerName: o.fullName || (c && c.fullName) || '', customerEmail: o.customerEmail,
        customerPhone: o.phone || (c && c.phone) || '',
        address: o.address || '', city: o.city || '', state: o.state || '',
        subtotal: o.subtotal != null ? o.subtotal : o.total, serviceFee: o.serviceFee || 0, total: o.total || 0,
        reminders: (o.reminders || []).length, disputed: !!o.disputed,
        sellers: [...new Set((o.items || []).map(i => i.sellerEmail).filter(Boolean))].map(e => describeSeller(e, o.items, allSellers, allDisputes)),
        items: (o.items || []).map(i => ({ name: i.name, quantity: itemQty(i), price: i.effectivePrice || i.price, storeName: i.storeName || '', sellerEmail: i.sellerEmail }))
      };
    });
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const live = orders.filter(o => o.status !== 'Cancelled');
    const today = live.filter(o => new Date(o.date) >= startOfDay);
    sendJSON(res, { ok: true, orders, summary: {
      todayCount: today.length,
      todayValue: today.reduce((a, o) => a + o.total, 0),
      todayFees: today.reduce((a, o) => a + o.serviceFee, 0),
      totalCount: live.length,
      pending: live.filter(o => o.status !== 'Delivered').length
    } });
    return;
  }

  // ---------- ADMIN: REVIEWS & REMINDERS ----------
  // Every customer review and every "remind the seller" tap, each with the seller's
  // details so the admin can warn them straight away.
  if (req.method === 'GET' && req.url === '/api/admin/seller-activity') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const orders = readJSON('orders.json');
    const sellers = readJSON('sellers.json');
    const disputes = readJSON('disputes.json');
    const products = readJSON('products.json');

    const reviews = readJSON('reviews.json').map(r => {
      const order = orders.find(o => o.id === r.orderId);
      const items = order ? order.items || [] : [];
      const item = items.find(i => i.id === r.productId);
      const product = products.find(p => p.id === r.productId);
      const sellerEmail = (item && item.sellerEmail) || (product && product.sellerEmail) || null;
      return {
        orderId: r.orderId,
        productName: (item && item.name) || (product && product.name) || 'A product',
        rating: r.rating, text: r.text || '',
        customerName: r.customerName || '', customerEmail: r.customerEmail || '',
        date: r.date,
        sellers: sellerEmail ? [describeSeller(sellerEmail, items, sellers, disputes)] : []
      };
    }).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 300);

    const reminders = orders.filter(o => (o.reminders || []).length > 0).map(o => ({
      orderId: o.id, status: o.status, total: o.total || 0,
      customerName: o.fullName || '', customerEmail: o.customerEmail || '',
      orderDate: o.date,
      reminderCount: o.reminders.length,
      lastReminderAt: o.reminders[o.reminders.length - 1],
      sellers: [...new Set((o.items || []).map(i => i.sellerEmail))].map(e => describeSeller(e, o.items, sellers, disputes))
    })).sort((a, b) => String(b.lastReminderAt).localeCompare(String(a.lastReminderAt))).slice(0, 300);

    sendJSON(res, { ok: true, reviews, reminders });
    return;
  }

  // ---------- ADMIN: DISPUTES ----------
  if (req.method === 'GET' && req.url === '/api/admin/disputes') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const disputes = readJSON('disputes.json');
    const orders = readJSON('orders.json');
    const sellers = readJSON('sellers.json');

    const withOrders = disputes.map(d => {
      const order = orders.find(o => o.id === d.orderId) || null;
      // Show the admin exactly who they'd need to contact — the seller's
      // name, phone, email and bank details, plus how many disputes this
      // same seller has been named in (a pattern is more useful than a
      // single complaint when deciding whether to warn or suspend).
      const sellersInfo = (d.sellerEmails || []).map(email =>
        describeSeller(email, order ? order.items : [], sellers, disputes));
      return { ...d, order, sellersInfo };
    });

    sendJSON(res, { ok: true, disputes: withOrders.reverse() });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/admin/sellers/warn') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    readBody(req).then(async ({ email, message }) => {
      if (!message) return sendJSON(res, { ok: false, message: 'Please include a warning message.' });
      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Seller not found.' });

      seller.warnings = seller.warnings || [];
      seller.warnings.push({ id: Date.now(), message, date: new Date().toISOString(), seen: false });
      writeJSON('sellers.json', sellers);

      let emailOk = false;
      try {
        await sendEmail(
          email,
          'Warning from SellHub',
          `<p>Hello ${seller.fullName || ''},</p><p>${message}</p><p>Please take this seriously — repeated issues can lead to your account being suspended.</p>`
        );
        emailOk = true;
      } catch (err) { console.log('Email error:', err.message); }

      let waState = 'no WhatsApp number on file';
      const sellerPhone = seller.whatsappNumber || seller.businessPhone || seller.phone;
      if (sellerPhone) {
        const wa = await sendWhatsApp(sellerPhone, `SellHub warning: ${message}`);
        waState = wa.ok ? 'sent' : 'not sent (' + (wa.reason === 'not_configured' ? 'WhatsApp is not set up' : wa.reason === 'bad_number' ? 'the number is not valid' : wa.reason) + ')';
      }

      sendJSON(res, { ok: true, message: `Warning saved on the seller's account.\nEmail: ${emailOk ? 'sent' : 'not sent'}\nWhatsApp: ${waState}` });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/admin/sellers/suspend') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    readBody(req).then(async ({ email, suspended, reason }) => {
      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Seller not found.' });

      seller.suspended = !!suspended;
      if (suspended) seller.suspendReason = reason || '';
      writeJSON('sellers.json', sellers);

      try {
        await sendEmail(
          email,
          suspended ? 'Your SellHub seller account has been suspended' : 'Your SellHub seller account has been reinstated',
          suspended
            ? `<p>Hello ${seller.fullName || ''},</p><p>Your seller account has been suspended.${reason ? ' Reason: ' + reason : ''}</p><p>Contact support if you believe this is a mistake.</p>`
            : `<p>Hello ${seller.fullName || ''},</p><p>Your seller account has been reinstated. You can log back in and continue selling.</p>`
        );
      } catch (err) { console.log('Email error:', err.message); }

      const sellerPhone = seller.whatsappNumber || seller.businessPhone;
      if (sellerPhone) {
        const waMessage = suspended
          ? `SellHub: Your seller account has been suspended.${reason ? ' Reason: ' + reason : ''} Contact support if you believe this is a mistake.`
          : `SellHub: Your seller account has been reinstated. You can log back in and continue selling.`;
        sendWhatsApp(sellerPhone, waMessage).catch(err => console.log('WhatsApp error:', err.message));
      }

      sendJSON(res, { ok: true, message: suspended ? 'Seller suspended.' : 'Seller reinstated.' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/admin/disputes/resolve') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    readBody(req).then(({ id, resolution }) => {
      const disputes = readJSON('disputes.json');
      const dispute = disputes.find(d => d.id === id);
      if (!dispute) return sendJSON(res, { ok: false, message: 'Dispute not found.' });

      dispute.status = 'Resolved';
      dispute.resolution = resolution || '';
      dispute.resolvedAt = new Date().toISOString();
      writeJSON('disputes.json', disputes);
      sendJSON(res, { ok: true, message: 'Dispute marked as resolved.' });
    });
    return;
  }

  // ---------- PRODUCTS ----------
  if (req.method === 'GET' && req.url === '/api/products') {
    const products = readJSON('products.json');
    const reviews = readJSON('reviews.json');
    const sellers = readJSON('sellers.json');
    const withRatings = products
      // A suspended seller's storefront and listings disappear from
      // customer view immediately — no separate step needed.
      .filter(p => {
        const seller = sellers.find(s => s.email === p.sellerEmail);
        return !(seller && seller.suspended);
      })
      .map(p => {
        const productReviews = reviews.filter(r => r.productId === p.id);
        const avg = productReviews.length
          ? productReviews.reduce((s, r) => s + r.rating, 0) / productReviews.length
          : null;
        // A seller only counts as "Verified" once an admin has approved their
        // identity — phone verification alone (automatic at signup) isn't enough.
        const seller = sellers.find(s => s.email === p.sellerEmail);
        const sellerVerified = !!(seller && seller.verification && seller.verification.identityStatus === 'Verified');
        const { views, ...publicProduct } = p; // view counts are for the seller only
        return { ...publicProduct, avgRating: avg, reviewCount: productReviews.length, sellerVerified,
          sellerState: (seller && seller.state) || '', sellerCity: (seller && seller.city) || '' };
      });
    return sendJSON(res, { ok: true, products: withRatings });
  }

  // ---------- ADMIN: DELETE SELLER PERMANENTLY ----------
  // Removes the seller's account and everything that belongs only to them
  // (profile, ID/selfie/CAC photos, store images, products, product reviews,
  // notifications, login sessions, pending codes) so the same email can sign
  // up again from scratch. Order, payout and dispute records stay because they
  // are customer and money history, but they are detached from the email so a
  // fresh account never inherits them.
  if (req.method === 'POST' && req.url === '/api/admin/sellers/delete') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    readBody(req).then((body) => {
      const email = normalizeEmail(body.email);
      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Seller not found.' });
      if (normalizeEmail(body.confirmEmail) !== email) {
        return sendJSON(res, { ok: false, message: 'Type the seller\'s email exactly to confirm.' });
      }

      const orders = readJSON('orders.json');
      const withdrawals = readJSON('withdrawals.json');
      const openOrders = orders.filter(o => o.status !== 'Delivered' && o.status !== 'Cancelled' &&
        (o.items || []).some(i => i.sellerEmail === email));
      const openPayouts = withdrawals.filter(w => w.sellerEmail === email && (w.status === 'Pending' || w.status === 'Processing'));
      if (!body.force) {
        const warnings = [];
        if (seller.walletBalance > 0) warnings.push(`Their wallet still holds ₦${Number(seller.walletBalance).toLocaleString()}, which will be erased.`);
        if (openOrders.length) warnings.push(`${openOrders.length} order(s) from this seller are not delivered or cancelled yet.`);
        if (openPayouts.length) warnings.push(`${openPayouts.length} withdrawal request(s) are still pending or processing.`);
        if (warnings.length) return sendJSON(res, { ok: false, needsConfirm: true, warnings });
      }

      const products = readJSON('products.json');
      const myProductIds = new Set(products.filter(p => p.sellerEmail === email).map(p => p.id));

      // Every photo file this seller owned (profile + their products).
      const blobRe = /\/blob\/[a-f0-9]{48}\.(?:jpg|png|webp|gif|pdf)/g;
      const ownedBlobs = new Set(
        (JSON.stringify(seller) + JSON.stringify(products.filter(p => p.sellerEmail === email))).match(blobRe) || []
      );

      // Remove the seller's own records.
      writeJSON('sellers.json', sellers.filter(s => s.email !== email));
      writeJSON('products.json', products.filter(p => p.sellerEmail !== email));
      writeJSON('reviews.json', readJSON('reviews.json').filter(r => !myProductIds.has(r.productId)));
      writeJSON('seller-notifications.json', readJSON('seller-notifications.json').filter(n => n.sellerEmail !== email));

      // Keep order / payout / dispute history, but detach it from this email.
      const tombstone = `deleted-seller-${crypto.randomBytes(4).toString('hex')}@deleted.invalid`;
      for (const file of ['orders.json', 'withdrawals.json', 'admin-withdrawals.json', 'disputes.json']) {
        const raw = JSON.stringify(readJSON(file));
        const detached = raw.split(JSON.stringify(email)).join(JSON.stringify(tombstone));
        if (detached !== raw) writeJSON(file, JSON.parse(detached));
      }

      // Log them out everywhere and drop any half-finished signup / reset codes.
      for (const [key, sess] of Object.entries(sessions)) {
        if (sess.email === email && sess.accountType === 'seller') delete sessions[key];
      }
      saveSessions();
      // Write right now (not on the usual 1s delay) so an old login token can
      // never come back after a restart and work on a re-registered account.
      try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); } catch (e) { console.log('Could not save sessions:', e.message); }
      delete pendingSellerSignups[email];
      delete resetCodes[email];
      persistCodeState();

      // Delete photo files — but never one that another record still points to.
      let stillUsed = '';
      for (const file of DATA_FILES) { try { stillUsed += JSON.stringify(readJSON(file)); } catch (e) {} }
      let filesRemoved = 0;
      for (const url of ownedBlobs) {
        if (stillUsed.includes(url)) continue;
        pgstore.deleteBlob(path.basename(url)); try { fs.unlinkSync(path.join(BLOB_DIR, path.basename(url))); filesRemoved++; } catch (e) {}
      }

      console.log(`Admin ${session.email} permanently deleted seller ${email} (${myProductIds.size} products, ${filesRemoved} photo files).`);
      sendJSON(res, { ok: true, message: `Seller deleted permanently. They can register again with ${email}.` });
    }).catch(() => sendJSON(res, { ok: false, message: 'Could not delete the seller.' }));
    return;
  }

  // Counts one view of a product (called when a shopper opens it).
  if (req.method === 'POST' && req.url === '/api/products/view') {
    readBody(req).then((body) => {
      const id = Number(body.id);
      const products = readJSON('products.json');
      const product = products.find(p => p.id === id);
      if (!product) return sendJSON(res, { ok: false });
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const key = ip + '|' + id;
      if (Date.now() - (recentViewers.get(key) || 0) > VIEW_DEDUPE_MS) {
        recentViewers.set(key, Date.now());
        product.views = (product.views || 0) + 1;
        writeJSON('products.json', products);
      }
      sendJSON(res, { ok: true, views: product.views || 0 });
    }).catch(() => sendJSON(res, { ok: false }));
    return;
  }

  // ---------- FEE INFO (public — just the percentage, for display before checkout) ----------
  if (req.method === 'GET' && req.url === '/api/fee-info') {
    const { customerServiceFeePercent } = getSettings();
    return sendJSON(res, { ok: true, customerServiceFeePercent });
  }

  // ---------- SAVED ADDRESS ----------
  if (req.method === 'POST' && req.url === '/api/save-address') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    readBody(req).then(({ address, state, city, phone }) => {
      const customers = readJSON('customers.json');
      const customer = customers.find(c => c.email === session.email);
      if (!customer) return sendJSON(res, { ok: false, message: 'Account not found.' });
      customer.savedAddress = { address, state, city, phone };
      writeJSON('customers.json', customers);
      sendJSON(res, { ok: true, message: 'Address saved.' });
    });
    return;
  }

  // ---------- PAYSTACK: RECHECK MY PENDING PAYMENTS ----------
  // Safety net for a customer who paid but closed the tab before coming back
  // (and for when the webhook can't reach us, e.g. while testing on localhost).
  // Only ever looks at THIS customer's own recent pending payments.
  if (req.method === 'POST' && req.url === '/api/paystack/recheck') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    (async () => {
      let credited = 0;
      if (PAYSTACK_SECRET_KEY) {
        const cutoff = Date.now() - 48 * 60 * 60 * 1000;
        const mine = readPayments()
          .filter(p => p.email === session.email && p.status === 'pending' && new Date(p.createdAt).getTime() > cutoff)
          .slice(-5);
        for (const p of mine) {
          try {
            const tx = await paystackRequest('GET', '/transaction/verify/' + encodeURIComponent(p.reference));
            const result = creditPaystackPayment(p.reference, tx);
            if (result.ok && !result.alreadyCredited) credited++;
          } catch (err) { /* not paid yet, or Paystack unreachable — try again next time */ }
        }
      }
      sendJSON(res, { ok: true, credited });
    })();
    return;
  }

  // ---------- WALLET ----------
  if (req.method === 'GET' && req.url.startsWith('/api/wallet')) {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    const customers = readJSON('customers.json');
    const customer = customers.find(c => c.email === session.email);
    if (!customer) return sendJSON(res, { ok: false, message: 'Account not found.' });
    return sendJSON(res, {
      ok: true,
      balance: customer.walletBalance || 0,
      transactions: customer.transactions || []
    });
  }

  // The old demo deposit let anyone add any amount for free. It is switched
  // off permanently — money can now only enter a wallet through Paystack.
  if (req.method === 'POST' && req.url === '/api/deposit') {
    return sendJSON(res, { ok: false, message: 'Please use the Add Money button to pay securely with Paystack.' }, 403);
  }

  // ---------- PAYSTACK: HOW MUCH WILL THIS DEPOSIT COST? ----------
  // Lets the wallet screen show "you pay ₦5,178 (₦5,000 + ₦178 fee)" before
  // the customer commits. The server always recalculates the real amount itself.
  if (req.method === 'GET' && req.url.startsWith('/api/paystack/quote')) {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    const amount = Math.floor(Number(new URLSearchParams(req.url.split('?')[1] || '').get('amount')));
    if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_NAIRA || amount > MAX_DEPOSIT_NAIRA) {
      return sendJSON(res, { ok: false, message: 'Enter an amount between ₦' + MIN_DEPOSIT_NAIRA + ' and ₦' + MAX_DEPOSIT_NAIRA.toLocaleString() + '.' });
    }
    return sendJSON(res, Object.assign({ ok: true }, depositQuote(amount)));
  }

  // ---------- PAYSTACK: START A DEPOSIT ----------
  if (req.method === 'POST' && req.url === '/api/paystack/initialize') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    readBody(req).then(async ({ amount }) => {
      if (!PAYSTACK_SECRET_KEY) {
        return sendJSON(res, { ok: false, message: 'Payments are not switched on yet. Please contact support.' });
      }
      amount = Math.floor(Number(amount)); // whole naira only
      if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_NAIRA || amount > MAX_DEPOSIT_NAIRA) {
        return sendJSON(res, { ok: false, message: 'Enter an amount between ₦' + MIN_DEPOSIT_NAIRA + ' and ₦' + MAX_DEPOSIT_NAIRA.toLocaleString() + '.' });
      }
      const customers = readJSON('customers.json');
      const customer = customers.find(c => c.email === session.email);
      if (!customer) return sendJSON(res, { ok: false, message: 'Account not found.' });

      const reference = 'SH_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');
      const quote = depositQuote(amount); // { amount, fee, total }

      // Save the pending payment BEFORE contacting Paystack, so a webhook can
      // always find it — even if the customer closes their browser mid-payment.
      const payments = readPayments();
      payments.push({ reference, email: customer.email, amount, fee: quote.fee, total: quote.total, status: 'pending', createdAt: new Date().toISOString() });
      writeJSON('payments.json', payments);

      try {
        const data = await paystackRequest('POST', '/transaction/initialize', {
          email: customer.email,
          amount: quote.total * 100, // Paystack wants kobo; the customer pays deposit + fee
          currency: 'NGN',
          reference,
          callback_url: APP_BASE_URL + '/api/paystack/callback',
          metadata: { purpose: 'wallet_deposit', wallet_amount: amount, paystack_fee: quote.fee }
        });
        sendJSON(res, { ok: true, authorizationUrl: data.authorization_url, reference, amount, fee: quote.fee, total: quote.total });
      } catch (err) {
        console.error('Paystack initialize failed:', err.message);
        sendJSON(res, { ok: false, message: 'Could not start the payment. Please try again.' });
      }
    }).catch(() => sendJSON(res, { ok: false, message: 'Invalid request.' }));
    return;
  }

  // ---------- PAYSTACK: CUSTOMER COMES BACK AFTER PAYING ----------
  // Paystack sends the browser here. We never trust the browser's word that
  // it paid — we ask Paystack directly, then credit the wallet.
  if (req.method === 'GET' && req.url.startsWith('/api/paystack/callback')) {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const reference = params.get('reference') || params.get('trxref');
    (async () => {
      let outcome = 'failed';
      try {
        if (reference && PAYSTACK_SECRET_KEY) {
          const tx = await paystackRequest('GET', '/transaction/verify/' + encodeURIComponent(reference));
          const result = creditPaystackPayment(reference, tx);
          if (result.ok) outcome = 'success';
          else if (tx.status === 'abandoned') outcome = 'cancelled';
          else if (['ongoing', 'pending', 'processing', 'queued'].includes(tx.status)) outcome = 'pending';
        }
      } catch (err) {
        console.error('Paystack callback verify failed:', err.message);
      }
      res.writeHead(302, { Location: '/dashboard?deposit=' + outcome });
      res.end();
    })();
    return;
  }

  // ---------- PAYSTACK: WEBHOOK (Paystack tells our server directly) ----------
  // Backup for when a customer pays but closes the browser before returning.
  // Needs a public https address to work; on localhost the callback above does the job.
  if (req.method === 'POST' && req.url === '/api/paystack/webhook') {
    readRawBody(req).then(async (raw) => {
      const signature = String(req.headers['x-paystack-signature'] || '');
      const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY || 'unset').update(raw).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (!PAYSTACK_SECRET_KEY || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.writeHead(401); res.end(); return;
      }
      let event;
      try { event = JSON.parse(raw.toString('utf8')); }
      catch (e) { res.writeHead(400); res.end(); return; }

      if (event.event === 'charge.success' && event.data && event.data.reference) {
        try {
          const tx = await paystackRequest('GET', '/transaction/verify/' + encodeURIComponent(event.data.reference));
          creditPaystackPayment(event.data.reference, tx);
        } catch (err) {
          console.error('Paystack webhook verify failed:', err.message);
          res.writeHead(500); res.end(); return; // non-200 makes Paystack retry later
        }
      } else if (
        ['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event.event) &&
        event.data && event.data.reference
      ) {
        try {
          handleTransferWebhook(event.event, event.data.reference, event.data.reason || (event.data.failures && event.data.failures.reason));
        } catch (err) {
          console.error('Paystack transfer webhook handling failed:', err.message);
          res.writeHead(500); res.end(); return;
        }
      }
      res.writeHead(200); res.end();
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }

  // ---------- CHECKOUT ----------
  if (req.method === 'POST' && req.url === '/api/checkout') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    readBody(req).then(async (form) => {
      const { fullName, phone, deliveryEmail, address, state, city, instructions, saveAddress } = form;
      // New carts send [{id, quantity}]; older ones sent a plain list of ids (1 each).
      let wanted = Array.isArray(form.cartItems) ? form.cartItems.map(x => ({ id: Number(x && x.id), quantity: Number(x && x.quantity) }))
        : (Array.isArray(form.cartIds) ? [...new Set(form.cartIds.map(Number))].map(id => ({ id, quantity: 1 })) : []);
      const qtyById = {};
      for (const w of wanted) {
        if (!Number.isFinite(w.id)) continue;
        if (!Number.isInteger(w.quantity) || w.quantity < 1) return sendJSON(res, { ok: false, message: 'Quantity must be a whole number of at least 1.' });
        qtyById[w.id] = (qtyById[w.id] || 0) + w.quantity;
      }
      const cartIds = Object.keys(qtyById).map(Number);
      const customers = readJSON('customers.json');
      const products = readJSON('products.json');
      const customer = customers.find(c => c.email === session.email);
      if (!customer) return sendJSON(res, { ok: false, message: 'Account not found.' });

      const items = products.filter(p => cartIds.includes(p.id));
      if (items.length === 0) return sendJSON(res, { ok: false, message: 'Your cart is empty.' });

      const outOfStock = items.find(p => p.status === 'Out of Stock');
      if (outOfStock) return sendJSON(res, { ok: false, message: `"${outOfStock.name}" is out of stock.` });

      // Snapshot each item's actual charged price (the discount price when one
      // is set) so every later step — wallet crediting, order display —
      // reads from the same number instead of recomputing it differently.
      // Never let a customer buy more units than the seller has in stock.
      for (const p of items) {
        const q = qtyById[p.id];
        if (typeof p.stock === 'number' && q > p.stock) {
          return sendJSON(res, { ok: false, message: p.stock > 0 ? `Only ${p.stock} of "${p.name}" left in stock. Please lower the quantity.` : `"${p.name}" is out of stock.` });
        }
        if (q > 99) return sendJSON(res, { ok: false, message: 'You can buy up to 99 of one product per order.' });
      }
      const orderItems = items.map(p => ({ ...p, quantity: qtyById[p.id], effectivePrice: p.discountPrice || p.price }));

      // Fees are computed server-side, never trusted from the client.
      const { customerServiceFeePercent } = getSettings();
      const subtotal = orderItems.reduce((sum, p) => sum + p.effectivePrice * p.quantity, 0);
      const serviceFee = Math.round(subtotal * (customerServiceFeePercent / 100));
      const total = subtotal + serviceFee;

      if ((customer.walletBalance || 0) < total) {
        return sendJSON(res, { ok: false, message: 'Insufficient wallet balance. Please deposit more funds.' });
      }

      customer.walletBalance -= total;
      customer.transactions = customer.transactions || [];
      customer.transactions.unshift({
        type: 'purchase', amount: total, subtotal, serviceFee, date: new Date().toISOString()
      });
      if (saveAddress) customer.savedAddress = { address, state, city, phone };
      writeJSON('customers.json', customers);

      // Each purchase takes the bought quantity out of stock; a product that hits zero
      // flips to Out of Stock automatically for every future shopper.
      orderItems.forEach(item => {
        const stocked = products.find(p => p.id === item.id);
        if (stocked && typeof stocked.stock === 'number') {
          stocked.stock = Math.max(0, stocked.stock - item.quantity);
          stocked.status = stocked.stock > 0 ? 'In Stock' : 'Out of Stock';
        }
      });
      writeJSON('products.json', products);

      const orders = readJSON('orders.json');
      const order = {
        id: Date.now(),
        customerEmail: session.email,
        fullName, phone, deliveryEmail, address, state, city, instructions,
        items: orderItems, subtotal, serviceFee, serviceFeePercent: customerServiceFeePercent, total,
        status: 'Order Received',
        date: new Date().toISOString(),
        reminders: []
      };
      orders.push(order);
      writeJSON('orders.json', orders);
      creditSellersForOrder(order);
      notifyOrderStatus(order, 'Order Received');
      notifySellerNewOrder(order);

      // Tell the admin straight away (WhatsApp + email) that someone just bought something.
      try {
        const names = orderItems.map(itemLabel).join(', ');
        const sellerList = readJSON('sellers.json');
        const stores = [...new Set(orderItems.map(i => i.sellerEmail).filter(Boolean))].map(e => {
          const sl = sellerList.find(x => x.email === e);
          if (!sl) return e;
          return `${sl.storeName || sl.businessName} — ${sl.fullName || ''}, ${sl.whatsappNumber || sl.businessPhone || sl.phone || 'no phone'}${sl.state ? ', ' + [sl.city, sl.state].filter(Boolean).join(', ') : ''}`;
        }).join('; ');
        const where = [city, state].filter(Boolean).join(', ');
        notifyAdmin(`🛒 SellHub: NEW ORDER #${order.id}\nCustomer: ${fullName || customer.fullName} (${phone || customer.phone || 'no phone'})\nItems: ${names}\nSeller: ${stores || 'n/a'}\nTotal: ₦${total.toLocaleString()} (your fee ₦${serviceFee.toLocaleString()})${where ? '\nDeliver to: ' + where : ''}`);
      } catch (e) { console.log('Admin order alert error:', e.message); }

      sendJSON(res, { ok: true, message: '✅ Order placed successfully!', order });
    }).catch(err => { console.log('ERROR:', err.message); sendJSON(res, { ok: false, message: 'Checkout failed.' }); });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/orders')) {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    const orders = readJSON('orders.json').filter(o => o.customerEmail === session.email);
    return sendJSON(res, { ok: true, orders });
  }

  // ---------- NOTIFICATIONS ----------
  if (req.method === 'GET' && req.url === '/api/notifications') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    const notifications = readJSON('notifications.json').filter(n => n.customerEmail === session.email);
    return sendJSON(res, { ok: true, notifications });
  }

  if (req.method === 'POST' && req.url === '/api/notifications/mark-read') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    readBody(req).then(({ notificationId }) => {
      const notifications = readJSON('notifications.json');
      // notificationId omitted → mark everything read (used by the bell "mark all read").
      let changed = false;
      notifications.forEach(n => {
        if (n.customerEmail !== session.email) return;
        if (notificationId && n.id !== notificationId) return;
        if (!n.read) { n.read = true; changed = true; }
      });
      if (changed) writeJSON('notifications.json', notifications);
      sendJSON(res, { ok: true });
    });
    return;
  }

  // ---------- PROFILE ----------
  if (req.method === 'GET' && req.url === '/api/profile') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    const customers = readJSON('customers.json');
    const customer = customers.find(c => c.email === session.email);
    if (!customer) return sendJSON(res, { ok: false, message: 'Account not found.' });
    return sendJSON(res, {
      ok: true,
      fullName: customer.fullName || '',
      email: customer.email,
      phone: customer.phone || '',
      savedAddress: customer.savedAddress || null
    });
  }

  // Lets a customer update the personal details they gave at signup (full
  // name, phone) and keeps their saved delivery address in sync with it, so
  // the "Profile" tab and the checkout address autofill never drift apart.
  // Email is left out on purpose — it's the account's login identity.
  if (req.method === 'POST' && req.url === '/api/profile/update') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    readBody(req).then(({ fullName, phone, address, state, city }) => {
      if (!fullName || !fullName.trim()) {
        return sendJSON(res, { ok: false, message: 'Full name is required.' });
      }
      const customers = readJSON('customers.json');
      const customer = customers.find(c => c.email === session.email);
      if (!customer) return sendJSON(res, { ok: false, message: 'Account not found.' });

      customer.fullName = fullName.trim();
      customer.phone = phone || '';
      customer.savedAddress = {
        address: address || '',
        state: state || '',
        city: city || '',
        phone: phone || ''
      };
      writeJSON('customers.json', customers);
      sendJSON(res, { ok: true, message: 'Profile updated.' });
    });
    return;
  }

  // ================= SELLER DASHBOARD =================

  // ---------- SELLER PROFILE ----------
  // Everything the seller gave us at signup and store onboarding, in one
  // place — mirrors what the admin dashboard's Sellers tab shows, just
  // scoped to the logged-in seller's own account.
  if (req.method === 'GET' && req.url === '/api/seller/profile') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    const sellers = readJSON('sellers.json');
    const seller = sellers.find(s => s.email === session.email);
    if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });
    return sendJSON(res, {
      ok: true,
      fullName: seller.fullName || '',
      businessName: seller.businessName || '',
      email: seller.email,
      phone: seller.phone || '',
      category: seller.category || '',
      storeName: seller.storeName || '',
      storeSlug: seller.storeSlug || '',
      businessPhone: seller.businessPhone || '',
      whatsappNumber: seller.whatsappNumber || '',
      state: seller.state || '',
      city: seller.city || '',
      businessAddress: seller.businessAddress || '',
      onboardingComplete: !!seller.onboardingComplete
    });
  }

  // Lets a seller keep their own registration details current. Store
  // identity (category, store name/slug) is deliberately left out here —
  // every product already carries its own copy of the store name/slug from
  // when it was listed, so renaming the store here would silently mismatch
  // existing listings. Those live in the onboarding/store-profile flow
  // instead, which the seller already uses deliberately for that.
  if (req.method === 'POST' && req.url === '/api/seller/profile/update') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ fullName, businessName, phone, businessPhone, whatsappNumber, state, city, businessAddress }) => {
      if (!fullName || !fullName.trim()) {
        return sendJSON(res, { ok: false, message: 'Full name is required.' });
      }
      if (!businessName || !businessName.trim()) {
        return sendJSON(res, { ok: false, message: 'Business name is required.' });
      }
      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === session.email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });

      seller.fullName = fullName.trim();
      seller.businessName = businessName.trim();
      if (phone !== undefined) seller.phone = phone;
      if (businessPhone !== undefined) seller.businessPhone = businessPhone;
      if (whatsappNumber !== undefined) seller.whatsappNumber = whatsappNumber;
      if (state !== undefined) seller.state = state;
      if (city !== undefined) seller.city = city;
      if (businessAddress !== undefined) seller.businessAddress = businessAddress;
      writeJSON('sellers.json', sellers);
      sendJSON(res, { ok: true, message: 'Profile updated.' });
    });
    return;
  }

  // ---------- SELLER ONBOARDING ----------
  if (req.method === 'GET' && req.url === '/api/seller/onboarding-status') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    const sellers = readJSON('sellers.json');
    const seller = sellers.find(s => s.email === session.email);
    if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });
    sendJSON(res, { ok: true, onboardingComplete: !!seller.onboardingComplete, storeSlug: seller.storeSlug || null });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/seller/onboarding') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ category, storeName, businessPhone, whatsappNumber, state, city, businessAddress }) => {
      if (!category || !storeName || !businessPhone || !whatsappNumber || !state || !city || !businessAddress) {
        return sendJSON(res, { ok: false, message: 'Please fill in every field.' });
      }

      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === session.email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });

      // Turn the store name into a URL-safe slug, and make sure it's unique.
      let baseSlug = storeName.toLowerCase().trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
      if (!baseSlug) baseSlug = 'store';

      let slug = baseSlug;
      let counter = 2;
      while (sellers.some(s => s.storeSlug === slug && s.email !== session.email)) {
        slug = `${baseSlug}-${counter}`;
        counter++;
      }

      seller.category = category;
      seller.storeName = storeName;
      seller.storeSlug = slug;
      seller.businessPhone = businessPhone;
      seller.whatsappNumber = whatsappNumber;
      seller.state = state;
      seller.city = city;
      seller.businessAddress = businessAddress;
      seller.onboardingComplete = true;

      writeJSON('sellers.json', sellers);
      sendJSON(res, { ok: true, message: 'Store created.', storeUrl: `sellhub.ng/store/${slug}` });
    });
    return;
  }

  // ---------- VERIFICATION CENTER ----------
  if (req.method === 'GET' && req.url === '/api/seller/verification-status') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    const sellers = readJSON('sellers.json');
    const seller = sellers.find(s => s.email === session.email);
    if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });
    const v = seller.verification || {};
    sendJSON(res, {
      ok: true,
      phone: 'Verified',
      identity: v.identityStatus || 'Not started',
      bank: v.bankStatus || 'Not started',
      business: v.businessStatus || 'Not started'
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/seller/verify-identity') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ legalName, dateOfBirth, idType, idNumber, idDocumentImage, selfieImage }) => {
      if (!legalName || !dateOfBirth || !idType || !idNumber) {
        return sendJSON(res, { ok: false, message: 'Please fill in every field.' });
      }
      if (!idDocumentImage || !selfieImage) {
        return sendJSON(res, { ok: false, message: 'Please capture both a photo of your ID and a selfie.' });
      }
      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === session.email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });

      seller.verification = seller.verification || {};
      seller.verification.legalName = legalName;
      seller.verification.dateOfBirth = dateOfBirth;
      seller.verification.idType = idType;
      seller.verification.idNumber = idNumber;
      seller.verification.idDocumentImage = idDocumentImage;
      seller.verification.selfieImage = selfieImage;
      seller.verification.identityStatus = 'Pending review';
      seller.verification.identitySubmittedAt = new Date().toISOString();

      writeJSON('sellers.json', sellers);
      notifyAdmin(`SellHub: New identity verification submitted by ${seller.businessName || seller.fullName || seller.email}. Review it in the admin dashboard.`);
      sendJSON(res, { ok: true, message: 'Submitted for review. This usually takes 1-2 business days.' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/seller/verify-bank') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ bankName, accountNumber, accountName }) => {
      if (!bankName || !accountNumber || !accountName) {
        return sendJSON(res, { ok: false, message: 'Please fill in every field.' });
      }
      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === session.email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });

      seller.verification = seller.verification || {};
      seller.verification.bankName = bankName;
      seller.verification.accountNumber = accountNumber;
      seller.verification.accountName = accountName;
      seller.verification.bankStatus = 'Pending review';
      seller.verification.bankSubmittedAt = new Date().toISOString();

      writeJSON('sellers.json', sellers);
      notifyAdmin(`SellHub: New bank verification submitted by ${seller.businessName || seller.fullName || seller.email}. Review it in the admin dashboard.`);
      sendJSON(res, { ok: true, message: 'Submitted for review. This usually takes 1-2 business days.' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/seller/verify-business') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ cacNumber, registeredBusinessName, cacDocumentImage }) => {
      if (!cacNumber || !registeredBusinessName) {
        return sendJSON(res, { ok: false, message: 'Please fill in every field.' });
      }
      if (!cacDocumentImage) {
        return sendJSON(res, { ok: false, message: 'Please capture a photo of your CAC document.' });
      }
      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === session.email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });

      seller.verification = seller.verification || {};
      seller.verification.cacNumber = cacNumber;
      seller.verification.registeredBusinessName = registeredBusinessName;
      seller.verification.cacDocumentImage = cacDocumentImage;
      seller.verification.businessStatus = 'Pending review';
      seller.verification.businessSubmittedAt = new Date().toISOString();

      writeJSON('sellers.json', sellers);
      notifyAdmin(`SellHub: New business (CAC) verification submitted by ${seller.businessName || seller.fullName || seller.email}. Review it in the admin dashboard.`);
      sendJSON(res, { ok: true, message: 'Submitted for review. This usually takes 1-2 business days.' });
    });
    return;
  }

  // ---------- SELLER PRODUCTS ----------
  if (req.method === 'GET' && req.url === '/api/seller/products') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    const products = readJSON('products.json').filter(p => p.sellerEmail === session.email);
    return sendJSON(res, { ok: true, products });
  }

  const PRODUCT_CATEGORIES = ['Fashion', 'Shoes', 'Beauty', 'Electronics', 'Phones & Accessories', 'Food', 'Home & Living', 'Jewelry', 'Digital Products', 'Other'];

  if (req.method === 'POST' && req.url === '/api/seller/products/add') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then((body) => {
      const sellersCheck = readJSON('sellers.json');
      const sellerCheck = sellersCheck.find(s => s.email === session.email);
      const identityStatus = sellerCheck && sellerCheck.verification ? sellerCheck.verification.identityStatus : null;
      if (identityStatus !== 'Verified') {
        return sendJSON(res, {
          ok: false,
          message: 'Your identity must be verified by an admin before you can post products. Please complete (or wait for approval of) identity verification in the Verification Center.'
        });
      }

      const name = (body.name || '').trim();
      const description = (body.description || '').trim();
      const price = Number(body.price);
      const discountPrice = body.discountPrice ? Number(body.discountPrice) : null;
      const stock = Number.isFinite(Number(body.stock)) ? Math.max(0, Math.floor(Number(body.stock))) : 0;
      const category = PRODUCT_CATEGORIES.includes(body.category) ? body.category : 'Other';
      const sku = (body.sku || '').trim();
      const sizes = Array.isArray(body.sizes) ? body.sizes.filter(Boolean) : [];
      const colors = Array.isArray(body.colors) ? body.colors.filter(Boolean) : [];
      const images = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
      // Small copies of the photos for the product grid (made in the seller's browser).
      const thumbs = cleanThumbs(body.thumbs, images);

      if (!name) return sendJSON(res, { ok: false, message: 'Product name is required.' });
      if (!price || price <= 0) return sendJSON(res, { ok: false, message: 'Enter a valid price.' });
      if (discountPrice && discountPrice >= price) return sendJSON(res, { ok: false, message: 'Discount price must be lower than the regular price.' });
      if (images.length === 0) return sendJSON(res, { ok: false, message: 'Please add at least one product photo.' });

      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === session.email);
      const products = readJSON('products.json');
      const newProduct = {
        id: Date.now(),
        name, description, price, discountPrice, stock, category, sku, sizes, colors, images, thumbs,
        status: stock > 0 ? 'In Stock' : 'Out of Stock',
        sellerEmail: session.email,
        storeName: seller ? seller.businessName : 'My Store',
        storeSlug: seller ? seller.storeSlug : null,
        dateAdded: new Date().toISOString()
      };
      products.push(newProduct);
      writeJSON('products.json', products);
      sendJSON(res, { ok: true, message: 'Product added!', product: newProduct });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/seller/products/update') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then((body) => {
      const products = readJSON('products.json');
      const product = products.find(p => p.id === body.id && p.sellerEmail === session.email);
      if (!product) return sendJSON(res, { ok: false, message: 'Product not found.' });

      if (body.name && body.name.trim()) product.name = body.name.trim();
      if (body.description !== undefined) product.description = (body.description || '').trim();
      if (body.price && Number(body.price) > 0) product.price = Number(body.price);
      if (body.discountPrice !== undefined) {
        const dp = body.discountPrice ? Number(body.discountPrice) : null;
        if (dp && dp >= product.price) return sendJSON(res, { ok: false, message: 'Discount price must be lower than the regular price.' });
        product.discountPrice = dp;
      }
      if (body.stock !== undefined) {
        product.stock = Math.max(0, Math.floor(Number(body.stock) || 0));
        product.status = product.stock > 0 ? 'In Stock' : 'Out of Stock';
      }
      if (body.category && PRODUCT_CATEGORIES.includes(body.category)) product.category = body.category;
      if (body.sku !== undefined) product.sku = (body.sku || '').trim();
      if (Array.isArray(body.sizes)) product.sizes = body.sizes.filter(Boolean);
      if (Array.isArray(body.colors)) product.colors = body.colors.filter(Boolean);
      if (Array.isArray(body.images) && body.images.length > 0) {
        product.images = body.images.filter(Boolean);
        product.thumbs = cleanThumbs(body.thumbs, product.images);   // never keep thumbnails of a photo that was replaced
      }

      writeJSON('products.json', products);
      sendJSON(res, { ok: true, message: 'Product updated!', product });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/seller/products/delete') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ id }) => {
      const products = readJSON('products.json');
      const exists = products.some(p => p.id === id && p.sellerEmail === session.email);
      if (!exists) return sendJSON(res, { ok: false, message: 'Product not found.' });

      const remaining = products.filter(p => !(p.id === id && p.sellerEmail === session.email));
      writeJSON('products.json', remaining);
      sendJSON(res, { ok: true, message: 'Product deleted.' });
    });
    return;
  }

  // ---------- SELLER ORDERS ----------
  if (req.method === 'GET' && req.url === '/api/seller/orders') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    const orders = readJSON('orders.json').filter(o =>
      o.items.some(i => i.sellerEmail === session.email)
    );
    return sendJSON(res, { ok: true, orders });
  }

  if (req.method === 'POST' && req.url === '/api/seller/update-order-status') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ orderId, status }) => {
      const orders = readJSON('orders.json');
      const order = orders.find(o => o.id === orderId);
      if (!order) return sendJSON(res, { ok: false, message: 'Order not found.' });
      if (!order.items.some(i => i.sellerEmail === session.email)) {
        return sendJSON(res, { ok: false, message: 'This order does not contain your products.' });
      }

      const steps = ['Order Received', 'Processing', 'Shipped', 'Out for Delivery', 'Delivered'];
      const currentIndex = steps.indexOf(order.status);
      const targetIndex = steps.indexOf(status);
      // Only allow moving forward one step at a time — never skip ahead or go backwards.
      if (targetIndex !== currentIndex + 1) {
        return sendJSON(res, { ok: false, message: 'Orders can only move forward one step at a time.' });
      }

      order.status = status;
      writeJSON('orders.json', orders);
      notifyOrderStatus(order, status);

      sendJSON(res, { ok: true, status: order.status });
    });
    return;
  }

  // ---------- SELLER: CANCEL ORDER ----------
  if (req.method === 'POST' && req.url === '/api/seller/cancel-order') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ orderId, reason }) => {
      const orders = readJSON('orders.json');
      const order = orders.find(o => o.id === orderId);
      if (!order) return sendJSON(res, { ok: false, message: 'Order not found.' });
      if (!order.items.some(i => i.sellerEmail === session.email)) {
        return sendJSON(res, { ok: false, message: 'This order does not contain your products.' });
      }
      if (order.status === 'Delivered' || order.status === 'Cancelled') {
        return sendJSON(res, { ok: false, message: `An order that is already ${order.status} cannot be cancelled.` });
      }

      order.status = 'Cancelled';
      order.cancelReason = reason || '';
      restoreStockForOrder(order);
      writeJSON('orders.json', orders);
      reverseSellerCreditsAndRefundCustomer(order);
      notifyOrderStatus(order, 'Cancelled');

      sendJSON(res, { ok: true, status: order.status });
    });
    return;
  }

  // ---------- SELLER: UPDATE DELIVERY TRACKING ----------
  if (req.method === 'POST' && req.url === '/api/seller/update-tracking') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ orderId, shippedDate, shippedTime, expectedDeliveryDate, expectedDeliveryTimeStart, expectedDeliveryTimeEnd }) => {
      const orders = readJSON('orders.json');
      const order = orders.find(o => o.id === orderId);
      if (!order) return sendJSON(res, { ok: false, message: 'Order not found.' });
      if (!order.items.some(i => i.sellerEmail === session.email)) {
        return sendJSON(res, { ok: false, message: 'This order does not contain your products.' });
      }

      order.tracking = order.tracking || {};
      if (shippedDate !== undefined) order.tracking.shippedDate = shippedDate;
      if (shippedTime !== undefined) order.tracking.shippedTime = shippedTime;
      if (expectedDeliveryDate !== undefined) order.tracking.expectedDeliveryDate = expectedDeliveryDate;
      if (expectedDeliveryTimeStart !== undefined) order.tracking.expectedDeliveryTimeStart = expectedDeliveryTimeStart;
      if (expectedDeliveryTimeEnd !== undefined) order.tracking.expectedDeliveryTimeEnd = expectedDeliveryTimeEnd;
      order.tracking.updatedAt = new Date().toISOString();

      writeJSON('orders.json', orders);
      sendJSON(res, { ok: true, message: 'Tracking info updated.', tracking: order.tracking });
    });
    return;
  }

  // ---------- CUSTOMER: REPORT AN ORDER ----------
  if (req.method === 'POST' && req.url === '/api/report-order') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    readBody(req).then(({ orderId, reason, details }) => {
      const orders = readJSON('orders.json');
      const order = orders.find(o => o.id === orderId && o.customerEmail === session.email);
      if (!order) return sendJSON(res, { ok: false, message: 'Order not found.' });
      if (!reason) return sendJSON(res, { ok: false, message: 'Please choose a reason for the report.' });

      const disputes = readJSON('disputes.json');
      const alreadyOpen = disputes.some(d => d.orderId === orderId && d.status !== 'Resolved');
      if (alreadyOpen) {
        return sendJSON(res, { ok: false, message: 'You already have an open report for this order.' });
      }

      const dispute = {
        id: Date.now(),
        orderId,
        customerEmail: session.email,
        sellerEmails: [...new Set(order.items.map(i => i.sellerEmail))],
        reason,
        details: details || '',
        status: 'Open',
        date: new Date().toISOString()
      };
      disputes.push(dispute);
      writeJSON('disputes.json', disputes);
      order.disputed = true;
      writeJSON('orders.json', orders);

      notifyAdmin(`SellHub: New dispute opened on order #${order.id}. Reason: ${reason}. Review it in the admin dashboard.`);

      sendJSON(res, { ok: true, message: 'Your report has been submitted. Our team will review it.', dispute });
    });
    return;
  }

  // ---------- SELLER WALLET ----------
  if (req.method === 'GET' && req.url === '/api/seller/wallet') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    const sellers = readJSON('sellers.json');
    const seller = sellers.find(s => s.email === session.email);
    if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });
    return sendJSON(res, {
      ok: true,
      balance: seller.walletBalance || 0,
      transactions: seller.transactions || []
    });
  }

  // Lets the seller see any warnings an admin has sent them, so they aren't
  // only relying on email (which can be missed or land in spam).
  if (req.method === 'GET' && req.url === '/api/seller/warnings') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    const sellers = readJSON('sellers.json');
    const seller = sellers.find(s => s.email === session.email);
    if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });
    return sendJSON(res, { ok: true, warnings: (seller.warnings || []).slice().reverse() });
  }

  // Marks a seller's warning(s) as seen, so an already-read warning doesn't
  // keep popping up on every dashboard load. Pass a specific warningId to
  // mark just that one, or omit it to mark all of this seller's warnings.
  if (req.method === 'POST' && req.url === '/api/seller/warnings/mark-seen') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ warningId }) => {
      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === session.email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });
      let changed = false;
      (seller.warnings || []).forEach(w => {
        if (warningId && w.id !== warningId) return;
        if (!w.seen) { w.seen = true; changed = true; }
      });
      if (changed) writeJSON('sellers.json', sellers);
      sendJSON(res, { ok: true });
    });
    return;
  }

  // Lets the seller see reminders (and anything else routed this way in the
  // future) directly in-app, rather than relying only on the email.
  if (req.method === 'GET' && req.url === '/api/seller/notifications') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    const notifications = readJSON('seller-notifications.json').filter(n => n.sellerEmail === session.email);
    return sendJSON(res, { ok: true, notifications });
  }

  if (req.method === 'POST' && req.url === '/api/seller/notifications/mark-read') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ notificationId }) => {
      const notifications = readJSON('seller-notifications.json');
      let changed = false;
      notifications.forEach(n => {
        if (n.sellerEmail !== session.email) return;
        if (notificationId && n.id !== notificationId) return;
        if (!n.read) { n.read = true; changed = true; }
      });
      if (changed) writeJSON('seller-notifications.json', notifications);
      sendJSON(res, { ok: true });
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/seller/fee-info') {
    const { sellerWithdrawalFeePercent } = getSettings();
    return sendJSON(res, { ok: true, sellerWithdrawalFeePercent });
  }

  // ---------- BANKS (used by both seller and admin withdrawal forms) ----------
  if (req.method === 'GET' && req.url === '/api/banks') {
    const session = requireAuth(req, res, null);
    if (!session) return;
    getBankList()
      .then(banks => sendJSON(res, { ok: true, banks }))
      .catch(err => sendJSON(res, { ok: false, message: 'Could not load the bank list: ' + err.message }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/resolve-account') {
    const session = requireAuth(req, res, null);
    if (!session) return;
    readBody(req).then(({ bankCode, accountNumber }) => {
      if (!bankCode || !accountNumber) return sendJSON(res, { ok: false, message: 'Select a bank and enter the account number.' });
      resolveBankAccount(accountNumber, bankCode)
        .then(accountName => sendJSON(res, { ok: true, accountName }))
        .catch(err => sendJSON(res, { ok: false, message: err.message || 'Could not verify that account.' }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/seller/withdraw') {
    const session = requireAuth(req, res, 'seller');
    if (!session) return;
    readBody(req).then(({ amount, bank, bankCode, accountNumber, accountName }) => {
      amount = Number(amount);
      if (!amount || amount <= 0) return sendJSON(res, { ok: false, message: 'Enter a valid amount.' });
      if (!bank || !bankCode || !accountNumber || !accountName) {
        return sendJSON(res, { ok: false, message: 'Please select your bank and verify your account before withdrawing.' });
      }

      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === session.email);
      if (!seller) return sendJSON(res, { ok: false, message: 'Account not found.' });

      const { sellerWithdrawalFeePercent } = getSettings();
      const fee = Math.round(amount * (sellerWithdrawalFeePercent / 100));
      const netAmount = amount - fee;

      if ((seller.walletBalance || 0) < amount) {
        return sendJSON(res, { ok: false, message: 'Insufficient wallet balance.' });
      }

      // Deduct immediately so the same funds can't be withdrawn twice while
      // this request is pending review. An admin reviews it in the dashboard
      // and pays the seller manually (their own bank/Paystack dashboard) —
      // see /api/admin/withdrawals/decide.
      seller.walletBalance -= amount;
      seller.transactions = seller.transactions || [];
      seller.transactions.unshift({
        type: 'withdrawal', amount, fee, netAmount, status: 'Pending', date: new Date().toISOString()
      });
      writeJSON('sellers.json', sellers);

      const withdrawals = readJSON('withdrawals.json');
      const withdrawal = {
        id: Date.now(),
        sellerEmail: session.email,
        storeName: seller.businessName,
        amount, fee, netAmount,
        bank, bankCode, accountNumber, accountName,
        status: 'Pending',
        date: new Date().toISOString()
      };
      withdrawals.push(withdrawal);
      writeJSON('withdrawals.json', withdrawals);

      notifyAdmin(`SellHub: New withdrawal request from ${seller.businessName || seller.fullName || seller.email} for ₦${amount.toLocaleString()}. Review it in the admin dashboard.`);

      sendJSON(res, {
        ok: true,
        message: 'Withdrawal request submitted — it will be reviewed before payout.',
        balance: seller.walletBalance,
        withdrawal
      });
    });
    return;
  }

  // ---------- REVIEWS ----------
  if (req.method === 'GET' && req.url.startsWith('/api/reviews')) {
    const productId = Number(req.url.split('productId=')[1]);
    const reviews = readJSON('reviews.json').filter(r => r.productId === productId);
    return sendJSON(res, { ok: true, reviews });
  }

  if (req.method === 'POST' && req.url === '/api/review') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    readBody(req).then(({ orderId, productId, rating, text }) => {
      const orders = readJSON('orders.json');
      const order = orders.find(o => o.id === orderId && o.customerEmail === session.email);
      if (!order) return sendJSON(res, { ok: false, message: 'Order not found.' });
      if (order.status !== 'Delivered') return sendJSON(res, { ok: false, message: 'You can only review items after delivery.' });
      if (!order.items.some(i => i.id === productId)) return sendJSON(res, { ok: false, message: 'This product was not in that order.' });

      const reviews = readJSON('reviews.json');
      if (reviews.some(r => r.orderId === orderId && r.productId === productId && r.customerEmail === session.email)) {
        return sendJSON(res, { ok: false, message: 'You already reviewed this product for this order.' });
      }

      const customers = readJSON('customers.json');
      const customer = customers.find(c => c.email === session.email);

      reviews.push({
        productId, orderId, customerEmail: session.email,
        customerName: customer ? customer.fullName : 'SellHub Customer',
        rating: Number(rating), text,
        verifiedPurchase: true,
        date: new Date().toISOString()
      });
      writeJSON('reviews.json', reviews);
      sendJSON(res, { ok: true, message: 'Thanks for your review!' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/remind-seller') {
    const session = requireAuth(req, res, 'customer');
    if (!session) return;
    readBody(req).then(async ({ orderId }) => {
      const orders = readJSON('orders.json');
      const order = orders.find(o => o.id === orderId && o.customerEmail === session.email);
      if (!order) return sendJSON(res, { ok: false, message: 'Order not found.' });

      const sellers = readJSON('sellers.json');
      const sellerEmails = [...new Set(order.items.map(i => i.sellerEmail))];
      for (const sellerEmail of sellerEmails) {
        await sendEmail(
          sellerEmail,
          `Delivery reminder — Order #${order.id}`,
          `<p>A customer (${order.fullName}) is checking on the delivery status of their order placed on ${new Date(order.date).toLocaleDateString()}.</p>`
        );
        createSellerNotification(
          sellerEmail, order.id, 'Reminder',
          'Delivery reminder',
          `${order.fullName || 'A customer'} is checking on order #${order.id}.`
        );
        const seller = sellers.find(s => s.email === sellerEmail);
        const sellerPhone = seller && (seller.whatsappNumber || seller.businessPhone);
        if (sellerPhone) {
          await sendWhatsApp(
            sellerPhone,
            `SellHub: ${order.fullName || 'A customer'} is checking on order #${order.id}. Please update them soon.`
          );
        }
      }
      order.reminders.push(new Date().toISOString());
      writeJSON('orders.json', orders);
      sendJSON(res, { ok: true, message: 'Reminder sent to the seller!' });
    });
    return;
  }

  // ---------- CUSTOMER SIGNUP ----------
  if (req.method === 'POST' && req.url === '/api/signup') {
    if (tooMany(req, res, 'signup', 30, 60 * 60 * 1000)) return;
    readBody(req).then(async (formData) => {
      formData.email = normalizeEmail(formData.email);
      const customers = readJSON('customers.json');
      const sellers = readJSON('sellers.json');
      if (customers.some(c => c.email === formData.email)) {
        return sendJSON(res, { ok: false, message: 'This email is already registered as a customer.' });
      }
      if (sellers.some(s => s.email === formData.email)) {
        return sendJSON(res, { ok: false, message: 'This email is already used for a seller account. Please use a different email for your customer account.' });
      }
      const code = crypto.randomInt(100000, 999999).toString();
      pendingSignups[formData.email] = { code, formData };
      persistCodeState();
      // Respond immediately — don't make the person wait on the real Gmail
      // connection, which can take a couple of seconds. The email is sent
      // right after, in the background.
      sendJSON(res, { ok: true, message: 'Code sent! Check your email — it may take a few seconds to arrive.' });
      sendOTPEmail(formData.email, code).catch(err => {
        console.log('ERROR sending OTP email:', err.code || '', err.command || '', err.responseCode || '', err.message);
      });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/verify-signup') {
    if (tooMany(req, res, 'verify', 60, 15 * 60 * 1000)) return;
    readBody(req).then(async ({ email, code }) => {
      email = normalizeEmail(email);
      if (tooMany(req, res, 'codeacct', 8, 15 * 60 * 1000, email)) return;
      const pending = pendingSignups[email];
      if (!pending || pending.code !== code) return sendJSON(res, { ok: false, message: '❌ Wrong code, try again.' });
      const customers = readJSON('customers.json');
      const hashedPassword = await bcrypt.hash(pending.formData.password, 10);
      customers.push({ ...pending.formData, password: hashedPassword, createdAt: new Date().toISOString() });
      writeJSON('customers.json', customers);
      delete pendingSignups[email];
      persistCodeState();
      const token = createSession(pending.formData.email, 'customer');
      sendJSON(res, {
        ok: true, message: '✅ Account created!', token,
        account: { fullName: pending.formData.fullName, email: pending.formData.email }
      });
    });
    return;
  }

  // ---------- SELLER SIGNUP ----------
  if (req.method === 'POST' && req.url === '/api/seller-signup') {
    if (tooMany(req, res, 'sellersignup', 30, 60 * 60 * 1000)) return;
    readBody(req).then(async (formData) => {
      formData.email = normalizeEmail(formData.email);
      const customers = readJSON('customers.json');
      const sellers = readJSON('sellers.json');
      if (sellers.some(s => s.email === formData.email)) {
        return sendJSON(res, { ok: false, message: 'This email is already registered as a seller.' });
      }
      if (customers.some(c => c.email === formData.email)) {
        return sendJSON(res, { ok: false, message: 'This email is already used for a customer account. Please use a different email for your seller account.' });
      }
      const code = crypto.randomInt(100000, 999999).toString();
      pendingSellerSignups[formData.email] = { code, formData };
      persistCodeState();
      // Respond immediately — see note in /api/signup above.
      sendJSON(res, { ok: true, message: 'Code sent! Check your email — it may take a few seconds to arrive.' });
      sendOTPEmail(formData.email, code).catch(err => {
        console.log('ERROR sending OTP email:', err.code || '', err.command || '', err.responseCode || '', err.message);
      });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/verify-seller-signup') {
    if (tooMany(req, res, 'verify', 60, 15 * 60 * 1000)) return;
    readBody(req).then(async ({ email, code }) => {
      email = normalizeEmail(email);
      if (tooMany(req, res, 'codeacct', 8, 15 * 60 * 1000, email)) return;
      const pending = pendingSellerSignups[email];
      if (!pending || pending.code !== code) return sendJSON(res, { ok: false, message: '❌ Wrong code, try again.' });
      const sellers = readJSON('sellers.json');
      const hashedPassword = await bcrypt.hash(pending.formData.password, 10);
      sellers.push({ ...pending.formData, password: hashedPassword });
      writeJSON('sellers.json', sellers);
      delete pendingSellerSignups[email];
      persistCodeState();
      const token = createSession(pending.formData.email, 'seller');
      sendJSON(res, {
        ok: true, message: '✅ Store created!', token,
        account: { fullName: pending.formData.fullName, businessName: pending.formData.businessName, email: pending.formData.email }
      });
    });
    return;
  }

  // ---------- GOOGLE SIGN-IN ----------
  // One endpoint for both "Sign in with Google" and "Sign up with Google".
  // accountType tells us which table to create a NEW account in if one
  // doesn't exist yet; it's ignored if the email already has an account,
  // since we log them into whichever account actually exists.
  if (req.method === 'POST' && req.url === '/api/google-auth') {
    if (tooMany(req, res, 'google', 60, 15 * 60 * 1000)) return;
    readBody(req).then(async ({ credential, accountType }) => {
      let googleUser;
      try {
        googleUser = await verifyGoogleToken(credential);
      } catch (err) {
        return sendJSON(res, { ok: false, message: 'Could not verify Google sign-in. Please try again.' });
      }

      const email = normalizeEmail(googleUser.email);
      const { fullName } = googleUser;
      const customers = readJSON('customers.json');
      const sellers = readJSON('sellers.json');

      const existingCustomer = customers.find(c => c.email === email);
      const existingSeller = sellers.find(s => s.email === email);

      // Case 1: account already exists — log them straight in, regardless
      // of which button they clicked, since the account itself decides.
      if (existingCustomer) {
        const token = createSession(existingCustomer.email, 'customer');
        return sendJSON(res, {
          ok: true, accountType: 'customer', token,
          message: `Welcome back, ${existingCustomer.fullName}!`,
          account: { fullName: existingCustomer.fullName, email: existingCustomer.email }
        });
      }
      if (existingSeller) {
        if (existingSeller.suspended) {
          return sendJSON(res, { ok: false, message: 'Your seller account has been suspended. Contact support for details.' });
        }
        const token = createSession(existingSeller.email, 'seller');
        return sendJSON(res, {
          ok: true, accountType: 'seller', token,
          message: `Welcome back, ${existingSeller.fullName}!`,
          account: { fullName: existingSeller.fullName, businessName: existingSeller.businessName, email: existingSeller.email }
        });
      }

      // Case 2: no account yet — create one. Google users skip the OTP
      // step (Google already verified the email) and get a random,
      // unusable password on the account, since they'll only ever log
      // in through the Google button.
      const randomPassword = crypto.randomBytes(24).toString('hex');
      const hashedPassword = await bcrypt.hash(randomPassword, 10);

      if (accountType === 'seller') {
        const newSeller = {
          fullName,
          businessName: `${fullName}'s Store`,
          email,
          password: hashedPassword,
          walletBalance: 0,
          transactions: []
        };
        sellers.push(newSeller);
        writeJSON('sellers.json', sellers);
        const token = createSession(email, 'seller');
        return sendJSON(res, {
          ok: true, accountType: 'seller', token,
          message: '✅ Store created!',
          account: { fullName, businessName: newSeller.businessName, email }
        });
      }

      const newCustomer = { fullName, email, password: hashedPassword, createdAt: new Date().toISOString(), signedUpWith: 'Google' };
      customers.push(newCustomer);
      writeJSON('customers.json', customers);
      const token = createSession(email, 'customer');
      return sendJSON(res, {
        ok: true, accountType: 'customer', token,
        message: '✅ Account created!',
        account: { fullName, email }
      });
    }).catch(() => sendJSON(res, { ok: false, message: 'Something went wrong with Google sign-in.' }));
    return;
  }

  // ---------- LOGIN ----------
  if (req.method === 'POST' && req.url === '/api/login') {
    if (tooMany(req, res, 'login', 40, 15 * 60 * 1000)) return;
    readBody(req).then(async ({ email, password }) => {
      email = normalizeEmail(email);
      if (tooMany(req, res, 'loginacct', 10, 15 * 60 * 1000, email)) return;
      const customers = readJSON('customers.json');
      const sellers = readJSON('sellers.json');

      const customerMatch = customers.find(c => c.email === email);
      if (customerMatch && await bcrypt.compare(password, customerMatch.password)) {
        const token = createSession(customerMatch.email, 'customer');
        return sendJSON(res, {
          ok: true, accountType: 'customer', token,
          message: `Welcome back, ${customerMatch.fullName}!`,
          account: { fullName: customerMatch.fullName, email: customerMatch.email }
        });
      }
      const sellerMatch = sellers.find(s => s.email === email);
      if (sellerMatch && await bcrypt.compare(password, sellerMatch.password)) {
        if (sellerMatch.suspended) {
          return sendJSON(res, { ok: false, message: 'Your seller account has been suspended. Contact support for details.' });
        }
        const token = createSession(sellerMatch.email, 'seller');
        return sendJSON(res, {
          ok: true, accountType: 'seller', token,
          message: `Welcome back, ${sellerMatch.fullName}!`,
          account: { fullName: sellerMatch.fullName, businessName: sellerMatch.businessName, email: sellerMatch.email }
        });
      }
      sendJSON(res, { ok: false, message: 'Incorrect email or password.' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/logout') {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) { delete sessions[hashToken(token)]; saveSessions(); }
    sendJSON(res, { ok: true });
    return;
  }

  // ---------- FORGOT PASSWORD ----------
  if (req.method === 'POST' && req.url === '/api/request-reset') {
    if (tooMany(req, res, 'reset', 20, 60 * 60 * 1000)) return;
    readBody(req).then(async ({ email }) => {
      email = normalizeEmail(email);
      const customers = readJSON('customers.json');
      const sellers = readJSON('sellers.json');
      if (!customers.some(c => c.email === email) && !sellers.some(s => s.email === email)) {
        return sendJSON(res, { ok: false, message: 'No account found with that email.' });
      }
      const code = crypto.randomInt(100000, 999999).toString();
      resetCodes[email] = code;
      persistCodeState();
      // Respond immediately — see note in /api/signup above.
      sendJSON(res, { ok: true, message: 'Code sent! Check your email — it may take a few seconds to arrive.' });
      sendOTPEmail(email, code).catch(err => {
        console.log('ERROR sending OTP email:', err.code || '', err.command || '', err.responseCode || '', err.message);
      });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/reset-password') {
    if (tooMany(req, res, 'resetpw', 30, 60 * 60 * 1000)) return;
    readBody(req).then(async ({ email, code, newPassword }) => {
      email = normalizeEmail(email);
      if (tooMany(req, res, 'codeacct', 8, 15 * 60 * 1000, email)) return;
      if (resetCodes[email] !== code) return sendJSON(res, { ok: false, message: '❌ Wrong code, try again.' });
      const customers = readJSON('customers.json');
      const sellers = readJSON('sellers.json');
      const customer = customers.find(c => c.email === email);
      const seller = sellers.find(s => s.email === email);
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      if (customer) { customer.password = hashedPassword; writeJSON('customers.json', customers); }
      if (seller) { seller.password = hashedPassword; writeJSON('sellers.json', sellers); }
      delete resetCodes[email];
      persistCodeState();
      sendJSON(res, { ok: true, message: '✅ Password updated! You can now log in with it.' });
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Before accepting any traffic, pull the last good copy of every data file
// down from the free backup (if one's configured — see dataBackup.js) and
// write it into DATA_DIR. This is what undoes Render's free-tier disk wipe:
// by the time the first request comes in, customers.json/sellers.json/etc
// already reflect the real, last-known data instead of whatever shipped in
// the git repo.
async function bootFromDatabase() {
    const rows = await pgstore.loadAll();
  const inDb = new Set(rows.map(r => r.name));
  const snap = path.join(DATA_DIR, 'backups', 'before-db-restore-' + new Date().toISOString().replace(/[:.]/g, '-'));
  let restored = 0;
  for (const r of rows) {
    const text = JSON.stringify(r.data, null, 2);
    if (CODE_STATE_FILES.includes(r.name)) {
      const target = { 'pendingSignups.json': pendingSignups, 'pendingSellerSignups.json': pendingSellerSignups, 'resetCodes.json': resetCodes, 'sessions.json': sessions }[r.name];
      Object.assign(target, r.data);
      continue;
    }
    if (!DATA_FILES.includes(r.name)) continue;
    const file = path.join(DATA_DIR, r.name);
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') !== text) {
        fs.mkdirSync(snap, { recursive: true });
        fs.copyFileSync(file, path.join(snap, r.name));
      }
    } catch (e) {}
    fs.writeFileSync(file, text);
    restored++;
  }
  // First run against an empty database: upload what this server currently holds.
  let uploaded = 0;
  for (const f of DATA_FILES) {
    if (inDb.has(f)) continue;
    try { pgstore.save(f, fs.readFileSync(path.join(DATA_DIR, f), 'utf-8')); uploaded++; } catch (e) {}
  }
  if (!inDb.has('sessions.json')) persistCodeState();
  console.log(`🗄️  Database ready: restored ${restored} data files from it, uploaded ${uploaded} that it did not have yet.`);
  pgstore.syncBlobsFromDisk(BLOB_DIR, fs, path, n => BLOB_MIME[n.split('.')[1]]).catch(e => console.error('Photo sync failed:', e.message));
}
loadSessionsFromDisk();
// On a disk that already holds data, the disk wins: an older backup must
// never overwrite it. The backup is only pulled down for a brand-new/wiped
// disk, or when there's no persistent disk at all.
const restoreData = (DATA_DIR === __dirname || freshDisk)
  ? restoreAllFiles((fileName, contents) => {
      fs.writeFileSync(path.join(DATA_DIR, fileName), contents);
    }, DATA_FILES)
  : (console.log('Disk already has data — using it as is (skipping restore from backup).'), Promise.resolve());
restoreData
  // PostgreSQL (if DATABASE_URL is set) is the source of truth: load its copy before anything else reads the files.
  .then(async () => {
    if (!pgstore.enabled) return;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        if (!(await pgstore.init())) throw new Error(pgstore.status().lastError || 'cannot connect');
        await bootFromDatabase();
        return;
      } catch (e) {
        console.error(`Database start-up attempt ${attempt} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    // Could not reach the database. A server with no local data must not start blank (it would overwrite real data later),
    // so exit and let the host restart it; a server that still has its files keeps running on them.
    const haveLocal = ['sellers.json', 'customers.json', 'products.json'].some(f => fs.existsSync(path.join(DATA_DIR, f)));
    if (!haveLocal || freshDisk) { console.error('No local data and no database: refusing to start blank.'); process.exit(1); }
    console.error('⚠️ Running on local files only; the database could not be reached.');
  })
  // Move any photos still stored inline in the data files out to image files,
  // so the backup stays small. Safe to run on every boot (does nothing once done).
  .then(() => {
    for (const file of DATA_FILES) {
      try {
        const data = readJSON(file);
        if (externalizeBlobs(data)) { writeJSON(file, data); console.log('Moved inline images out of', file); }
      } catch (e) { /* file missing or not JSON — leave it */ }
    }
  })
  // Also pull back any in-flight signup/reset codes from before the restart,
  // straight into memory (these never lived on disk, so no fs write here).
  .then(() => restoreAllFiles((fileName, contents) => {
    try {
      const parsed = JSON.parse(contents);
      if (fileName === 'pendingSignups.json') Object.assign(pendingSignups, parsed);
      if (fileName === 'pendingSellerSignups.json') Object.assign(pendingSellerSignups, parsed);
      if (fileName === 'resetCodes.json') Object.assign(resetCodes, parsed);
      if (fileName === 'sessions.json') Object.assign(sessions, parsed);
    } catch (e) { /* ignore a corrupt/empty backup, start fresh */ }
  }, CODE_STATE_FILES))
  .finally(() => {
    server.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
    setTimeout(snapshotData, 30 * 1000).unref(); setInterval(snapshotData, 6 * 60 * 60 * 1000).unref();
    if (REMINDERS_ON) { setTimeout(checkReminderSchedule, 60 * 1000).unref(); setInterval(checkReminderSchedule, 10 * 60 * 1000).unref(); }
  });

// On redeploy/shutdown, finish saving to the database before the process ends.
let shuttingDown = false;
function gracefulExit() {
  if (shuttingDown) return; shuttingDown = true;
  pgstore.flushNow(6000).finally(() => process.exit(0));
}
process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);
