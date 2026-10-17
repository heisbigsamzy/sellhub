/* SellHub live notifications.
 * Polls for unread in-app notifications and shows them as a pop-up on screen the
 * moment they arrive (with a soft sound, a vibration, a tab-title badge and,
 * if the person allowed it, a system notification when the tab is in the
 * background). Used by the customer and seller dashboards:
 *   <script src="/live-notify.js" data-role="customer|seller" defer></script>
 * It reuses the page's own authedFetch, so it needs no extra login logic.
 */
(function () {
  'use strict';
  var sc = document.currentScript;
  var role = (sc && sc.getAttribute('data-role')) === 'seller' ? 'seller' : 'customer';
  var LIST_URL = role === 'seller' ? '/api/seller/notifications?unread=1' : '/api/notifications?unread=1';
  var READ_URL = role === 'seller' ? '/api/seller/notifications/mark-read' : '/api/notifications/mark-read';
  var STORE_KEY = 'sh_toasted_' + role;
  var ICON = '/icon-192.png?v=4';

  var ICONS = {
    'New Order': '🛍️', 'Order Received': '🧾', 'Processing': '⚙️', 'Shipped': '📦',
    'Out for Delivery': '🚚', 'Delivered': '✅', 'Cancelled': '✕', 'Deposit': '💰',
    'Withdrawal Paid': '💸', 'Withdrawal Returned': '↩️', 'Reminder': '⏰'
  };

  // ---- remember what has already been popped up (so a refresh never repeats it)
  var toasted = {};
  try { (JSON.parse(localStorage.getItem(STORE_KEY) || '[]') || []).forEach(function (id) { toasted[id] = 1; }); } catch (e) {}
  function saveToasted() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.keys(toasted).slice(-300).map(Number))); } catch (e) {}
  }

  // ---- pop-up UI lives in a shadow root so page CSS can't squash it
  var host = document.createElement('div');
  host.id = 'sh-live-host';
  host.setAttribute('aria-live', 'polite');
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.stack{position:fixed;top:max(12px,env(safe-area-inset-top));left:12px;right:12px;margin:0 auto;max-width:420px;z-index:2147483600;display:flex;flex-direction:column;gap:10px;pointer-events:none;font-family:Poppins,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.card{pointer-events:auto;background:#fff;color:#10241a;border-radius:18px;padding:12px 12px 12px 14px;box-shadow:0 18px 40px -12px rgba(8,45,30,.45),0 0 0 1px rgba(11,61,40,.08);display:flex;gap:12px;align-items:flex-start;border-left:5px solid #14a15f;cursor:pointer;animation:in .35s cubic-bezier(.2,.9,.3,1.2) both}' +
    '.card.out{animation:out .25s ease both}' +
    '.ic{flex:none;width:38px;height:38px;border-radius:12px;background:#e8f6ee;display:flex;align-items:center;justify-content:center;font-size:19px;line-height:1}' +
    '.tx{flex:1;min-width:0}' +
    '.ti{font-weight:700;font-size:14px;line-height:1.3;margin:0 0 2px}' +
    '.ms{font-size:13px;line-height:1.4;color:#41584c;margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}' +
    '.mt{font-size:11px;color:#7a8f84;margin-top:4px}' +
    '.x{flex:none;border:0;background:transparent;color:#7a8f84;font-size:20px;line-height:1;width:28px;height:28px;border-radius:8px;cursor:pointer;padding:0}' +
    '.x:hover{background:#eef3f0}' +
    '.ask .btns{display:flex;gap:8px;margin-top:10px}' +
    '.ask button.go{border:0;background:#0b3d28;color:#fff;font:600 14px Poppins,system-ui,sans-serif;padding:10px 18px;border-radius:999px;cursor:pointer}' +
    '.ask button.no{border:0;background:#eef3f0;color:#41584c;font:600 14px Poppins,system-ui,sans-serif;padding:10px 16px;border-radius:999px;cursor:pointer}' +
    '@keyframes in{from{opacity:0;transform:translateY(-16px) scale(.97)}to{opacity:1;transform:none}}' +
    '@keyframes out{to{opacity:0;transform:translateY(-12px)}}' +
    '@media (prefers-reduced-motion:reduce){.card,.card.out{animation:none}}' +
    '</style><div class="stack" id="stack"></div>';
  var stack = root.getElementById('stack');

  function mount() { if (!host.isConnected) document.body.appendChild(host); }

  function timeAgo(d) {
    var s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 45) return 'Just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' hr ago';
    return new Date(d).toLocaleDateString();
  }

  function markRead(id) {
    if (typeof window.authedFetch !== 'function') return;
    window.authedFetch(READ_URL, { method: 'POST', body: JSON.stringify({ notificationId: id }) })
      .then(function () { refreshPage(false); }).catch(function () {});
  }

  function removeCard(card) {
    if (!card || !card.parentNode) return;
    card.classList.add('out');
    setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 260);
  }

  function defaultOpen(n) {
    try {
      if (typeof window.showTab !== 'function') return;
      if (role === 'seller') {
        window.showTab(/Withdrawal/.test(n.type) ? 'wallet' : 'orders');
      } else {
        window.showTab(n.type === 'Deposit' ? 'wallet' : 'notifications');
      }
      window.scrollTo(0, 0);
    } catch (e) {}
  }

  function showToast(n) {
    mount();
    var card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'status');
    var ic = document.createElement('div'); ic.className = 'ic'; ic.textContent = ICONS[n.type] || '🔔';
    var tx = document.createElement('div'); tx.className = 'tx';
    var ti = document.createElement('p'); ti.className = 'ti'; ti.textContent = n.title || 'SellHub';
    var ms = document.createElement('p'); ms.className = 'ms'; ms.textContent = n.message || '';
    var mt = document.createElement('div'); mt.className = 'mt'; mt.textContent = timeAgo(n.date);
    tx.appendChild(ti); tx.appendChild(ms); tx.appendChild(mt);
    var x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
    card.appendChild(ic); card.appendChild(tx); card.appendChild(x);

    var timer;
    function arm() { clearTimeout(timer); timer = setTimeout(function () { removeCard(card); }, 10000); }
    card.addEventListener('mouseenter', function () { clearTimeout(timer); });
    card.addEventListener('mouseleave', arm);
    card.addEventListener('touchstart', function () { clearTimeout(timer); }, { passive: true });
    x.addEventListener('click', function (e) { e.stopPropagation(); clearTimeout(timer); removeCard(card); if (n.id) markRead(n.id); });
    card.addEventListener('click', function () {
      clearTimeout(timer); removeCard(card);
      if (n.id) markRead(n.id);
      (typeof window.SHNotifyOpen === 'function' ? window.SHNotifyOpen : defaultOpen)(n);
    });
    var askEl = stack.querySelector('.ask');
    stack.insertBefore(card, askEl);
    while (stack.children.length > 4) stack.removeChild(stack.firstChild);
    arm();
  }

  // ---- sound: two short soft notes; only after the person has touched the page once
  var ac = null, unlocked = false;
  function unlock() {
    if (unlocked) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = ac || new AC();
      if (ac.state === 'suspended') ac.resume();
      unlocked = true;
    } catch (e) {}
  }
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(function (ev) { window.addEventListener(ev, unlock, { passive: true }); });
  function chime() {
    try {
      if (!ac || ac.state !== 'running') return;
      var t = ac.currentTime;
      [[880, 0], [1318.5, 0.14]].forEach(function (p) {
        var o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = p[0];
        g.gain.setValueAtTime(0.0001, t + p[1]);
        g.gain.exponentialRampToValueAtTime(0.18, t + p[1] + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + p[1] + 0.35);
        o.connect(g); g.connect(ac.destination);
        o.start(t + p[1]); o.stop(t + p[1] + 0.4);
      });
    } catch (e) {}
  }

  // ---- tab title badge while the person is on another tab
  var baseTitle = document.title, unseen = 0;
  function setBadge() { document.title = unseen > 0 ? '(' + unseen + ') ' + baseTitle : baseTitle; }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { unseen = 0; setBadge(); }
    schedule(true);
  });

  // ---- real push: lets SellHub alert this device even when the site is closed
  var pushActive = false;
  function keyBytes(b64) {
    var p = (b64 + '===='.slice(b64.length % 4)).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(p), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function sameKey(buf, bytes) {
    if (!buf) return false; var a = new Uint8Array(buf); if (a.length !== bytes.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false; return true;
  }
  function ensurePush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
      if (Notification.permission !== 'granted' || typeof window.authedFetch !== 'function') return;
      var SYNC = 'sh_push_sync_' + role;
      navigator.serviceWorker.register('/sw.js').then(function () { return navigator.serviceWorker.ready; }).then(function (reg) {
        return fetch('/api/push/key').then(function (r) { return r.json(); }).then(function (k) {
          if (!k || !k.key) return;
          var want = keyBytes(k.key);
          return reg.pushManager.getSubscription().then(function (sub) {
            if (sub && !sameKey(sub.options && sub.options.applicationServerKey, want)) return sub.unsubscribe().then(function () { return null; });
            return sub;
          }).then(function (sub) {
            return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
          }).then(function (sub) {
            pushActive = true;
            var stamp = sub.endpoint + '|' + (Date.now() / 43200000 | 0);
            try { if (localStorage.getItem(SYNC) === stamp) return; } catch (e) {}
            return window.authedFetch('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) })
              .then(function (r) { return r.json(); }).then(function (r) { if (r && r.ok) { try { localStorage.setItem(SYNC, stamp); } catch (e) {} } });
          });
        });
      }).catch(function () {});
    } catch (e) {}
  }
  // Called on log out so the next person on this device doesn't get this account's alerts.
  function dropPush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return Promise.resolve();
      try { localStorage.removeItem('sh_push_sync_' + role); } catch (e) {}
      return navigator.serviceWorker.getRegistration().then(function (reg) {
        return reg && reg.pushManager.getSubscription();
      }).then(function (sub) {
        if (!sub) return;
        return fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) })
          .catch(function () {}).then(function () { return sub.unsubscribe(); });
      }).catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }

  // ---- system notification (only when allowed, and only when the tab is in the background)
  function systemNotify(n) {
    try {
      if (pushActive || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
      var opts = { body: n.message || '', icon: ICON, badge: ICON, tag: 'sh-' + n.id };
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (reg) {
          if (reg && reg.showNotification) reg.showNotification(n.title || 'SellHub', opts);
          else { var x = new Notification(n.title || 'SellHub', opts); x.onclick = function () { window.focus(); x.close(); }; }
        }).catch(function () {});
      } else {
        var x = new Notification(n.title || 'SellHub', opts); x.onclick = function () { window.focus(); x.close(); };
      }
    } catch (e) {}
  }

  // ---- make the rest of the page catch up (bell badge, orders, wallet)
  function refreshPage(full) {
    function call(name) { try { if (typeof window[name] === 'function') window[name](); } catch (e) {} }
    call('pollNotifBadge');
    if (full) { call('loadOrders'); call('loadWallet'); }
    try {
      var open = document.getElementById('panel-notifications');
      if (full && open && open.classList.contains('active')) call('loadNotifications');
    } catch (e) {}
  }

  // ---- polling
  var first = true, busy = false, timerId = null;
  function schedule(now) {
    clearTimeout(timerId);
    timerId = setTimeout(poll, now ? 200 : (document.hidden ? 20000 : 6000));
  }

  function poll() {
    if (busy || typeof window.authedFetch !== 'function') { schedule(false); return; }
    busy = true;
    window.authedFetch(LIST_URL).then(function (r) { return r.json(); }).then(function (r) {
      busy = false;
      if (!r || !r.ok) return;
      var list = (r.notifications || []).slice().sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
      var fresh = list.filter(function (n) { return !toasted[n.id]; });
      var cutoff = Date.now() - 3 * 86400000;

      if (first) {
        first = false;
        if (role === 'seller') {
          // The seller dashboard already shows its own "while you were away" box on load.
          fresh.forEach(function (n) { toasted[n.id] = 1; });
          fresh = [];
        } else {
          fresh = fresh.filter(function (n) { if (new Date(n.date).getTime() < cutoff) { toasted[n.id] = 1; return false; } return true; });
        }
      }
      if (!fresh.length) { saveToasted(); return; }

      var shown = fresh.slice(-3);
      fresh.forEach(function (n) { toasted[n.id] = 1; });
      saveToasted();
      if (fresh.length > shown.length) {
        showToast({ type: '', title: (fresh.length - shown.length) + ' more updates', message: 'Open your notifications to see everything.', date: new Date().toISOString() });
      }
      shown.forEach(showToast);
      chime();
      try { if (navigator.vibrate) navigator.vibrate([120, 70, 120]); } catch (e) {}
      if (document.hidden) { unseen += fresh.length; setBadge(); }
      shown.forEach(systemNotify);
      refreshPage(true);
      try { window.dispatchEvent(new CustomEvent('sh:notify', { detail: fresh })); } catch (e) {}
    }).catch(function () { busy = false; }).then(function () { schedule(false); });
  }

  // ---- system alerts: a plain-words card first, then the browser's own "Allow" box.
  // (Browsers never let a site skip that box, so the card tells people exactly what to tap.)
  var ASK_KEY = 'sh_alerts_later_' + role;
  var asking = false;
  function infoCard(title, text, goLabel, onGo) {
    mount();
    var card = document.createElement('div');
    card.className = 'card ask';
    var ic = document.createElement('div'); ic.className = 'ic'; ic.textContent = '🔔';
    var tx = document.createElement('div'); tx.className = 'tx';
    var ti = document.createElement('p'); ti.className = 'ti'; ti.textContent = title;
    var ms = document.createElement('p'); ms.className = 'ms'; ms.style.webkitLineClamp = 'unset'; ms.innerHTML = text;
    var btns = document.createElement('div'); btns.className = 'btns';
    if (goLabel) {
      var go = document.createElement('button'); go.className = 'go'; go.type = 'button'; go.textContent = goLabel;
      go.addEventListener('click', function () { removeCard(card); onGo(); });
      btns.appendChild(go);
    }
    var no = document.createElement('button'); no.className = 'no'; no.type = 'button'; no.textContent = goLabel ? 'Not now' : 'OK';
    no.addEventListener('click', function () { try { localStorage.setItem(ASK_KEY, String(Date.now())); } catch (e) {} removeCard(card); });
    btns.appendChild(no);
    tx.appendChild(ti); tx.appendChild(ms); tx.appendChild(btns);
    card.appendChild(ic); card.appendChild(tx);
    stack.appendChild(card);
  }
  function askPermission() {
    if (asking) return;
    try {
      var later = Number(localStorage.getItem(ASK_KEY) || 0);
      if (later && Date.now() - later < 86400000) return; // "Not now" hides it for a day
    } catch (e) {}
    // Never cover the checkout form: wait until it is closed.
    if (document.querySelector('#checkoutModal.active')) { setTimeout(askPermission, 8000); return; }
    var supported = ('Notification' in window) && ('serviceWorker' in navigator) && ('PushManager' in window);
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var who = role === 'seller' ? 'when you get an order' : 'about your order';
    if (!supported) {
      // iPhone Safari only allows alerts for apps added to the home screen.
      if (ios) {
        asking = true;
        infoCard('Get alerts ' + who,
          'On iPhone, add SellHub to your home screen first:<br>1. Tap the <b>Share</b> button in Safari<br>2. Tap <b>Add to Home Screen</b>, then <b>Add</b><br>3. Open SellHub from your home screen and tap <b>Turn on</b> when asked.', '', null);
      }
      return;
    }
    if (Notification.permission === 'granted') return;
    asking = true;
    if (Notification.permission === 'denied') {
      infoCard('Alerts are turned off', 'To get alerts ' + who + ', open your phone or browser settings, find SellHub (or this website) and allow <b>Notifications</b>.', '', null);
      return;
    }
    infoCard(role === 'seller' ? 'Get alerts when you get an order' : 'Get alerts about your order',
      'Tap "Turn on", then tap "Allow" on the next box. After that, SellHub will alert your phone even when the app is closed.', 'Turn on', function () {
        try { var p = Notification.requestPermission(); if (p && p.then) p.then(function (r) { if (r === 'granted') ensurePush(); }, function () {}); } catch (e) {}
      });
  }

  function start() { mount(); poll(); ensurePush(); setTimeout(askPermission, 4000); window.addEventListener('focus', function () { schedule(true); }); window.addEventListener('online', function () { schedule(true); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // handy for testing / other pages
  window.SHLive = { unsubscribe: dropPush, poll: function () { schedule(true); }, test: function () { showToast({ id: 0, type: 'New Order', title: 'New order received!', message: 'Order #1234 from Ada: Ankara dress. Your payout: ₦12,000.', date: new Date().toISOString() }); chime(); } };
})();
