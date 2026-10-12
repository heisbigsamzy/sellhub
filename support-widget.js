/* SellHub customer care: a floating tab on the side of every page. */
(function () {
  if (window.__shSupport) return; window.__shSupport = true;
  var WA = '2347044589579', EMAIL = 'support@sellhubmarket.xyz';
  function who() {
    try {
      var c = JSON.parse(localStorage.getItem('sellhub_customer') || 'null') || JSON.parse(localStorage.getItem('sellhub_seller') || 'null');
      return c && c.email ? ' My account: ' + c.email + '.' : '';
    } catch (e) { return ''; }
  }
  var css = '\
#shc-tab{position:fixed;right:16px;bottom:24px;z-index:900;width:50px;height:50px;padding:0;border:0;border-radius:50%;cursor:pointer;color:#fff;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 30% 25%,#2fc27a 0%,#0b6b3a 55%,#04301c 100%);box-shadow:0 10px 24px rgba(4,48,28,.45),inset 0 1px 1px rgba(255,255,255,.45),inset 0 -2px 3px rgba(0,0,0,.25),0 0 0 3px rgba(255,255,255,.9);transition:transform .18s,box-shadow .18s}\
#shc-tab svg{width:24px;height:24px;position:relative}\
#shc-tab i{position:absolute;right:1px;top:1px;width:11px;height:11px;border-radius:50%;background:#25d366;border:2px solid #fff}\
#shc-tab:hover{transform:scale(1.08);box-shadow:0 14px 30px rgba(4,48,28,.55),inset 0 1px 1px rgba(255,255,255,.5),inset 0 -2px 3px rgba(0,0,0,.25),0 0 0 3px #fff}\
#shc-tab:focus-visible{outline:3px solid #b6ff5c;outline-offset:3px}\
#shc-tab.pulse{animation:shcp 1.6s ease-out 3}\
@keyframes shcp{0%{box-shadow:0 10px 24px rgba(4,48,28,.45),0 0 0 3px rgba(255,255,255,.9),0 0 0 0 rgba(25,195,125,.8)}100%{box-shadow:0 10px 24px rgba(4,48,28,.45),0 0 0 3px rgba(255,255,255,.9),0 0 0 20px rgba(25,195,125,0)}}\
#shc-panel{position:fixed;right:16px;bottom:86px;transform:translateY(8px) scale(.97);transform-origin:bottom right;z-index:901;width:300px;max-width:calc(100vw - 28px);background:#fff;border-radius:22px;box-shadow:0 24px 60px rgba(0,0,0,.3);padding:20px;font-family:"Manrope",Arial,sans-serif;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}\
#shc-panel.open{opacity:1;pointer-events:auto;transform:none}\
#shc-panel h3{margin:0 0 4px;font-size:18px;color:#0b2f1c}\
#shc-panel p{margin:0 0 14px;font-size:13px;color:#5a6b61;line-height:1.4}\
#shc-panel a.shc-b{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:800;font-size:14px;padding:13px 14px;border-radius:14px;margin-bottom:9px}\
#shc-panel .wa{background:#25d366;color:#05301a}\
#shc-panel .em{background:#e8f5ee;color:#0b4d2c}\
#shc-panel .hp{background:#f1f3f2;color:#26332b}\
#shc-x{position:absolute;right:12px;top:10px;background:none;border:0;font-size:24px;cursor:pointer;color:#5a6b61;line-height:1}\
@media (max-width:640px){#shc-tab{bottom:86px;right:12px;width:46px;height:46px}#shc-tab svg{width:22px;height:22px}#shc-panel{bottom:142px;right:10px}}\
@media (prefers-reduced-motion:reduce){#shc-tab.pulse{animation:none}#shc-tab,#shc-panel{transition:none}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var msg = encodeURIComponent('Hello SellHub, I need help with...' + who());
  var tab = document.createElement('button');
  tab.id = 'shc-tab'; tab.type = 'button'; tab.setAttribute('aria-label', 'Open customer care'); tab.setAttribute('aria-expanded', 'false');
  tab.title = 'Customer Care';
  tab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 16a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2zM3 16a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/><path d="M18 18v1a3 3 0 0 1-3 3h-3"/></svg><i></i>'; tab.className = 'pulse';
  var panel = document.createElement('div');
  panel.id = 'shc-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Customer care');
  panel.innerHTML = '<button id="shc-x" type="button" aria-label="Close">&times;</button><h3>We are here to help</h3><p>Questions about an order, payment or your store? Message us.</p>' +
    '<a class="shc-b wa" target="_blank" rel="noopener" href="https://wa.me/' + WA + '?text=' + msg + '">💬 Chat on WhatsApp <small style="font-weight:700;opacity:.7;margin-left:auto">Fastest</small></a>' +
    '<a class="shc-b em" href="mailto:' + EMAIL + '?subject=SellHub%20support">✉️ ' + EMAIL + '</a>' +
    '<a class="shc-b hp" href="/help">❓ Help Center &amp; FAQs</a>';
  function toggle(open) { var o = open === undefined ? !panel.classList.contains('open') : open; panel.classList.toggle('open', o); tab.setAttribute('aria-expanded', String(o)); tab.classList.remove('pulse'); }
  tab.addEventListener('click', function () { toggle(); });
  panel.querySelector('#shc-x').addEventListener('click', function () { toggle(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggle(false); });
  document.addEventListener('click', function (e) { if (!panel.contains(e.target) && !tab.contains(e.target)) toggle(false); });
  function mount() { document.body.appendChild(panel); document.body.appendChild(tab); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
