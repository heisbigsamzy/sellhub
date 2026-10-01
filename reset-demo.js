// reset-demo.js — clears SellHub's demo/test data so you can start clean.
//
//   node reset-demo.js                     keeps every account, but sets all money to ₦0
//                                          and erases products, orders, reviews, withdrawals,
//                                          disputes, notifications and Paystack test payments.
//   node reset-demo.js --delete-accounts   does all of the above AND deletes every
//                                          customer and seller account.
//
// Your settings.json (fees, admin password, admin PIN) is NEVER touched.
// A full backup is made first, so you can undo this.

const fs = require('fs');
const path = require('path');
const net = require('net');
const readline = require('readline');

const DIR = __dirname;
const PORT = 3000;
const deleteAccounts = process.argv.includes('--delete-accounts');

const ALWAYS_EMPTY = [
  'products.json', 'orders.json', 'reviews.json',
  'withdrawals.json', 'admin-withdrawals.json',
  'disputes.json', 'notifications.json', 'seller-notifications.json',
  'payments.json'
];
const ACCOUNT_FILES = ['customers.json', 'sellers.json'];
const BACKUP_ALL = [...ALWAYS_EMPTY, ...ACCOUNT_FILES, 'settings.json'];

const file = name => path.join(DIR, name);
const naira = n => '₦' + (Number(n) || 0).toLocaleString();

function readList(name) {
  try {
    const data = JSON.parse(fs.readFileSync(file(name), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function stop(message) {
  console.log('\n🛑 ' + message + '\n   Nothing was changed.\n');
  process.exit(1);
}

function isPortOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

(async () => {
  console.log('\n=== SellHub demo data reset ===\n');

  // SAFETY 1: never wipe records once real money is involved.
  let envText = '';
  try { envText = fs.readFileSync(file('.env'), 'utf8'); } catch (e) {}
  if (/^\s*PAYSTACK_SECRET_KEY\s*=\s*sk_live_/m.test(envText) || /^sk_live_/.test(process.env.PAYSTACK_SECRET_KEY || '')) {
    stop('Your .env contains a LIVE Paystack key (sk_live_...).\n   This tool refuses to run in live mode, because your records may now hold\n   real customers\' money. It is only for clearing demo/test data.');
  }

  // SAFETY 2: the app must be stopped, or it could write old data back.
  if (await isPortOpen(PORT)) {
    stop('SellHub is still running (something is using port ' + PORT + ').\n   Click on the window where it runs, press Ctrl+C to stop it, then try again.');
  }

  // Show exactly what is about to be erased.
  const customers = readList('customers.json');
  const sellers = readList('sellers.json');
  const orders = readList('orders.json');
  const customerMoney = customers.reduce((s, c) => s + (c.walletBalance || 0), 0);
  const sellerMoney = sellers.reduce((s, x) => s + (x.walletBalance || 0), 0);
  const feeRevenue = orders.reduce((s, o) => s + (o.serviceFee || 0), 0);

  console.log('This will ERASE:');
  console.log('  • ' + readList('products.json').length + ' products, ' + readList('reviews.json').length + ' reviews');
  console.log('  • ' + orders.length + ' orders  (this also resets the admin dashboard revenue: ' + naira(feeRevenue) + ' → ₦0)');
  console.log('  • ' + readList('withdrawals.json').length + ' seller withdrawals, ' + readList('admin-withdrawals.json').length + ' admin withdrawals');
  console.log('  • ' + readList('disputes.json').length + ' disputes, ' + (readList('notifications.json').length + readList('seller-notifications.json').length) + ' notifications');
  console.log('  • ' + readList('payments.json').length + ' Paystack payment records');
  console.log('  • all wallet money: customers ' + naira(customerMoney) + ', sellers ' + naira(sellerMoney) + ' → ₦0');
  if (deleteAccounts) {
    console.log('  • ALL ACCOUNTS: ' + customers.length + ' customers and ' + sellers.length + ' sellers will be DELETED (they can sign up again)');
  } else {
    console.log('\nThis will KEEP: your ' + customers.length + ' customer and ' + sellers.length + ' seller accounts (names, emails, passwords, stores).');
    console.log('(To delete the accounts too, run:  node reset-demo.js --delete-accounts )');
  }
  console.log('\nThis will NOT touch settings.json (your fees, admin password and admin PIN).');
  console.log('A full backup is saved first, so you can undo this.\n');

  const answer = await ask('Type YES (capital letters) to continue, or anything else to cancel: ');
  if (answer !== 'YES') stop('Cancelled.');

  // BACKUP everything before changing anything.
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const backupDir = path.join(DIR, 'backup-before-reset-' + stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  BACKUP_ALL.forEach(name => {
    if (fs.existsSync(file(name))) fs.copyFileSync(file(name), path.join(backupDir, name));
  });

  // CLEAR.
  ALWAYS_EMPTY.forEach(name => fs.writeFileSync(file(name), '[]'));

  if (deleteAccounts) {
    ACCOUNT_FILES.forEach(name => fs.writeFileSync(file(name), '[]'));
  } else {
    customers.forEach(c => { c.walletBalance = 0; c.transactions = []; });
    sellers.forEach(s => {
      s.walletBalance = 0;
      s.transactions = [];
      delete s.warnings;                       // admin warnings from testing
      if (s.suspended) s.suspended = false;    // lift test suspensions
    });
    fs.writeFileSync(file('customers.json'), JSON.stringify(customers, null, 2));
    fs.writeFileSync(file('sellers.json'), JSON.stringify(sellers, null, 2));
  }

  console.log('\n✅ Done. Everything is clean.');
  console.log('📦 Backup saved in the folder:  ' + path.basename(backupDir));
  console.log('\nTo UNDO: copy the .json files from that backup folder back into your project folder.');
  console.log('Now start the app again with:  npm start\n');
})();