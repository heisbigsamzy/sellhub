// dataBackup.js — a free, zero-cost safety net against Render's free-tier
// ephemeral disk wiping customers.json/sellers.json/orders.json/etc on
// every restart, redeploy, or idle spin-down.
//
// This does NOT replace the local JSON files or touch any business logic —
// server.js still reads/writes customers.json, sellers.json and the rest
// exactly as it always has. This module just also pushes a copy of every
// file to a free Upstash Redis database (over plain HTTPS, using the
// built-in fetch — no new heavy dependency, same style as mailer.js /
// whatsapp.js) whenever something changes, and pulls the latest copy of
// every file back down the moment the server boots, BEFORE anything else
// reads the local files. So even when Render wipes the disk, the data is
// restored within a second or two of the new instance starting.
//
// This is a stopgap, not a replacement for a real persistent disk — see
// the note at the top of server.js. It fixes "my friends' accounts keep
// disappearing" for free, today; a persistent Render disk (or a proper
// database) is still the sturdier long-term fix once that's affordable.
//
// One-time setup (free, no credit card required):
//   1. Create a free account at https://upstash.com
//   2. Console -> Create Database -> any region, free tier is fine.
//   3. On the database's "REST API" tab, copy the two values shown there:
//      UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
//   4. In Render -> your service -> Environment, add both as environment
//      variables with those exact names and the values you copied.
//   5. Redeploy. Nothing else to do — restore happens automatically on
//      every boot, and backups happen automatically on every write.
//
// Until those two environment variables are set, this module quietly does
// nothing (same pattern as every other optional integration in this app —
// see mailer.js, whatsapp.js) and the app behaves exactly as it does today.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const backupEnabled = !!(UPSTASH_URL && UPSTASH_TOKEN);

if (!backupEnabled) {
  console.warn(
    '⚠️  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.\n' +
    '   Your data will NOT survive a Render restart/redeploy/spin-down until\n' +
    '   you add a free Upstash database — see dataBackup.js for setup steps.'
  );
}

// Sends one Redis command through Upstash's REST API, e.g.
// redisCommand(['SET', 'key', 'value']) or redisCommand(['GET', 'key']).
// This is Upstash's generic command endpoint, the most stable part of
// their REST API — if Upstash ever changes their shorthand path-style
// endpoints, this form keeps working.
async function redisCommand(command) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || `Upstash error (${res.status})`);
  }
  return data.result;
}

// Debounced per file, so a burst of writes to the same file within a
// couple of seconds (e.g. several requests landing close together)
// collapses into one backup call instead of spending the free tier's
// command quota on every single one.
const pendingTimers = {};
const DEBOUNCE_MS = 1500;

// Fire-and-forget by design, exactly like the WhatsApp/email sends
// elsewhere in this app: a backup hiccup should never break (or even
// delay) the actual request that triggered it.
function backupFile(fileName, contents) {
  if (!backupEnabled) return;
  clearTimeout(pendingTimers[fileName]);
  pendingTimers[fileName] = setTimeout(() => {
    redisCommand(['SET', `sellhub:${fileName}`, contents]).catch(err => {
      console.log('Data backup error for', fileName, ':', err.message);
    });
  }, DEBOUNCE_MS);
}

// Called once at boot, before the server starts accepting requests. Pulls
// the last good copy of every data file down from Upstash and writes it
// into place via writeLocalFile — this is the step that actually undoes
// Render's disk wipe. Safe to call even when nothing has ever been backed
// up yet (GET just returns null and that file is left as-is).
async function restoreAllFiles(writeLocalFile, fileNames) {
  if (!backupEnabled) return;
  for (const fileName of fileNames) {
    try {
      const contents = await redisCommand(['GET', `sellhub:${fileName}`]);
      if (contents) {
        writeLocalFile(fileName, contents);
        console.log('Restored', fileName, 'from backup.');
      }
    } catch (err) {
      console.log('Data restore error for', fileName, ':', err.message);
    }
  }
}

module.exports = { backupFile, restoreAllFiles, backupEnabled };
