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
#shc-tab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:900;background:#0b6b3a;color:#fff;border:0;cursor:pointer;font:800 15px/1 "Manrope",Arial,sans-serif;letter-spacing:.02em;padding:16px 12px;border-radius:14px 0 0 14px;box-shadow:-6px 8px 22px rgba(11,107,58,.45);writing-mode:vertical-rl;text-orientation:mixed;display:flex;align-items:center;gap:8px}\
#shc-tab .ic{writing-mode:horizontal-tb;font-size:20px}\
#shc-tab:hover{background:#09562f}\
#shc-tab.pulse{animation:shcp 1.6s ease-out 3}\
@keyframes shcp{0%{box-shadow:-6px 8px 22px rgba(11,107,58,.45),0 0 0 0 rgba(25,195,125,.7)}100%{box-shadow:-6px 8px 22px rgba(11,107,58,.45),0 0 0 22px rgba(25,195,125,0)}}\
#shc-panel{position:fixed;right:14px;top:50%;transform:translateY(-50%) scale(.96);z-index:901;width:300px;max-width:calc(100vw - 28px);background:#fff;border-radius:22px;box-shadow:0 24px 60px rgba(0,0,0,.3);padding:20px;font-family:"Manrope",Arial,sans-serif;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}\
#shc-panel.open{opacity:1;pointer-events:auto;transform:translateY(-50%) scale(1)}\
#shc-panel h3{margin:0 0 4px;font-size:18px;color:#0b2f1c}\
#shc-panel p{margin:0 0 14px;font-size:13px;color:#5a6b61;line-height:1.4}\
#shc-panel a.shc-b{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:800;font-size:14px;padding:13px 14px;border-radius:14px;margin-bottom:9px}\
#shc-panel .wa{background:#25d366;color:#05301a}\
#shc-panel .em{background:#e8f5ee;color:#0b4d2c}\
#shc-panel .hp{background:#f1f3f2;color:#26332b}\
#shc-x{position:absolute;right:12px;top:10px;background:none;border:0;font-size:24px;cursor:pointer;color:#5a6b61;line-height:1}\
@media (max-width:640px){#shc-tab{top:auto;bottom:86px;transform:none;writing-mode:horizontal-tb;border-radius:99px 0 0 99px;padding:13px 16px 13px 14px;font-size:14px}\
#shc-panel{top:auto;bottom:140px;right:10px;transform:scale(.96)}#shc-panel.open{transform:scale(1)}}\
@media (prefers-reduced-motion:reduce){#shc-tab.pulse{animation:none}#shc-panel{transition:none}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var msg = encodeURIComponent('Hello SellHub, I need help with...' + who());
  var tab = document.createElement('button');
  tab.id = 'shc-tab'; tab.type = 'button'; tab.setAttribute('aria-label', 'Open customer care'); tab.setAttribute('aria-expanded', 'false');
  tab.innerHTML = '<span class="ic">💬</span><span>Customer Care</span>'; tab.className = 'pulse';
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
