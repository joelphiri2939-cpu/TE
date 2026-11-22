/* ui/voice-commands.js — INDEPENDENT command engine.
 * Works with ANY text source: speech recognizer, keyboard, or tests. Needs no TTS.
 * In : "teachmate:voice-command"  detail {text, confidence?, autoRun?}   or TeachMateVoice.submit(text, confidence)
 * Out: "teachmate:assistant-response" detail {text, ok}  (always written to the on-screen log; TTS is optional listener)
 * Rule: if not sure, ASK — never guess. Medium/high-risk tasks need a spoken "yes" after a read-back. */
(function () {
  'use strict';
  var A = window.TeachMateVoiceActions;
  if (!A) { console.error('[voice-commands] load voice-actions.js first'); return; }

  var MIN_CONF = 0.6, PENDING_MS = 30000, DUP_MS = 3000;
  var state = 'IDLE', pending = null, ctx = { classValue: null, classLabel: null };
  var lastText = '', lastAt = 0;
  var REPEAT = 'I\u2019m not sure I understood. Could you please repeat that?';
  var YES = /^(yes|yeah|yep|confirm|confirmed|proceed|go ahead|do it|correct|that is correct|that s correct|right)\b/;
  var UNDO = /^(undo|revert|wrong|incorrect|not right|that s wrong|that is wrong|that was wrong)\b/;
  var CANCEL = /^(cancel|never mind|nevermind|stop|forget it|no|nope|don t|do not)\b/;

  function setState(s) { state = s; var e = document.getElementById('tmv-state'); if (e) e.textContent = s.toLowerCase().replace('_', ' '); }
  function logYou(text) {
    var log = document.getElementById('tmv-log');
    if (!log) return;
    var d = document.createElement('div'); d.className = 'tmv-msg you'; d.textContent = '\uD83C\uDF99 ' + text;
    log.appendChild(d); log.scrollTop = log.scrollHeight;
  }
  function respond(text, ok) {
    setState('RESPONDING');
    var log = document.getElementById('tmv-log');
    if (log) { var d = document.createElement('div'); d.className = 'tmv-msg ' + (ok === false ? 'bad' : 'ok'); d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; }
    try { document.dispatchEvent(new CustomEvent('teachmate:assistant-response', { bubbles: true, detail: { text: text, ok: ok !== false } })); } catch (e) {}
    setState('IDLE');
  }

  /* ---------- matching (fuzzy to tolerate recognition errors) ---------- */
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 1; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function altHit(alt, t, toks) {
    if (alt.indexOf(' ') !== -1) return (' ' + t + ' ').indexOf(' ' + alt + ' ') !== -1 ? alt.length : 0;
    for (var i = 0; i < toks.length; i++) {
      if (toks[i] === alt) return alt.length;
      if (alt.length >= 5 && toks[i].length >= 5 && lev(toks[i], alt) <= 1) return alt.length - 1;
    }
    return 0;
  }
  function score(task, t, toks) {
    var matched = 0, spec = 0;
    task.kw.forEach(function (g) {
      var best = 0; g.forEach(function (a) { var h = altHit(A.norm(a), t, toks); if (h > best) best = h; });
      if (best) { matched++; spec += best; }
    });
    return { task: task, matched: matched, total: task.kw.length, spec: spec };
  }

  /* ---------- UNDERSTAND: returns {task, params} | {ask} | {guess} ---------- */
  function understand(text) {
    var t = A.norm(text), toks = t.split(' ');
    if (/\b(what can (i|you)|list commands|voice help|what commands)\b/.test(t))
      return { say: 'I can open attendance, results, fees, messages, class management and the lesson planner; open a class like \u201cGrade 8 attendance\u201d; save, view history, export or clear on those pages; search learners; sort and export the class list; count learners; in attendance mark learners or the whole class present or absent (even \u201ceveryone present except Peter\u201d), set the term and week, save, and ask who is absent; in fees ask who owes, how much a learner paid, overdue and totals. After every change I show a pop-up so you can confirm or undo. For risky actions I\u2019ll ask you to confirm first.', ok: true };

    var s = tasks().map(function (k) { return score(k, t, toks); });
    var full = s.filter(function (x) { return x.matched === x.total; })
      .sort(function (a, b) { return b.total - a.total || b.spec - a.spec; });
    if (full.length) {
      if (full[1] && full[1].task.id !== full[0].task.id && full[1].total === full[0].total && full[1].spec === full[0].spec)
        return { ask: 'That could mean \u201c' + full[0].task.label + '\u201d or \u201c' + full[1].task.label + '\u201d. Which one do you want?' };
      return finish(full[0].task, t);
    }
    var part = s.filter(function (x) { return x.matched >= 2 && x.matched / x.total >= 0.66; })
      .sort(function (a, b) { return (b.matched / b.total) - (a.matched / a.total) || b.spec - a.spec; });
    if (part.length && (!part[1] || part[1].matched / part[1].total < part[0].matched / part[0].total))
      return { guess: part[0].task, t: t };
    return { ask: REPEAT };
  }
  function tasks() { return A.TASKS; }

  function finish(task, t) {
    var params = {};
    if (task.parse) {
      var pr = task.parse(t);
      if (pr.ask) return { ask: pr.ask };
      params = pr.params || {};
    }
    if (task.slot) {
      var m = t.match(task.slot);
      if (!m || !m[1]) return { ask: 'What should I use for \u201c' + task.label + '\u201d? Please say the full instruction again.' };
      params.slot = m[1].trim();
    }
    var said = /(grade|class|form)\s*\d+/.test(t);
    if (task.classSection && said) {
      var c = A.matchClass(A.CLASS_SEL[task.classSection], t);
      if (!c.options.length) return { ask: 'I can\u2019t see the class list yet. Open ' + task.classSection + ' once, then try again.' };
      if (c.hits && c.hits.length === 1) { params.classValue = c.hits[0].value; params.classLabel = c.hits[0].text; }
      else if (c.hits && c.hits.length > 1) return { ask: 'Which class: ' + c.hits.map(function (o) { return o.text; }).join(', ') + '?', clarify: { task: task } };
      else return { ask: 'I couldn\u2019t find that class. Which one: ' + c.options.slice(0, 6).join(', ') + '?', clarify: { task: task } };
    } else if (task.classSection && /\b(that|their|same|this)\b/.test(t) && ctx.classValue) {
      params.classValue = ctx.classValue; params.classLabel = ctx.classLabel;
    }
    return { task: task, params: params };
  }

  /* ---------- VALIDATE ---------- */
  function needsConfirm(task) { return task.risk === 'medium' || task.risk === 'high'; }
  function readBack(task, params) {
    var where = params.classLabel ? ' for ' + params.classLabel : (ctx.classLabel ? ' (current class: ' + ctx.classLabel + ')' : '');
    var warn = task.risk === 'high' ? 'This is a high-risk action. ' : '';
    return warn + 'You want me to ' + (task.confirmText || task.label) + where + '. Say yes to continue, or cancel.';
  }

  /* ---------- EXECUTE ---------- */
  var V = function () { return window.TeachMateVoiceVerify; };
  var shownAt = 0;
  async function execute(task, params) {
    setState('EXECUTING');
    try {
      var res = await task.run(params);
      setState('VERIFYING');
      if (res.ok && params.classValue) { ctx.classValue = params.classValue; ctx.classLabel = params.classLabel; }
      var v = res.verify;
      if (v && V()) {
        var q = v.question || 'Is that correct? Say yes, or say undo.';
        shownAt = Date.now();
        V().show({
          title: v.title, lines: v.lines, warn: v.warn, question: q, yesLabel: v.yesLabel, noLabel: v.noLabel,
          onYes: function () { respond('Confirmed. Thank you.', true); },
          onNo: async function () {
            if (v.undo) {
              setState('EXECUTING');
              try { respond(await v.undo(), true); } catch (e) { respond('I couldn\u2019t undo that automatically. Please check the screen.', false); }
            } else respond('Okay, I\u2019ll treat that as not right. Please repeat what you need, or correct it on screen.', true);
          }
        });
        return respond(res.message + ' ' + q, res.ok);
      }
      respond(res.message, res.ok);
    } catch (e) {
      console.error('[voice] task failed:', task.id, e);
      respond('That didn\u2019t work: ' + task.label + ' failed. Nothing was confirmed as done.', false);
    }
  }

  async function dispatch(u) {
    if (u.say) return respond(u.say, u.ok);
    if (u.ask) { pending = u.clarify ? { kind: 'class', task: u.clarify.task, at: Date.now() } : null; return respond(u.ask, true); }
    if (u.guess) {
      pending = { kind: 'guess', task: u.guess, t: u.t, at: Date.now() };
      return respond('I think you mean \u201c' + u.guess.label + '\u201d. Is that right? Say yes, or repeat the instruction.', true);
    }
    if (needsConfirm(u.task)) {
      pending = { kind: 'confirm', task: u.task, params: u.params, at: Date.now() };
      setState('AWAITING_CONFIRMATION');
      var msg = readBack(u.task, u.params); setState('IDLE');
      return respond(msg, true);
    }
    return execute(u.task, u.params);
  }

  /* ---------- ENTRY ---------- */
  async function submit(text, confidence) {
    text = String(text || '').trim(); if (!text) return;
    var now = Date.now();
    var ctl = /^(yes|yeah|yep|no|nope|undo|cancel|correct)$/.test(A.norm(text));
    if (!ctl && text === lastText && now - lastAt < DUP_MS) return;
    if (state !== 'IDLE') return respond('One moment, I\u2019m still working on the last instruction.', false);
    lastText = text; lastAt = now;
    logYou(text);
    var t = A.norm(text);
    var vv = V();
    if (vv && vv.isOpen()) {
      if (YES.test(t)) { if (now - shownAt < 1200) return; vv.accept(); return; }   // ignore an echoed "yes" that arrives before the pop-up could be read
      if (UNDO.test(t) || CANCEL.test(t)) { vv.reject(); return; }
      return respond('Please check the pop-up first: say yes if it is correct, or say undo.', true);
    }
    if (pending && now - pending.at > PENDING_MS) pending = null;

    if (pending) {
      var p = pending;
      if (CANCEL.test(t)) { pending = null; return respond('Okay, cancelled. Nothing was changed.', true); }
      if (typeof confidence === 'number' && confidence < MIN_CONF) return respond(REPEAT, true);
      if (p.kind === 'confirm' || p.kind === 'guess') {
        if (YES.test(t)) {
          pending = null;
          if (p.kind === 'confirm') return execute(p.task, p.params);
          var f = finish(p.task, p.t);
          return dispatch(f);
        }
        pending = null;           // anything else = a fresh instruction
      } else if (p.kind === 'class') {
        var c = A.matchClass(A.CLASS_SEL[p.task.classSection], t);
        if (c.hits && c.hits.length === 1) { pending = null; return dispatch({ task: p.task, params: { classValue: c.hits[0].value, classLabel: c.hits[0].text } }); }
        return respond('Sorry, which class? You can also say cancel.', true);
      }
    }
    if (typeof confidence === 'number' && confidence < MIN_CONF) return respond(REPEAT, true);
    if (t.split(' ').length < 2 && !/^(help|home|back|logout)$/.test(t)) return respond(REPEAT, true);

    setState('UNDERSTANDING');
    var u = understand(text);
    setState('VALIDATING'); setState('IDLE');
    return dispatch(u);
  }

  /* ---------- UI: editable transcript, works with no mic and no TTS ---------- */
  function buildUI() {
    if (document.getElementById('tmv-root') || !document.body) return;
    var st = document.createElement('style');
    st.textContent = '#tmv-root{position:fixed;left:8px;right:8px;bottom:8px;z-index:99998;font:14px system-ui,sans-serif;display:none}#tmv-root.open{display:block}' +
      '#tmv-card{background:#fff;color:#111;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.25);padding:10px;max-width:520px;margin:auto}' +
      '#tmv-log{max-height:28vh;overflow:auto;margin-bottom:8px}.tmv-msg{padding:6px 10px;border-radius:10px;margin:4px 0;background:#ecfdf5}.tmv-msg.bad{background:#fef2f2}.tmv-msg.you{background:#eff6ff;text-align:right}' +
      '#tmv-row{display:flex;gap:6px}#tmv-in{flex:1;padding:9px;border:1px solid #ccc;border-radius:10px;font-size:15px}#tmv-go{padding:9px 14px;border:0;border-radius:10px;background:#16a34a;color:#fff;font-weight:700}' +
      '#tmv-fab{position:fixed;right:14px;bottom:84px;z-index:99997;width:48px;height:48px;border-radius:50%;border:0;background:#16a34a;color:#fff;font-size:22px;box-shadow:0 3px 12px rgba(0,0,0,.3)}#tmv-state{font-size:11px;color:#666;margin:0 0 4px}';
    document.head.appendChild(st);
    var root = document.createElement('div'); root.id = 'tmv-root';
    root.innerHTML = '<div id="tmv-card"><div id="tmv-state">idle</div><div id="tmv-log"></div><div id="tmv-row"><input id="tmv-in" placeholder="Say or type a command" autocomplete="off"><button id="tmv-go">Run</button></div></div>';
    document.body.appendChild(root);
    var fab = document.createElement('button'); fab.id = 'tmv-fab'; fab.textContent = '\uD83C\uDF99'; fab.setAttribute('aria-label', 'Voice commands');
    document.body.appendChild(fab);
    fab.onclick = function () { root.classList.toggle('open'); };
    var inp = root.querySelector('#tmv-in');
    inp.setAttribute('data-tm-voice-command', '1');
    function go() { var v = inp.value; inp.value = ''; submit(v); }
    root.querySelector('#tmv-go').onclick = go;
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }

  document.addEventListener('teachmate:voice-command', function (e) {
    var d = e.detail || {}; buildUI();
    var root = document.getElementById('tmv-root'); if (root) root.classList.add('open');
    if (d.autoRun) return submit(d.text, d.confidence);
    var inp = document.getElementById('tmv-in'); if (inp) inp.value = d.text || '';
  });
  if (document.readyState !== 'loading') buildUI(); else document.addEventListener('DOMContentLoaded', buildUI);
  window.TeachMateVoice = { submit: submit, understand: understand, getState: function () { return state; } };
})();
