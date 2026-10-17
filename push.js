'use strict';
// Web Push (RFC 8030 + VAPID RFC 8292 + message encryption RFC 8291), using only Node's built-in
// crypto and https — no extra packages. This is what lets a phone or computer show a SellHub
// notification even when the site is closed.
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = str => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const out = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    prev = crypto.createHmac('sha256', prk).update(Buffer.concat([prev, info, Buffer.from([i])])).digest();
    out.push(prev);
  }
  return Buffer.concat(out).slice(0, length);
}

// A fresh VAPID key pair (the site's "sender identity" for push services).
function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

function vapidAuthHeader(endpoint, vapid, subject, now) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor((now || Date.now()) / 1000) + 12 * 3600, sub: subject }));
  const pub = unb64u(vapid.publicKey);
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: vapid.privateKey },
    format: 'jwk'
  });
  const sig = crypto.sign('sha256', Buffer.from(header + '.' + claims), { key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + header + '.' + claims + '.' + b64u(sig) + ', k=' + vapid.publicKey;
}

// RFC 8291 "aes128gcm" encryption of one small message for one subscription.
// `fixed` (ephemeral private key + salt) exists only so the RFC's own test vector can be checked.
function encryptPayload(subscription, plaintext, fixed) {
  const uaPublic = unb64u(subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed && fixed.asPrivate) ecdh.setPrivateKey(unb64u(fixed.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = fixed && fixed.salt ? unb64u(fixed.salt) : crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, secret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // 0x02 = last (only) record
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, encrypted]);
}

// Sends one push. Resolves { ok, status, gone }: gone=true means the subscription is dead and should be deleted.
function sendPush(subscription, payload, vapid, subject, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    try {
      const url = new URL(subscription.endpoint);
      const body = encryptPayload(subscription, JSON.stringify(payload));
      const lib = url.protocol === 'http:' ? http : https;
      const req = lib.request({
        method: 'POST', hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search,
        headers: {
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          'TTL': String(opts.ttl || 86400),
          'Urgency': opts.urgency || 'high',
          'Authorization': vapidAuthHeader(subscription.endpoint, vapid, subject)
        },
        timeout: 15000
      }, res => {
        let text = '';
        res.on('data', d => { if (text.length < 300) text += d; });
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410, detail: text.slice(0, 200) }));
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', err => resolve({ ok: false, status: 0, gone: false, error: err.message }));
      req.end(body);
    } catch (err) {
      resolve({ ok: false, status: 0, gone: false, error: err.message });
    }
  });
}

module.exports = { generateVapidKeys, encryptPayload, vapidAuthHeader, sendPush, b64u, unb64u };
