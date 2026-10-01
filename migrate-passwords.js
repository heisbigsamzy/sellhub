// One-time migration: hashes any plaintext passwords still sitting in
// customers.json / sellers.json (left over from before hashing was added).
// Run this once: node migrate-passwords.js
// Safe to run more than once — it skips passwords that are already hashed.
const fs = require('fs');
const bcrypt = require('bcryptjs');

function migrate(file) {
  const records = JSON.parse(fs.readFileSync(file, 'utf-8'));
  let changed = 0;
  for (const record of records) {
    // bcrypt hashes always start with $2a$, $2b$ or $2y$ — anything else is plaintext.
    if (record.password && !/^\$2[aby]\$/.test(record.password)) {
      record.password = bcrypt.hashSync(record.password, 10);
      changed++;
    }
  }
  fs.writeFileSync(file, JSON.stringify(records, null, 2));
  console.log(`${file}: hashed ${changed} plaintext password(s).`);
}

migrate('customers.json');
migrate('sellers.json');
console.log('Done. You can now log in with the same passwords as before — they are just stored safely now.');
