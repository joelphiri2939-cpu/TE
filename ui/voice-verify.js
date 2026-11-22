/* ui/voice-verify.js — "Did that go right?" pop-up shown after voice tasks.
 * Nothing done by voice is treated as final until the user confirms (button or by saying yes / undo). */
(function () {
  'use strict';
  var cur = null;
  function css() {
    if (document.getElementById('tmvv-css')) return;
    var s = document.createElement('style'); s.id = 'tmvv-css';
    s.textContent = '#tmvv{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:14px;font:15px system-ui,sans-serif}' +
      '#tmvv .c{background:#fff;color:#111;border-radius:16px;max-width:460px;width:100%;max-height:85vh;overflow:auto;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.35)}' +
      '#tmvv h3{margin:0 0 8px;font-size:17px}#tmvv ul{margin:6px 0 10px;padding-left:18px}#tmvv li{margin:3px 0}' +
      '#tmvv .q{font-weight:700;margin:10px 0}#tmvv .b{display:flex;gap:8px}#tmvv button{flex:1;padding:12px;border:0;border-radius:12px;font-size:15px;font-weight:700}' +
      '#tmvv .y{background:#16a34a;color:#fff}#tmvv .n{background:#fee2e2;color:#991b1b}#tmvv .w{background:#fef3c7;color:#92400e;padding:6px 8px;border-radius:8px;margin-bottom:8px}';
    document.head.appendChild(s);
  }
  function close() { var e = document.getElementById('tmvv'); if (e) e.remove(); cur = null; }
  /* opt: {title, lines[], warn?, question, yesLabel, noLabel, onYes(), onNo()} */
  function show(opt) {
    css(); close(); cur = opt;
    var o = document.createElement('div'); o.id = 'tmvv'; o.setAttribute('role', 'dialog');
    var c = document.createElement('div'); c.className = 'c'; o.appendChild(c);
    var h = document.createElement('h3'); h.textContent = opt.title || 'Please check'; c.appendChild(h);
    if (opt.warn) { var w = document.createElement('div'); w.className = 'w'; w.textContent = opt.warn; c.appendChild(w); }
    var ul = document.createElement('ul');
    (opt.lines || []).forEach(function (l) { var li = document.createElement('li'); li.textContent = l; ul.appendChild(li); });
    c.appendChild(ul);
    var q = document.createElement('div'); q.className = 'q'; q.textContent = opt.question || 'Is that correct?'; c.appendChild(q);
    var b = document.createElement('div'); b.className = 'b'; c.appendChild(b);
    var no = document.createElement('button'); no.className = 'n'; no.textContent = opt.noLabel || 'Undo'; no.onclick = reject;
    var yes = document.createElement('button'); yes.className = 'y'; yes.textContent = opt.yesLabel || 'Correct'; yes.onclick = accept;
    b.appendChild(no); b.appendChild(yes);
    document.body.appendChild(o);
  }
  function accept() { if (!cur) return false; var c = cur; close(); if (c.onYes) c.onYes(); return true; }
  function reject() { if (!cur) return false; var c = cur; close(); if (c.onNo) c.onNo(); return true; }
  window.TeachMateVoiceVerify = { show: show, accept: accept, reject: reject, isOpen: function () { return !!cur; }, close: close };
})();
