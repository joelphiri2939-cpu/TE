/* ui/voice-commands.js — INDEPENDENT command engine (needs neither the recognizer nor the TTS).
 * In : "teachmate:voice-command" {text, confidence?, autoRun?}  or TeachMateVoice.submit(text, confidence)
 * Out: "teachmate:assistant-response" {text, ok}
 * Understanding = nearest match against TeachMate's own command phrases, by spelling AND sound, weighted so that
 * distinctive words (attendance, history, unpaid) count more than common ones (open, show). Misheard speech is
 * never guessed silently: when unsure it offers the closest TeachMate commands as tappable / speakable choices. */
(function () {
  'use strict';
  var A = window.TeachMateVoiceActions, M = window.TeachMateVoiceMatch;
  if (!A || !M) { console.error('[voice-commands] load voice-match.js and voice-actions.js first'); return; }

  var MIN_CONF = 0.6, PENDING_MS = 45000, DUP_MS = 3000;
  var RUN_AT = 0.85, SUGGEST_AT = 0.33;
  var state = 'IDLE', pending = null, ctx = { classValue: null, classLabel: null };
  var lastText = '', lastAt = 0, shownAt = 0;
  var REPEAT = 'I\u2019m not sure I understood. Could you please repeat that?';
  var YES = /^(yes|yeah|yep|confirm|confirmed|proceed|go ahead|do it|correct|that is correct|that s correct|right|ok|okay)\b/;
  var UNDO = /^(undo|revert|wrong|incorrect|not right|that s wrong|that is wrong|that was wrong)\b/;
  var CANCEL = /^(cancel|never mind|nevermind|stop|forget it|no|nope|none|neither|don t|do not)\b/;
  var tasks = function () { return A.TASKS; };
  var FILLER = /^(the|a|an|uh|um|umm|hmm|mm|ah|oh|and|so|but|yeah|ok|okay|er|eh|huh|i|it|is|to|of)$/;
  var lastSpoken = '', lastSpokenAt = 0;
  function ttsSpeaking() { try { var T = window.TeachMateTTS; return !!(T && T.isSpeaking && T.isSpeaking()); } catch (e) { return false; } }

  /* ---------- learning from the user's own confirmations (their accent, their room) ---------- */
  var LKEY = 'tm_voice_learned';
  function loadLearned() { try { return JSON.parse(window.localStorage.getItem(LKEY) || '[]'); } catch (e) { return []; } }
  function learn(t, id) {
    try {
      if (!t || t.split(' ').length > 9) return;
      var a = loadLearned(), f = a.filter(function (x) { return x.t === t; })[0];
      if (f) { f.id = id; f.n = (f.n || 1) + 1; } else a.push({ t: t, id: id, n: 1 });
      window.localStorage.setItem(LKEY, JSON.stringify(a.slice(-300)));
    } catch (e) {}
  }
  function phraseSim(a, b) {
    var A1 = a.split(' '), B1 = b.split(' ');
    if (Math.abs(A1.length - B1.length) > 1) return 0;
    var tot = 0; A1.forEach(function (w) { var m = 0; B1.forEach(function (v) { var x = M.tsim(w, v); if (x > m) m = x; }); tot += m; });
    return tot / Math.max(A1.length, B1.length);
  }
  function recall(t) {
    var best = null, bs = 0;
    loadLearned().forEach(function (x) { var s2 = phraseSim(t, x.t); if (s2 > bs) { bs = s2; best = x; } });
    return bs >= 0.9 ? best : null;
  }

  function setState(s) { state = s; var e = document.getElementById('tmv-state'); if (e) e.textContent = s.toLowerCase().replace('_', ' '); }
  /* TeachMate answers by VOICE. Nothing is written on screen, except a one-line note when no voice is available. */
  var toastTimer = null, idleTimer = null;
  function canSpeak() {
    var T = window.TeachMateTTS;
    return !!(('speechSynthesis' in window) || (T && T.isReady && T.isReady()));
  }
  function logLine(cls, text) {
    if (cls === 'you' || canSpeak()) return;
    var t = document.getElementById('tmv-toast'); if (!t) return;
    t.textContent = text; t.style.display = 'block';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.style.display = 'none'; }, 4500);
  }
  function scheduleIdleClose() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      var root = document.getElementById('tmv-root'), V0 = window.TeachMateVoiceVerify;
      var recording = document.querySelector('.tm-speech-mic.tm-speaking');
      if (!root || recording || pending || state !== 'IDLE' || (V0 && V0.isOpen())) return scheduleIdleClose();
      root.classList.remove('open');
    }, 9000);
  }
  function respond(text, ok, chips) {
    lastSpoken = A.norm(text); lastSpokenAt = Date.now();
    setState('RESPONDING');
    logLine(ok === false ? 'bad' : 'ok', text);
    if (document.getElementById('tmv-root') && document.getElementById('tmv-root').classList.contains('open')) scheduleIdleClose();
    try { document.dispatchEvent(new CustomEvent('teachmate:assistant-response', { bubbles: true, detail: { text: text, ok: ok !== false } })); } catch (e) {}
    setState('IDLE');
  }

  /* ---------- cleaning the heard text (TeachMate-aware) ---------- */
  var CONTROL = ['present', 'absent', 'except', 'term', 'week', 'grade', 'class', 'form', 'attendance', 'register', 'results', 'history',
    'learners', 'students', 'fees', 'save', 'open', 'close', 'mark', 'everyone', 'everybody', 'search', 'sort', 'export', 'delete', 'clear', 'unpaid', 'overdue', 'total'];
  var CLASSWORDS = ['grade', 'class', 'form'];
  function protectedWords() {
    var set = {};
    try {
      [].slice.call(document.querySelectorAll('#attendance-table tbody tr, #fees-table tbody tr')).forEach(function (tr) {
        var c = tr.children; var n = c[2] && /present|absent|status/i.test(tr.innerHTML) && tr.querySelector('.present-btn') ? c[2].textContent : (c[1] ? c[1].textContent : '');
        A.norm(n).split(' ').forEach(function (w) { if (w) set[w] = 1; });
      });
    } catch (e) {}
    return set;
  }
  function clean(text) {
    var toks = A.norm(text).split(' ').filter(Boolean), prot = protectedWords(), out = [], i, used = {};
    // "for one glass" -> "class 1": a number next to word(s) that sound like grade / class / form
    for (i = 0; i < toks.length; i++) {
      if (!/^\d+$/.test(toks[i]) || used[i] || +toks[i] > 12) continue;          // class numbers are small; "45 for Peter" is a mark
      var hit = false;
      [i - 1, i + 1].forEach(function (j) {
        if (j < 0 || j >= toks.length || used[j] || /^\d+$/.test(toks[j]) || prot[toks[j]] || toks[j] === 'for') return;
        if (M.best(toks[j], CLASSWORDS).s >= 0.66) { used[j] = 1; hit = true; }
      });
      if (hit) {
        toks[i] = 'class ' + toks[i];
        [i - 1, i + 1].forEach(function (j) { if (toks[j] === 'for' && !used[j]) used[j] = 1; });    // "for one glass": the leftover "for" is the misheard "form"
      }
    }
    toks.forEach(function (w, idx) { if (!used[idx]) out.push(w); });
    toks = out;
    // other control words: nearest TeachMate word when it sounds clearly like one (never touches learner names)
    toks = toks.map(function (w) {
      if (w.length < 4 || prot[w] || CONTROL.indexOf(w) > -1 || /\s/.test(w)) return w;
      var b = M.best(w, CONTROL); return b.s >= 0.84 && (M.lev(w, b.word) <= 1 || M.pk(w) === M.pk(b.word)) ? b.word : w;   // never rewrite real words like "weekly"
    });
    return toks.join(' ');
  }

  /* how much of what was heard is TeachMate talk? (learner names on screen count too) */
  var STOP = /^(the|a|an|to|for|and|of|me|my|us|we|you|i|it|is|are|was|be|in|on|at|this|that|these|those|please|now|can|could|would|will|just|then|with|all|up|by|from|as|do|did|so|if|or|not|no|yes)$/;
  var vocab = null;
  function coverage(t) {
    if (!vocab) { prep(); vocab = {}; tasks().forEach(function (k) { k.gw.forEach(function (ws) { ws.forEach(function (w) { vocab[w] = 1; }); }); }); CONTROL.forEach(function (w) { vocab[w] = 1; }); }
    var prot = protectedWords(), words = Object.keys(vocab), toks = t.split(' ').filter(function (w) { return w && !STOP.test(w); });
    if (!toks.length) return 0;
    var hit = toks.filter(function (w) { return /^\d+$/.test(w) || prot[w] || vocab[w] || M.best(w, words).s >= 0.8; }).length;
    return hit / toks.length;
  }

  /* ---------- nearest-command ranking ---------- */
  var prepped = false, N = 0;
  function prep() {
    if (prepped) return; prepped = true;
    var df = {}; N = tasks().length;
    tasks().forEach(function (t) {
      var seen = {}; t.gw = t.kw.map(function (g) { var ws = []; g.forEach(function (a) { A.norm(a).split(' ').forEach(function (w) { ws.push(w); seen[w] = 1; }); }); return ws; });
      Object.keys(seen).forEach(function (w) { df[w] = (df[w] || 0) + 1; });
    });
    tasks().forEach(function (t) {
      t.gweight = t.gw.map(function (ws) { var u = {}; ws.forEach(function (w) { u[w] = 1; }); var ks = Object.keys(u), sum = 0; ks.forEach(function (w) { sum += Math.log(1 + N / df[w]); }); return sum / ks.length; });
    });
  }
  function maxSim(w, toks) { var b = 0; for (var i = 0; i < toks.length; i++) { var s = M.tsim(toks[i], w); if (s > b) b = s; } return b; }
  function groupScore(g, toks) {
    var best = 0, spec = 0;
    g.forEach(function (alt) {
      var aw = A.norm(alt).split(' '), s;
      if (aw.length === 1) s = maxSim(aw[0], toks);
      else { var sum = 0; aw.forEach(function (w) { sum += maxSim(w, toks); }); s = sum / aw.length; }
      if (s > best) { best = s; spec = s >= 0.97 ? alt.length : 0; }
    });
    return { s: best, spec: spec };
  }
  var SEC = { att: 'attendance', subj: 'attendance', res: 'results', fees: 'fees', cm: 'class-management' };
  function rank(t) {
    prep();
    var toks = t.split(' ').filter(Boolean), cur = A.currentSection ? A.currentSection() : null;
    return tasks().map(function (task) {
      var num = 0, den = 0, min = 1, spec = 0;
      if (task.alsoIf && task.alsoIf(t)) return { task: task, base: 1, min: 1, score: 1.05 };
      task.gw.forEach(function (_, i) {
        var g = groupScore(task.kw[i], toks), w = task.gweight[i];
        num += w * g.s; den += w; if (g.s < min) min = g.s; spec += g.spec;
      });
      var base = den ? num / den : 0;
      var score = base * (0.75 + 0.25 * min) + 0.015 * Math.min(task.kw.length, 4) + 0.0005 * spec;
      if (cur && SEC[task.id.split('_')[0]] === cur) score += 0.03;          // what is on screen is more likely
      if (cur && task.id === 'go_back') score += 0.03;
      if (task.risk === 'high') score -= 0.05;                                 // never lead with a destructive guess
      return { task: task, base: base, min: min, score: score };
    }).sort(function (a, b) { return b.score - a.score; });
  }
  function isMut(task) { return task.risk !== 'low' || /^(att_mark_names|att_set_termweek|res_set_fields|res_enter_marks|res_reportcards|form_generate|ui_set|ui_toggle|ui_press)$/.test(task.id); }

  /* ---------- finish: fill in slots / class (never guessed) ---------- */
  function finish(task, t) {
    var params = {};
    if (task.parse) { var pr = task.parse(t); if (pr.ask) return { ask: pr.ask }; params = pr.params || {}; }
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
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function describe(task, t) {
    var f = finish(task, t), d = task.label;
    if (f.task) { if (task.describe) d = task.describe(f.params); if (f.params.classLabel) d += ' (' + f.params.classLabel + ')'; }
    return cap(d);
  }

  /* ---------- understand ---------- */
  function understand(text) {
    var t = clean(text);
    if (/\b(what can (i|you) say|what can you do|list commands|voice help|what commands)\b/.test(t))
      return { say: 'I can open attendance, results, fees, messages, class management and the lesson planner; open a class like \u201cGrade 8 attendance\u201d; save, view history, export or clear on those pages; search learners; sort and export the class list; count learners; in attendance mark learners or the whole class present or absent (even \u201ceveryone present except Peter\u201d), set the term and week, save, and ask who is absent; in fees ask who owes, how much a learner paid, overdue and totals. After every change I show a pop-up so you can confirm or undo. If I mishear you, I\u2019ll offer the closest commands to choose from.', ok: true };
    var L = recall(t);
    if (L) { var lt = tasks().filter(function (k) { return k.id === L.id; })[0]; if (lt) { var lf = finish(lt, t); return lf.task ? { run: lf, t: t, fuzzy: false } : lf; } }
    var R = rank(t), top = R[0], sec = R[1];
    if (!top || top.base < SUGGEST_AT) return { ask: REPEAT, hints: true };
    var strong = top.min >= 0.9 && top.base >= 0.93, mut = isMut(top.task);
    var tie = sec && sec.min >= 0.9 && sec.base >= 0.93 && top.score - sec.score < 0.003 && sec.task.id !== top.task.id;
    if (!tie) {
      if (strong && (!mut || top.base >= 0.99)) { var f = finish(top.task, t); return f.task ? { run: f, t: t, fuzzy: false } : f; }
      if (!mut && top.base >= RUN_AT && (!sec || top.score - sec.score >= 0.08)) { var f2 = finish(top.task, t); return f2.task ? { run: f2, t: t, fuzzy: top.base < 0.97 } : f2; }
    }
    if (/(grade|class|form)\s*\d+/.test(t) && !top.task.classSection) {
      var byId = {}; tasks().forEach(function (k) { byId[k.id] = k; });
      return { suggest: ['nav_attendance', 'nav_results', 'nav_fees'].map(function (id) { return { task: byId[id], label: describe(byId[id], t) }; }), t: t, heard: text };
    }
    if (top.base < 0.9 && A.uiGuess) {
      var pt = tasks().filter(function (k) { return k.id === 'ui_press'; })[0], g = A.uiGuess(t);
      if (pt && g && g.score >= 0.9) { var pp = pt.parse(t, true); if (pp.params) return { run: { task: pt, params: pp.params }, t: t, fuzzy: true }; }
    }
    var list = [top];
    for (var i = 1; i < R.length && list.length < 3; i++) if (R[i].base >= SUGGEST_AT && top.score - R[i].score <= 0.3) list.push(R[i]);
    return { suggest: list.map(function (r) { return { task: r.task, label: describe(r.task, t) }; }), t: t, heard: text, topBase: top.base };
  }

  /* ---------- validate + execute ---------- */
  function needsConfirm(task, params) { var r = (params && params.risk) || task.risk; return r === 'medium' || r === 'high'; }
  function readBack(task, params) {
    var where = params.classLabel ? ' for ' + params.classLabel : (ctx.classLabel ? ' (current class: ' + ctx.classLabel + ')' : '');
    return ((params.risk || task.risk) === 'high' ? 'This is a high-risk action. ' : '') + 'You want me to ' + (params.confirmText || task.confirmText || task.label) + where + '. Say yes to continue, or cancel.';
  }
  var V = function () { return window.TeachMateVoiceVerify; };
  async function execute(task, params, meta) {
    setState('EXECUTING');
    try {
      var res = await task.run(params);
      setState('VERIFYING');
      if (res.ok && params.classValue) { ctx.classValue = params.classValue; ctx.classLabel = params.classLabel; }
      var v = res.verify;
      if (v && V()) {
        var q = v.question || 'Is that correct? Say yes, or say undo.';
        shownAt = Date.now();
        V().show({ title: v.title, lines: v.lines, warn: v.warn, question: q, yesLabel: v.yesLabel, noLabel: v.noLabel,
          onYes: function () { if (meta && meta.fuzzy) learn(meta.t, task.id); respond('Confirmed. Thank you.', true); },
          onNo: async function () {
            if (v.undo) { setState('EXECUTING'); try { respond(await v.undo(), true); } catch (e) { respond('I couldn\u2019t undo that automatically. Please check the screen.', false); } }
            else respond('Okay, I\u2019ll treat that as not right. Please repeat what you need, or correct it on screen.', true);
          } });
        return respond(res.message + ' ' + q, res.ok);
      }
      respond(res.message, res.ok);
    } catch (e) {
      console.error('[voice] task failed:', task.id, e);
      respond('That didn\u2019t work: ' + task.label + ' failed. Nothing was confirmed as done.', false);
    }
  }
  var ORD = ['first', 'second', 'third'];
  function offer(u) {
    var opts = u.suggest;
    pending = { kind: 'suggest', opts: opts, t: u.t, at: Date.now() };
    var spoken, chips = opts.map(function (o, i) { return { label: (i + 1) + '. ' + o.label, pick: function () { choose(i); } }; });
    if (opts.length === 1) spoken = 'I heard \u201c' + u.heard + '\u201d. I think you mean: ' + opts[0].label + '. Is that right? Say yes, or say it again.';
    else spoken = 'I heard \u201c' + u.heard + '\u201d. Did you mean: ' + opts.map(function (o, i) { return (i + 1) + ', ' + o.label; }).join('; ') + '? Say a number, or say it again.';
    respond(spoken, true);
  }
  function choose(i) {
    var p = pending; if (!p || p.kind !== 'suggest' || !p.opts[i]) return;
    pending = null;
    var o = p.opts[i], f = finish(o.task, p.t);
    learn(p.t, o.task.id);
    if (!f.task) { if (f.clarify) pending = { kind: 'class', task: o.task, at: Date.now() }; return respond(f.ask, true); }
    dispatch(f);
  }
  async function dispatch(u) {
    if (u.say) return respond(u.say, u.ok);
    if (u.suggest) return offer(u);
    if (u.ask) { pending = u.clarify ? { kind: 'class', task: u.clarify.task, at: Date.now() } : null; return respond(u.ask + (u.hints ? ' You can say things like \u201copen attendance\u201d, \u201cwho is absent\u201d or \u201cwho hasn\u2019t paid fees\u201d.' : ''), true); }
    var f = u.run || u;
    var meta = { t: u.t, fuzzy: !!u.fuzzy };
    if (needsConfirm(f.task, f.params)) { pending = { kind: 'confirm', task: f.task, params: f.params, meta: meta, at: Date.now() }; return respond(readBack(f.task, f.params), true); }
    return execute(f.task, f.params, meta);
  }

  /* ---------- entry ---------- */
  function pickIndex(t, n) {
    var m = t.match(/^(?:number |option |the |choice )?(1|2|3)\b/);
    if (m) return +m[1] - 1 < n ? +m[1] - 1 : -1;
    for (var i = 0; i < ORD.length && i < n; i++) if (new RegExp('^(the )?' + ORD[i] + '\\b').test(t)) return i;
    return -1;
  }
  async function submit(text, confidence, opts) {
    text = String(text || '').trim(); if (!text) return;
    var now = Date.now(), t0 = A.norm(text), heardByMic = !!(opts && opts.autoRun);
    if (heardByMic) {
      var tk = t0.split(' ').filter(Boolean);
      if (!tk.length || tk.every(function (w) { return FILLER.test(w); })) return;                 // "uh", "the" ... = noise
      if (ttsSpeaking()) return;                                                                      // never obey our own voice
      if (tk.length >= 3 && now - lastSpokenAt < 20000) {                                             // an echo of what TeachMate just said
        var said = {}; lastSpoken.split(' ').forEach(function (w) { said[w] = 1; });
        var overlap = tk.filter(function (w) { return said[w]; }).length / tk.length;
        if (overlap >= 0.7) return;
      }
    }
    var ctl = /^(yes|yeah|yep|no|nope|undo|cancel|correct|ok|okay|1|2|3|one|two|three)$/.test(t0);
    if (!ctl && text === lastText && now - lastAt < DUP_MS) return;
    if (state !== 'IDLE') return respond('One moment, I\u2019m still working on the last instruction.', false);
    lastText = text; lastAt = now;
    var t = A.norm(text), vv = V();
    if (vv && vv.isOpen()) {
      if (YES.test(t)) { if (now - shownAt < 1200) return; vv.accept(); return; }
      if (UNDO.test(t) || CANCEL.test(t)) { vv.reject(); return; }
      return respond('Please check the pop-up first: say yes if it is correct, or say undo.', true);
    }
    if (pending && now - pending.at > PENDING_MS) pending = null;
    if (pending) {
      var p = pending;
      if (p.kind === 'suggest') {
        var idx = pickIndex(t, p.opts.length);
        if (idx > -1) return choose(idx);
        if (YES.test(t)) return choose(0);
        if (CANCEL.test(t)) { pending = null; return respond('Okay. Please say the command again.', true); }
        pending = null;                               // anything else = a fresh instruction
      } else if (p.kind === 'confirm') {
        if (CANCEL.test(t)) { pending = null; return respond('Okay, cancelled. Nothing was changed.', true); }
        if (YES.test(t)) { pending = null; return execute(p.task, p.params, p.meta); }
        pending = null;
      } else if (p.kind === 'class') {
        if (CANCEL.test(t)) { pending = null; return respond('Okay, cancelled.', true); }
        var c = A.matchClass(A.CLASS_SEL[p.task.classSection], clean(text));
        if (c.hits && c.hits.length === 1) { pending = null; return dispatch({ task: p.task, params: { classValue: c.hits[0].value, classLabel: c.hits[0].text } }); }
        return respond('Sorry, which class? You can also say cancel.', true);
      }
    }
    if (typeof confidence === 'number' && confidence < MIN_CONF) return respond(REPEAT, true);
    if (CANCEL.test(t) && !pending) return respond('Nothing to cancel.', true);
    setState('UNDERSTANDING'); var u = understand(text); setState('IDLE');
    // background chatter: a long sentence with nothing from TeachMate in it is not a command, so stay quiet
    var nTok = t0.split(' ').length;
    if (heardByMic && u.ask === REPEAT && nTok >= 7) return;
    if (heardByMic && nTok >= 5 && !u.run && coverage(clean(text)) < 0.3) return;   // long and mostly not TeachMate talk: background speech, stay quiet
    return dispatch(u);
  }

  /* ---------- UI ---------- */
  function buildUI() {
    if (document.getElementById('tmv-root') || !document.body) return;
    var st = document.createElement('style');
    st.textContent = '#tmv-root{position:fixed;left:10px;right:76px;bottom:10px;z-index:99998;font:14px system-ui,sans-serif;display:none}#tmv-root.open{display:block}' +
      '#tmv-row{display:flex;gap:6px;background:#fff;border-radius:14px;box-shadow:0 4px 18px rgba(0,0,0,.25);padding:6px;max-width:460px}' +
      '#tmv-in{flex:1;min-width:0;padding:9px;border:1px solid #ccc;border-radius:10px;font-size:15px}#tmv-go{padding:9px 12px;border:0;border-radius:10px;background:#16a34a;color:#fff;font-weight:700}' +
      '#tmv-toast{display:none;position:fixed;left:10px;right:76px;bottom:70px;z-index:99998;background:#111827;color:#fff;border-radius:10px;padding:8px 12px;font:13px system-ui,sans-serif;max-width:460px}' +
      '#tmv-fab{position:fixed;right:14px;bottom:14px;z-index:99997;width:48px;height:48px;border-radius:50%;border:0;background:#16a34a;color:#fff;font-size:22px;box-shadow:0 3px 12px rgba(0,0,0,.3)}';
    document.head.appendChild(st);
    var root = document.createElement('div'); root.id = 'tmv-root';
    root.innerHTML = '<div id="tmv-row"><input id="tmv-in" placeholder="Tap the mic and speak, or type" autocomplete="off"><button id="tmv-go">Run</button></div>';
    document.body.appendChild(root);
    var toast = document.createElement('div'); toast.id = 'tmv-toast'; document.body.appendChild(toast);
    var fab = document.createElement('button'); fab.id = 'tmv-fab'; fab.textContent = '\uD83C\uDF99'; fab.setAttribute('aria-label', 'Voice commands');
    document.body.appendChild(fab);
    fab.onclick = function () { root.classList.toggle('open'); if (root.classList.contains('open')) scheduleIdleClose(); };
    var inp = root.querySelector('#tmv-in'); inp.setAttribute('data-tm-voice-command', '1');
    function go() { var v = inp.value; inp.value = ''; submit(v); }
    root.querySelector('#tmv-go').onclick = go;
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }
  document.addEventListener('teachmate:voice-command', function (e) {
    var d = e.detail || {}; buildUI();
    var root = document.getElementById('tmv-root'); if (root) root.classList.add('open');
    if (d.autoRun) return submit(d.text, d.confidence, { autoRun: true });
    var inp = document.getElementById('tmv-in'); if (inp) inp.value = d.text || '';
  });
  if (document.readyState !== 'loading') buildUI(); else document.addEventListener('DOMContentLoaded', buildUI);
  window.TeachMateVoice = { coverage: function (t) { return coverage(clean(t)); }, forgetLearned: function () { try { window.localStorage.removeItem(LKEY); } catch (e) {} }, submit: submit, understand: understand, clean: clean, rank: rank, getState: function () { return state; } };
})();
