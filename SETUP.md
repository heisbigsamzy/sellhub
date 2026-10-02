# SellHub — what changed and how to run it

## 1. Rotate your Gmail app password (do this first, outside this project)
The old password (`oxgylyezipzslikr`) was hardcoded in `mailer.js` and has now
been seen in a chat conversation. Go to your Google Account → Security → App
passwords, delete that one, and generate a new one. Don't put it back in code.

## 2. Set up your environment file
```
cp .env.example .env
```
Open `.env` and fill in your Gmail address and the **new** app password you
just generated. This file is in `.gitignore` — it will never get committed.

## 3. Install dependencies
```
npm install
```
This pulls in `bcryptjs` (for password hashing) alongside `nodemailer`.

## 4. Hash the existing plaintext passwords (run once)
Your `customers.json` and `sellers.json` still have old plaintext passwords
in them from before. Run:
```
node migrate-passwords.js
```
This hashes them in place. Everyone can still log in with the same password
they had before — it's just stored safely now. Safe to run more than once.

## 5. Start the server
```
npm start
```
This runs `node --env-file=.env server.js`, which loads your `.env` file
automatically (built into Node 20+, no extra package needed).

## 6. (Free, recommended now) Stop your data from disappearing on restart
Render's free tier has no permanent disk — every restart, redeploy, or idle
spin-down wipes everything the app wrote at runtime (every signup, order,
wallet balance). That's almost certainly why some accounts have "disappeared"
and had to sign up again.

Until you can afford a real persistent disk (the sturdier long-term fix —
Render → your service → Disks tab, needs a paid instance type), `dataBackup.js`
gives you a free stopgap: it backs up every data file to a free Upstash Redis
database after every write, and restores the latest copy automatically the
moment the server boots — before anything else can read a wiped file.

1. Create a free account at https://upstash.com (no credit card needed).
2. Console → Create Database → any region, free tier.
3. On that database's "REST API" tab, copy `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`.
4. In Render → your service → Environment, add both as environment variables
   with those exact names.
5. Redeploy. No code changes needed — you'll see `Restored <file> from
   backup.` in the logs on every boot once it's wired up.

Until you add those two variables, the app behaves exactly as it does today
(a console warning, nothing else) — this is purely additive and safe to ship
before you've set it up.

---

## What actually changed

- **`mailer.js`** — credentials now come from `process.env`, not hardcoded strings.
- **`server.js`**:
  - Passwords are hashed with bcrypt on signup and password reset, and checked
    with `bcrypt.compare` on login — never stored or compared as plain text.
  - Real sessions: logging in or verifying signup now returns a `token`. Every
    endpoint that touches money or personal data (`wallet`, `deposit`,
    `checkout`, `orders`, `profile`, `save-address`, `review`,
    `remind-seller`) now requires that token in an `Authorization: Bearer
    <token>` header, and uses the *session's* email — not whatever email the
    client sends — to decide whose data to touch. Before this, anyone could
    spend from or deposit into any wallet just by knowing an email address.
  - Checkout now actually applies your 1.99% service fee: `subtotal +
    serviceFee = total`, calculated server-side from `settings.json` (never
    trusted from the client), and both figures are saved on the order.
  - Added `GET /api/fee-info` (public) so the frontend can preview the fee
    before checkout, and `POST /api/logout` to invalidate a token.
- **`settings.json`** (new) — holds the fee percentages so they can eventually
  be edited from an admin dashboard instead of hardcoded in the server.
- **`dashboard.html`** — sends the session token on every protected request,
  redirects to `/login` if the token is missing or the server rejects it, and
  the Cart panel + checkout modal now show Order amount / Service fee / Total
  as separate lines instead of one lump sum.
- **`seller-dashboard.html`** — now also requires a valid session token, not
  just the cached account object in localStorage.

## Known limitations still worth knowing about
- Sessions are stored in memory — they reset if the server restarts. Fine for
  now; a real deployment should move this to something persistent (Redis, a
  database table) so people aren't logged out on every deploy.
- JSON files as a database will not hold up under concurrent writes at real
  scale — fine for an MVP/demo, worth migrating before you have many
  simultaneous users.
- The seller dashboard is still mostly a placeholder (greeting + logout) —
  no orders, products, or wallet view yet. That's the next big piece.
