const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sendOTPEmail, sendEmail } = require('./mailer');
const { verifyGoogleToken } = require('./googleAuth');
const { sendWhatsApp } = require('./whatsapp');
const { backupFile, restoreAllFiles } = require('./dataBackup');

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
    : `⚠️ Your withdrawal of ₦${withdrawal.amount.toLocaleString()} was not approved, so the full amount has been returned to your SellHub wallet. Please check your bank details and try again.`;

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
function notifyOrderStatus(order, status) {
  const copy = ORDER_STATUS_COPY[status];
  if (!copy) return;

  createNotification(order.customerEmail, order.id, status, copy.heading, copy.line(order));

  const itemsList = order.items.map(i => i.name).join(', ');
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
    shareBySeller[item.sellerEmail] = (shareBySeller[item.sellerEmail] || 0) + (item.effectivePrice || item.price);
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
    const payout = items.reduce((sum, i) => sum + (i.effectivePrice || i.price), 0);
    const itemsList = items.map(i => i.name).join(', ');

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
function reverseSellerCreditsAndRefundCustomer(order) {
  const sellers = readJSON('sellers.json');
  const shareBySeller = {};
  order.items.forEach(item => {
    shareBySeller[item.sellerEmail] = (shareBySeller[item.sellerEmail] || 0) + (item.effectivePrice || item.price);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(err); }
    });
  });
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
    fs.writeFileSync(path.join(BLOB_DIR, `${id}.${ext}`), Buffer.from(str.slice(m[0].length), 'base64'));
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
  fs.writeFileSync(path.join(DATA_DIR, file), text);
  // Free, zero-maintenance safety net — see dataBackup.js. No-ops until an
  // Upstash database is connected; never blocks or throws into the caller.
  backupFile(file, text);
}
function serveFile(res, fileName) {
  fs.readFile(fileName, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content);
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

const server = http.createServer((req, res) => {

  // Ignore any ?query=string when matching a page, so returning from
  // Paystack to /dashboard?deposit=success still loads the dashboard.
  const pagePath = req.url.split('?')[0];
  if (req.method === 'GET' && /^\/blob\/[a-f0-9]{48}\.(jpg|png|webp|gif|pdf)$/.test(pagePath)) {
    const name = pagePath.slice(6);
    fs.readFile(path.join(BLOB_DIR, name), (err, img) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': BLOB_MIME[name.split('.')[1]],
        'Cache-Control': 'private, max-age=86400',
        'X-Robots-Tag': 'noindex',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(img);
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
  if (req.method === 'GET' && pages[pagePath]) { serveFile(res, pages[pagePath]); return; }

  // Every storefront shares one page (storefront.html); the page itself
  // reads the slug from the URL and fetches that seller's data.
  if (req.method === 'GET' && req.url.startsWith('/store/')) { serveFile(res, 'storefront.html'); return; }

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
    readBody(req).then(({ password }) => {
      const { adminPassword } = getSettings();
      if (password !== adminPassword) {
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
    readBody(req).then(async ({ id, decision }) => {
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
        withdrawal.status = 'Rejected';
        writeJSON('withdrawals.json', withdrawals);

        const sellers = readJSON('sellers.json');
        const seller = sellers.find(s => s.email === withdrawal.sellerEmail);
        if (seller) {
          const txn = (seller.transactions || []).find(t => t.type === 'withdrawal' && t.status === 'Pending' && t.amount === withdrawal.amount);
          if (txn) txn.status = 'Rejected';
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
      const sellersInfo = (d.sellerEmails || []).map(email => {
        const s = sellers.find(x => x.email === email);
        if (!s) return { email, found: false };
        const disputeCount = disputes.filter(other => (other.sellerEmails || []).includes(email)).length;
        return {
          email: s.email,
          found: true,
          businessName: s.businessName,
          fullName: s.fullName,
          phone: s.businessPhone,
          bankName: s.verification && s.verification.bankName,
          accountNumber: s.verification && s.verification.accountNumber,
          accountName: s.verification && s.verification.accountName,
          suspended: !!s.suspended,
          warningCount: (s.warnings || []).length,
          disputeCount
        };
      });
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

      try {
        await sendEmail(
          email,
          'Warning from SellHub',
          `<p>Hello ${seller.fullName || ''},</p><p>${message}</p><p>Please take this seriously — repeated issues can lead to your account being suspended.</p>`
        );
      } catch (err) { console.log('Email error:', err.message); }

      const sellerPhone = seller.whatsappNumber || seller.businessPhone;
      if (sellerPhone) {
        sendWhatsApp(sellerPhone, `SellHub warning: ${message}`).catch(err => console.log('WhatsApp error:', err.message));
      }

      sendJSON(res, { ok: true, message: 'Warning sent to seller.' });
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
        return { ...publicProduct, avgRating: avg, reviewCount: productReviews.length, sellerVerified };
      });
    return sendJSON(res, { ok: true, products: withRatings });
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
      const { fullName, phone, deliveryEmail, address, state, city, instructions, cartIds, saveAddress } = form;
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
      const orderItems = items.map(p => ({ ...p, effectivePrice: p.discountPrice || p.price }));

      // Fees are computed server-side, never trusted from the client.
      const { customerServiceFeePercent } = getSettings();
      const subtotal = orderItems.reduce((sum, p) => sum + p.effectivePrice, 0);
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

      // Each purchase takes one unit out of stock; a product that hits zero
      // flips to Out of Stock automatically for every future shopper.
      orderItems.forEach(item => {
        const stocked = products.find(p => p.id === item.id);
        if (stocked && typeof stocked.stock === 'number') {
          stocked.stock = Math.max(0, stocked.stock - 1);
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

      if (!name) return sendJSON(res, { ok: false, message: 'Product name is required.' });
      if (!price || price <= 0) return sendJSON(res, { ok: false, message: 'Enter a valid price.' });
      if (discountPrice && discountPrice >= price) return sendJSON(res, { ok: false, message: 'Discount price must be lower than the regular price.' });
      if (images.length === 0) return sendJSON(res, { ok: false, message: 'Please add at least one product photo.' });

      const sellers = readJSON('sellers.json');
      const seller = sellers.find(s => s.email === session.email);
      const products = readJSON('products.json');
      const newProduct = {
        id: Date.now(),
        name, description, price, discountPrice, stock, category, sku, sizes, colors, images,
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
      if (Array.isArray(body.images) && body.images.length > 0) product.images = body.images.filter(Boolean);

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
    readBody(req).then(async ({ email, code }) => {
      email = normalizeEmail(email);
      const pending = pendingSignups[email];
      if (!pending || pending.code !== code) return sendJSON(res, { ok: false, message: '❌ Wrong code, try again.' });
      const customers = readJSON('customers.json');
      const hashedPassword = await bcrypt.hash(pending.formData.password, 10);
      customers.push({ ...pending.formData, password: hashedPassword });
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
    readBody(req).then(async ({ email, code }) => {
      email = normalizeEmail(email);
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

      const newCustomer = { fullName, email, password: hashedPassword };
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
    readBody(req).then(async ({ email, password }) => {
      email = normalizeEmail(email);
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
    readBody(req).then(async ({ email, code, newPassword }) => {
      email = normalizeEmail(email);
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
  });
