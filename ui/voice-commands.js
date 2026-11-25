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
  var lastText = '', lastAt = 0, shownAt = 0, popupIsInfo = false;
  var REPEAT = 'Sorry, I didn\u2019t catch that.';
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

  function setState(s) { state = s; try { window.dispatchEvent(new CustomEvent('teachmate:voice-state', { detail: { state: s } })); } catch (e) {} }
  function logLine() {}   // TeachMate answers by voice only; nothing is written on screen
  function respond(text, ok, chips) {
    lastSpoken = A.norm(text); lastSpokenAt = Date.now();
    setState('RESPONDING');
    logLine(ok === false ? 'bad' : 'ok', text);
    try { document.dispatchEvent(new CustomEvent('teachmate:assistant-response', { bubbles: true, detail: { text: text, ok: ok !== false } })); } catch (e) {}
    setState('IDLE');
  }

  /* ---------- cleaning the heard text (TeachMate-aware) ---------- */
  var CONTROL = ['present', 'absent', 'except', 'term', 'week', 'grade', 'class', 'form', 'attendance', 'register', 'results', 'history',
    'learners', 'students', 'fees', 'save', 'open', 'close', 'mark', 'everyone', 'everybody', 'search', 'sort', 'export', 'delete', 'clear', 'unpaid', 'overdue', 'total'];
  var CLASSWORDS = ['grade', 'class', 'form'];
  function protectedWords() {
    var set = {};
    try { var kn = window.TeachMateKnowledge && window.TeachMateKnowledge.names ? window.TeachMateKnowledge.names() : {}; Object.keys(kn).forEach(function (w) { set[w] = 1; }); } catch (e) {}
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
  /* Which feature a task belongs to. While a feature is open, ONLY its own tasks (plus a few global ones) are considered:
   * a misheard word can never throw you into another feature. To go elsewhere, close the feature first. */
  var SEC = { att: 'attendance', subj: 'attendance', res: 'results', form: 'results', fees: 'fees', cm: 'class-management' };
  var TASK_SEC = { know_attendance: 'attendance', know_results: 'results', know_fees: 'fees', know_find_learner: 'class-management' };
  var GLOBAL = { go_back: 1, nav_home: 1, help: 1, ui_press: 1, ui_set: 1, ui_toggle: 1, ui_list: 1, ui_scroll: 1, know_status: 1, know_overview: 1, know_learner_class: 1, know_class_list: 1, count_learners: 1, select_class: 1 };
  function taskSec(task) { return TASK_SEC[task.id] || SEC[task.id.split('_')[0]] || null; }
  function inScope(task, cur) {
    if (task.id === 'select_class') return !!cur && !!A.CLASS_SEL[cur];       // only inside a feature that has a class list
    return !cur || !!GLOBAL[task.id] || taskSec(task) === cur;
  }
  function rank(t, cur) {
    prep();
    var toks = t.split(' ').filter(Boolean);
    var res = tasks().filter(function (k) { return inScope(k, cur) && (k.id !== 'go_back' || isExitIntent(t)); }).map(function (task) {
      var num = 0, den = 0, min = 1, spec = 0;
      if (task.alsoIf && task.alsoIf(t)) return { task: task, base: 1, min: 1, score: 1.2 };
      task.gw.forEach(function (_, i) {
        var g = groupScore(task.kw[i], toks), w = task.gweight[i];
        num += w * g.s; den += w; if (g.s < min) min = g.s; spec += g.spec;
      });
      var base = den ? num / den : 0;
      var score = base * (0.75 + 0.25 * min) + 0.015 * Math.min(task.kw.length, 4) + 0.0005 * spec;
      if (cur && taskSec(task) === cur) score += 0.03;                         // what is open is more likely
      if (cur && task.id === 'go_back') score += 0.03;
      if (task.risk === 'high') score -= 0.05;                                 // never lead with a destructive guess
      return { task: task, base: base, min: min, score: score };
    }).sort(function (a, b) { return b.score - a.score; });
    var z = 0; res.slice(0, 5).forEach(function (r) { r.e = Math.exp(12 * r.score); z += r.e; });
    res.slice(0, 5).forEach(function (r) { r.p = r.e / z; });                  // how likely each candidate is (soft-max)
    return res;
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

  /* Intent gates prevent a generic keyword score from changing the page. */
  function isExitIntent(t) {
    return /^(?:please )?(?:go back|go to previous(?: page)?|return to (?:the )?(?:dashboard|home)|close (?:this|the) (?:page|feature)|exit (?:this|the) (?:page|feature))$/.test(t);
  }
  function isClassRequest(t) {
    if (!/\b(?:fetch|get|bring|load|select|choose|switch|show|open|use)\b/.test(t)) return false;
    if (/\b(?:grade|class|form)\b/.test(t)) return true;
    // Use the actual school data for named classes such as "Blue House".
    try { var K = window.TeachMateKnowledge, found = K && K.findClass && K.findClass(t); return !!(found && found.hit && found.hit.length === 1); } catch (e) { return false; }
  }

  /* ---------- understand ---------- */
  var CLUE = 0.4, SORRY = 'Sorry, I didn\u2019t catch that.';
  function understand(text) {
    var t = clean(text), cur = A.currentSection ? A.currentSection() : null;
    // Selecting a class is an intent of its own. It must never be mistaken for leaving a feature.
    if (isClassRequest(t) && cur && A.CLASS_SEL && A.CLASS_SEL[cur]) {
      var classTask = tasks().filter(function (task) { return task.id === 'select_class'; })[0];
      if (classTask) { var classFinish = finish(classTask, t); if (classFinish.task) return { run: classFinish, t: t, fuzzy: false, low: false, heard: text }; }
    }
    if (/\b(what can (i|you) say|what can you do|list commands|voice help|what commands)\b/.test(t))
      return { say: 'I can open attendance, results, fees, messages, class management and the lesson planner. Inside a feature I only listen for that feature: in attendance I mark learners present or absent, set the term and week, and save; in results I set the subject and test, enter marks by name, save and make report cards; in fees I tell you who has paid. I can fetch any class by name, and look up any learner in any class. After every change I show a pop-up so you can confirm or undo.', ok: true };
    var L = recall(t);
    if (L) { var lt = tasks().filter(function (k) { return k.id === L.id && inScope(k, cur); })[0]; if (lt) { var lf = finish(lt, t); return lf.task ? { run: lf, t: t, fuzzy: false } : lf; } }
    var R = rank(t, cur), top = R[0];
    if (cur) {                                   // a clear command for a DIFFERENT feature: say so, never switch, never guess
      var outT = rank(t, null)[0];
      if (outT && !inScope(outT.task, cur) && outT.base >= 0.8 && coverage(t) >= 0.5 && (!top || outT.score >= top.score + 0.1))
        return { say: 'You are in ' + (cur === 'class-management' ? 'class management' : cur) + '. Say close first if you want to leave it.', ok: false };
    }
    // a visible button whose label matches what was said
    if (A.uiGuess && (!top || top.base < 0.85)) {
      var pt = tasks().filter(function (k) { return k.id === 'ui_press'; })[0], g = A.uiGuess(t);
      if (pt && g && g.score >= 0.88) { var pp = pt.parse(t, true); if (pp.params) return { run: { task: pt, params: pp.params }, t: t, fuzzy: true, low: g.score < 0.97 }; }
    }
    var nWords = t.split(' ').filter(Boolean).length;
    var weak = !top || top.base < CLUE || (top.base < 0.9 && nWords > 2 && coverage(t) < (nWords > 4 ? 0.5 : 0.3)) || (top.task.kw.length > 1 && top.min < 0.45 && top.base < 0.95);   // one matching word out of several is not enough     // no real clue: random speech must not trigger a task
    if (weak) {
      // nothing in this feature fits. Does it fit something OUTSIDE the open feature? Then say so, never switch.
      if (cur) {
        var out = rank(t, null)[0];
        if (out && out.base >= 0.7 && coverage(t) >= 0.5 && !inScope(out.task, cur)) return { say: 'You are in ' + (cur === 'class-management' ? 'class management' : cur) + '. Say close first if you want to leave it.', ok: false };
      }
      return { ask: SORRY, noClue: true, hints: !!cur };
    }
    // otherwise: the most probable task wins. Equally likely? prefer the one that changes nothing.
    var best = top, sec = R[1];
    if (sec && top.score - sec.score < 0.01 && isMut(top.task) && !isMut(sec.task)) best = sec;
    var f = finish(best.task, t);
    if (!f.task) return f;
    return { run: f, t: t, fuzzy: best.base < 0.97, low: best.base < 0.8, prob: best.p, heard: text };
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
        shownAt = Date.now(); popupIsInfo = !v.undo;
        V().show({ title: v.title, lines: v.lines, warn: v.warn, question: q, yesLabel: v.yesLabel, noLabel: v.noLabel,
          onYes: function () { if (meta && meta.fuzzy) learn(meta.t, task.id); respond('Confirmed. Thank you.', true); },
          onNo: async function () {
            if (v.undo) { setState('EXECUTING'); try { respond(await v.undo(), true); } catch (e) { respond('I couldn\u2019t undo that automatically. Please check the screen.', false); } }
            else respond('Okay, I\u2019ll treat that as not right. Please repeat what you need, or correct it on screen.', true);
          } });
        return respond(res.message + ' ' + q, res.ok);
      }
      respond((meta && meta.low && res.ok ? 'I think you said ' + task.label + '. ' : '') + res.message, res.ok);
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
    if (u.ask) { pending = u.clarify ? { kind: 'class', task: u.clarify.task, at: Date.now() } : null; return respond(u.ask + (u.hints ? ' Say what you want to do in this feature, or say close to leave it.' : ''), true); }
    var f = u.run || u;
    var meta = { t: u.t, fuzzy: !!u.fuzzy, low: !!u.low };
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
      if (popupIsInfo) vv.close();                       // an answer needs no verdict: carry on with the new command
      else return respond('Please check the pop-up first: say yes if it is correct, or say undo.', true);
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
    try { if (window.TeachMateKnowledge) { await window.TeachMateKnowledge.refresh(); window.TeachMateKnowledge.syncDom(); } } catch (e) {}      // latest school data + the names on screen
    setState('UNDERSTANDING'); var u = understand(text); setState('IDLE');
    // background chatter: a long sentence with nothing from TeachMate in it is not a command, so stay quiet
    var nTok = t0.split(' ').length;
    if (heardByMic && u.noClue && nTok >= 5 && coverage(clean(text)) < 0.5) return;   // pure background talk: stay quiet. Anything with a clue gets an answer.
    return dispatch(u);
  }

  /* ---------- UI: one mic button that becomes a live voice wave while listening ---------- */
  function onWin(n, f) { try { window.addEventListener(n, f); } catch (e) {} }
  var ui = { mode: 'idle', msg: '', hearUntil: 0, lastHeard: 0, amp: 0, engine: 'IDLE', visible: false, cur: [] };
  var BARS = 11, COLORS = { listening: '#34d399', hearing: '#6ee7b7', thinking: '#60a5fa', speaking: '#a78bfa', loading: '#fbbf24', error: '#f87171' };
  var fab, pill, barEls = [], labelEl, hiddenInput, raf = 0;
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function ttsTalking() { try { var T = window.TeachMateTTS; return !!(T && T.isSpeaking && T.isSpeaking()); } catch (e) { return false; } }
  function visualMode() {
    if (ui.mode === 'error' || ui.mode === 'loading') return ui.mode;
    if (ttsTalking()) return 'speaking';
    if (ui.engine === 'UNDERSTANDING' || ui.engine === 'EXECUTING' || ui.engine === 'VERIFYING') return 'thinking';
    return Date.now() < ui.hearUntil ? 'hearing' : 'listening';
  }
  function showPill() { if (!pill) return; ui.visible = true; pill.style.display = 'flex'; fab.style.display = 'none'; if (!raf) raf = requestAnimationFrame(frame); }
  function hidePill() { if (!pill) return; ui.visible = false; ui.mode = 'idle'; pill.style.display = 'none'; fab.style.display = 'flex'; }
  function frame(ts) {
    raf = 0; if (!ui.visible) return;
    var t = ts / 1000, mode = visualMode(), now = Date.now();
    pill.style.setProperty('--c', COLORS[mode] || COLORS.listening);
    var text = (mode === 'loading' || mode === 'error') ? ui.msg : '';
    if (labelEl.textContent !== text) { labelEl.textContent = text; labelEl.style.display = text ? 'block' : 'none'; }
    ui.amp *= 0.9;
    for (var i = 0; i < BARS; i++) {
      var amp, env = 0.5 + 0.5 * Math.sin(t * 6 + i * 0.7);
      if (mode === 'hearing') amp = 0.12 + ui.amp * (0.35 + 0.65 * env);
      else if (mode === 'thinking') amp = 0.15 + 0.55 * Math.max(0, Math.sin(t * 5 - i * 0.6));
      else if (mode === 'speaking') amp = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * 7 + i * 0.9)) * (0.6 + 0.4 * Math.sin(t * 2.3));
      else if (mode === 'loading') amp = 0.15 + 0.4 * Math.max(0, Math.sin(t * 4 - i * 0.5));
      else if (mode === 'error') amp = 0.12;
      else amp = 0.1 + 0.06 * (0.5 + 0.5 * Math.sin(t * 2.2 + i * 0.5));      // listening, waiting for you
      ui.cur[i] = (ui.cur[i] || 0.1) + (amp - (ui.cur[i] || 0.1)) * 0.35;
      barEls[i].style.transform = 'scaleY(' + clamp(ui.cur[i], 0.08, 1).toFixed(3) + ')';
    }
    if ((ui.mode === 'listening') && now - ui.lastHeard > 25000 && !ttsTalking() && ui.engine === 'IDLE') stopListening();   // quiet for 25 s: stop, save battery
    raf = requestAnimationFrame(frame);
  }
  async function startListening() {
    var Sp = window.TeachMateSpeech;
    if (!Sp) { ui.mode = 'error'; ui.msg = 'Voice is unavailable'; showPill(); setTimeout(hidePill, 3000); return; }
    if (Sp.isActive() || Sp.isStarting()) return;
    ui.mode = 'loading'; ui.msg = 'Starting…'; ui.lastHeard = Date.now(); ui.hearUntil = 0; ui.amp = 0; showPill();
    try { await Sp.start(hiddenInput, document.createElement('button')); }
    catch (e) { ui.mode = 'error'; ui.msg = 'Could not start the microphone'; setTimeout(hidePill, 3500); return; }
    if (!Sp.isActive() && ui.mode !== 'error') hidePill();
  }
  function stopListening() { var Sp = window.TeachMateSpeech; if (Sp && (Sp.isActive() || Sp.isStarting())) Sp.stop(); else hidePill(); }
  onWin('teachmate:speech-state', function (e) {
    var d = e.detail || {}, m = d.message || '';
    if (d.stopped) { hidePill(); return; }
    if (/^listening/i.test(m)) { ui.mode = 'listening'; ui.lastHeard = Date.now(); showPill(); }
    else if (/^requesting/i.test(m)) { ui.mode = 'loading'; ui.msg = 'Allow the microphone'; showPill(); }
    else if (/(blocked|denied|not allowed|not available|does not support|failed|could not|unable|error)/i.test(m)) {
      ui.mode = 'error'; ui.msg = /(blocked|denied|not allowed|permission)/i.test(m) ? 'Allow the microphone to talk' : 'Voice is unavailable'; showPill(); setTimeout(function () { if (ui.mode === 'error') hidePill(); }, 3500);
    } else { ui.mode = 'loading'; ui.msg = 'Preparing voice…' + (typeof d.percent === 'number' ? ' ' + Math.round(d.percent) + '%' : ''); showPill(); }
  });
  onWin('teachmate:mic-level', function (e) {
    var d = e.detail || {};
    if (d.open) { ui.hearUntil = Date.now() + 350; ui.lastHeard = Date.now(); ui.amp = Math.max(ui.amp, clamp((d.level || 0) * 9, 0.2, 1)); }
  });
  onWin('teachmate:voice-state', function (e) { ui.engine = (e.detail && e.detail.state) || 'IDLE'; });
  var sayEl = null, sayTimer = null;
  function voiceAvailable() { var T = window.TeachMateTTS; return !!(('speechSynthesis' in window) || (T && T.isReady && T.isReady())); }
  onWin('teachmate:assistant-response', function (e) {            // a short note ONLY for problems, or when no voice can speak
    var d = e.detail || {};
    if (!sayEl || (d.ok !== false && voiceAvailable())) return;
    sayEl.textContent = String(d.text || '').slice(0, 150); sayEl.style.display = 'block';
    clearTimeout(sayTimer); sayTimer = setTimeout(function () { sayEl.style.display = 'none'; }, 5500);
  });
  function buildUI() {
    if (document.getElementById('tmv-fab') || !document.body) return;
    var st = document.createElement('style');
    st.textContent = '#tmv-fab{position:fixed;right:14px;bottom:66px;z-index:99997;width:52px;height:52px;border-radius:50%;border:0;background:#16a34a;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.3);padding:0}' +
      '#tmv-fab svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
      '#tmv-wave{display:none;position:fixed;left:12px;right:76px;max-width:380px;bottom:16px;height:56px;z-index:99998;border-radius:28px;background:#0b1f19;box-shadow:0 6px 22px rgba(0,0,0,.35);align-items:center;gap:10px;padding:0 8px 0 18px;box-sizing:border-box;--c:#34d399}' +
      '#tmv-wave .tmv-bars{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;height:36px}' +
      '#tmv-wave .tmv-bar{width:5px;height:34px;border-radius:3px;background:var(--c);transform:scaleY(.1);will-change:transform;transition:background .25s}' +
      '#tmv-wave .tmv-label{display:none;color:#cbd5e1;font:600 12px system-ui,sans-serif;white-space:nowrap}' +
      '#tmv-wave .tmv-stop{flex:none;width:40px;height:40px;border-radius:50%;border:0;background:#ef4444;display:flex;align-items:center;justify-content:center;padding:0}' +
      '#tmv-wave .tmv-stop span{width:14px;height:14px;border-radius:3px;background:#fff;display:block}' +
      '#tmv-say{display:none;position:fixed;left:12px;right:76px;max-width:380px;bottom:82px;z-index:99998;background:#111827;color:#fff;border-radius:12px;padding:8px 12px;font:13px/1.35 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none}';
    document.head.appendChild(st);
    hiddenInput = document.createElement('input');                       // invisible target so the recognizer can run without any box on screen
    hiddenInput.id = 'tmv-in'; hiddenInput.type = 'text'; hiddenInput.tabIndex = -1;
    hiddenInput.setAttribute('data-tm-voice-command', '1'); hiddenInput.setAttribute('data-no-dictation', '1'); hiddenInput.setAttribute('aria-hidden', 'true');
    hiddenInput.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(hiddenInput);
    fab = document.createElement('button'); fab.id = 'tmv-fab'; fab.type = 'button'; fab.setAttribute('aria-label', 'Talk to TeachMate');
    fab.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg>';
    fab.onclick = startListening;
    pill = document.createElement('div'); pill.id = 'tmv-wave'; pill.setAttribute('role', 'status');
    var bars = document.createElement('div'); bars.className = 'tmv-bars';
    for (var i = 0; i < BARS; i++) { var b = document.createElement('span'); b.className = 'tmv-bar'; bars.appendChild(b); barEls.push(b); }
    labelEl = document.createElement('span'); labelEl.className = 'tmv-label';
    var stop = document.createElement('button'); stop.type = 'button'; stop.className = 'tmv-stop'; stop.setAttribute('aria-label', 'Stop listening'); stop.innerHTML = '<span></span>';
    stop.onclick = stopListening;
    pill.appendChild(bars); pill.appendChild(labelEl); pill.appendChild(stop);
    sayEl = document.createElement('div'); sayEl.id = 'tmv-say'; document.body.appendChild(sayEl);
    document.body.appendChild(pill); document.body.appendChild(fab);
  }
  document.addEventListener('teachmate:voice-command', function (e) {
    var d = e.detail || {}; if (d.autoRun) return submit(d.text, d.confidence, { autoRun: true });
  });
  if (document.readyState !== 'loading') buildUI(); else document.addEventListener('DOMContentLoaded', buildUI);
  window.TeachMateVoice = { coverage: function (t) { return coverage(clean(t)); }, forgetLearned: function () { try { window.localStorage.removeItem(LKEY); } catch (e) {} }, submit: submit, understand: understand, clean: clean, rank: rank, getState: function () { return state; } };
})();
