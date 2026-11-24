/* ui/voice-knowledge.js — the voice assistant's live picture of the school's data.
 * Reads TeachMate's own database (classes, learners, attendance, results, fees) and keeps it fresh: any write to those
 * stores (new class assigned, learners synced, marks saved...) marks the picture stale and it is re-read automatically.
 * Learner names are matched by sound, even when speech recognition splits or garbles them ("chilly she mway wa"). */
(function () {
  'use strict';
  var M = window.TeachMateVoiceMatch, TTL = 20000;
  var S = { classes: [], students: [], att: [], results: [], fees: [], cfg: {}, loadedAt: 0, dirty: true, loading: null, tries: 0 };
  var byClass = {}, byId = {}, listeners = [], nameWords = {}, timer = null;
  function norm(s) {
    var A = window.TeachMateVoiceActions;
    return A && A.norm ? A.norm(s) : String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function idKey(v) { return String(v === undefined || v === null ? '' : v).trim().toLowerCase(); }
  function pretty(id) { return String(id).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  async function get(store, key) {
    try { if (typeof window.getIndexedDB !== 'function') return { fail: true, v: [] }; var v = await window.getIndexedDB(store, key); return { v: key !== undefined ? v : (Array.isArray(v) ? v : []) }; }
    catch (e) { return { fail: true, v: key !== undefined ? null : [] }; }
  }

  /* ---------- build ---------- */
  function build() {
    byClass = {}; byId = {}; nameWords = {};
    var cm = {};
    S.classes.forEach(function (c) {
      if (typeof c === 'string') c = { id: c, name: c };
      var id = String(c.id || c.classId || c.name || c.className || '').trim(); if (!id) return;
      cm[id] = { id: id, name: String(c.displayName || c.className || c.name || pretty(id)) };
    });
    S.students.forEach(function (s) { var cid = String(s.classId || s.className || s['class'] || s.class_id || '').trim(); if (cid && !cm[cid]) cm[cid] = { id: cid, name: pretty(cid) }; });
    // names the teacher actually sees in the class drop-downs win
    ['attendance-class', 'results-class', 'fees-class'].forEach(function (sid) {
      var sel = document.getElementById && document.getElementById(sid);
      if (sel && sel.options) [].slice.call(sel.options).forEach(function (o) { if (o.value && cm[o.value] && o.text && !/^(select|choose|--)/i.test(o.text.trim())) cm[o.value].name = o.text.trim(); });
    });
    var students = S.students.map(function (s) {
      var name = String(s.name || s.fullName || s.studentName || '').replace(/\s+/g, ' ').trim();
      var cid = String(s.classId || s.className || s['class'] || s.class_id || '').trim();
      var nt = norm(name).split(' ').filter(Boolean), cat = nt.join('');
      return { id: String(s.id === undefined ? '' : s.id).trim(), name: name, classId: cid, nt: nt, cat: cat, pkcat: M ? M.pk(cat) : cat, raw: s };
    }).filter(function (s) { return s.name; });
    students.forEach(function (s) {
      (byClass[s.classId] = byClass[s.classId] || []).push(s); byId[idKey(s.id)] = s;
      s.nt.forEach(function (w) { nameWords[w] = 1; });
    });
    S.cmap = cm; S.stu = students;
    Object.keys(cm).forEach(function (id) { norm(cm[id].name).split(' ').forEach(function (w) { if (w) nameWords['c:' + w] = 1; }); });
  }

  /* ---------- refresh ---------- */
  function refresh(force) {
    if (S.loading) return S.loading;
    if (!force && !S.dirty && Date.now() - S.loadedAt < TTL) return Promise.resolve(S);
    S.loading = (async function () {
      try {
        var r = await Promise.all([get('classes'), get('students'), get('attendanceHistory'), get('attendance'), get('results'), get('fees')]);
        if (r[0].fail && r[1].fail) { S.dirty = true; if (S.tries++ < 25) { clearTimeout(timer); timer = setTimeout(function () { refresh(true); }, 3000); } return S; }   // database not open yet
        S.tries = 0; S.classes = r[0].v; S.students = r[1].v; S.fees = r[5].v; S.results = r[4].v;
        var seen = {}, att = [];
        r[2].v.concat(r[3].v).forEach(function (a) { if (!a) return; var k = a.recordId || (a.date + '|' + a.classId + '|' + a.studentId); if (!seen[k]) { seen[k] = 1; att.push(a); } });
        S.att = att;
        build();
        var cfgs = await Promise.all(Object.keys(S.cmap).map(function (id) { return get('feesConfig', id).then(function (x) { return [id, x.v]; }); }));
        S.cfg = {}; cfgs.forEach(function (p) { if (p[1]) S.cfg[p[0]] = p[1]; });
        S.loadedAt = Date.now(); S.dirty = false;
        listeners.forEach(function (f) { try { f(); } catch (e) {} });
      } catch (e) { console.warn('[knowledge] refresh failed', e); }
      finally { S.loading = null; }
      return S;
    })();
    return S.loading;
  }
  var WATCH = { students: 1, classes: 1, attendanceHistory: 1, attendance: 1, results: 1, fees: 1, feesConfig: 1 };
  var wt = null;
  function markDirty(store) {
    if (!WATCH[store]) return;
    S.dirty = true; clearTimeout(wt);
    wt = setTimeout(function () { if (!document.hidden) refresh(true); }, 1500);
  }
  try {                                           // every database write anywhere in TeachMate marks the picture stale
    ['put', 'add', 'delete', 'clear'].forEach(function (m) {
      var o = window.IDBObjectStore && IDBObjectStore.prototype[m];
      if (!o || o._tmk) return;
      var w = function () { try { markDirty(this.name); } catch (e) {} return o.apply(this, arguments); };
      w._tmk = 1; IDBObjectStore.prototype[m] = w;
    });
  } catch (e) {}
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { S.dirty = true; refresh(); } });
  window.addEventListener('online', function () { S.dirty = true; });
  setTimeout(function () { refresh(true); }, 2500);

  /* ---------- lookups ---------- */
  function scoreName(spoken, s) {
    var q = spoken.split(' ').filter(Boolean); if (!q.length) return 0;
    var tot = 0, ok = true;
    q.forEach(function (w) { var b = 0; s.nt.forEach(function (n) { var x = M.tsim(w, n); if (x > b) b = x; }); if (b < 0.45) ok = false; tot += b; });
    var s1 = ok ? tot / q.length : 0;
    var cat = q.join(''), s2 = cat.length >= 5 ? M.tsim(cat, s.cat) * 0.97 : 0;      // recognizer split or merged the name
    return Math.max(s1, s2);
  }
  /* spoken: normalized name text. returns {hit:[student]} | {many:[...]} | {near:[...]} */
  function findLearners(spoken, opts) {
    opts = opts || {};
    var pool = opts.classId ? (byClass[opts.classId] || []) : (S.stu || []);
    var r = pool.map(function (s) { return { s: s, v: scoreName(spoken, s) }; }).filter(function (x) { return x.v > 0; }).sort(function (a, b) { return b.v - a.v; });
    if (!r.length) return { near: [] };
    var top = r[0];
    if (top.v < 0.8) return { near: r.slice(0, 3).map(function (x) { return x.s; }) };
    var tied = r.filter(function (x) { return top.v - x.v < 0.06; });
    if (tied.length > 1) return { many: tied.map(function (x) { return x.s; }) };
    return { hit: [top.s] };
  }
  var COMMON = /^(the|a|an|to|for|and|of|me|my|us|we|you|i|it|is|are|was|be|in|on|at|this|that|these|those|please|now|can|could|would|will|just|then|with|all|up|by|from|as|do|did|so|if|or|not|no|yes|how|many|much|what|who|which|show|tell|give|find|go|get|read|check|class|grade|form|marks?|results?|scores?|average|attendance|absent|present|days?|week|month|term|year|last|past|today|yesterday|fees?|paid|pay|owe|learner|student|pupil|profile|details|data|record|records|information|about|into|his|her|their|him|them|come|came|late)$/;
  /* find learner names inside a longer sentence: [{student, start, end}] */
  function extract(text) {
    var toks = norm(text).split(' ').filter(Boolean), found = [], used = {};
    if (!S.stu || !S.stu.length) return { found: [], rest: toks };
    for (var n = 4; n >= 1; n--) for (var i = 0; i + n <= toks.length; i++) {
      var clash = false; for (var k = i; k < i + n; k++) if (used[k]) clash = true; if (clash) continue;
      var win = toks.slice(i, i + n); if (win.every(function (w) { return COMMON.test(w) || /^\d+$/.test(w); })) continue;
      if (n === 1 && (COMMON.test(win[0]) || win[0].length < 4)) continue;
      var r = findLearners(win.join(' '));
      var cand = r.hit || r.many;
      if (!cand) continue;
      var sc = scoreName(win.join(' '), cand[0]);
      if (sc < (n === 1 ? 0.9 : n >= 3 ? 0.8 : 0.85)) continue;      // 3-4 pieces = the recognizer split one name
      found.push({ student: cand[0], many: r.many || null, start: i, end: i + n, score: sc });
      for (var k2 = i; k2 < i + n; k2++) used[k2] = 1;
    }
    found.sort(function (a, b) { return a.start - b.start; });
    return { found: found, rest: toks.filter(function (w, idx) { return !used[idx]; }) };
  }
  function findClass(spoken) {
    var t = norm(spoken), ids = Object.keys(S.cmap || {}), m = t.match(/\b(?:grade|class|form)\s*(\d+)\s*([a-z])?\b/);
    var list = ids.map(function (id) { return S.cmap[id]; });
    if (m) {
      var hits = list.filter(function (c) { return new RegExp('(^|[^0-9])' + m[1] + '([^0-9]|$)').test(norm(c.name) + ' ' + c.id); });
      if (hits.length > 1 && m[2]) { var f = hits.filter(function (c) { return new RegExp('\\b' + m[1] + '\\s*' + m[2] + '\\b|\\b' + m[2] + '\\s*' + m[1] + '\\b').test(norm(c.name)); }); if (f.length) hits = f; }
      if (hits.length === 1) return { hit: [hits[0]] }; if (hits.length > 1) return { many: hits };
    }
    var r = list.map(function (c) { var p = norm(c.name).split(' '), q = t.split(' '), best = 0; for (var n = 3; n >= 1; n--) for (var i = 0; i + n <= q.length; i++) { var ph = q.slice(i, i + n).join(' '), s = 0; var a = norm(c.name); s = M.tsim(ph.replace(/ /g, ''), a.replace(/ /g, '')); if (s > best) best = s; } return { c: c, v: best }; })
      .filter(function (x) { return x.v >= 0.88; }).sort(function (a, b) { return b.v - a.v; });
    if (r.length === 1 || (r.length > 1 && r[0].v - r[1].v > 0.05)) return { hit: [r[0].c] };
    if (r.length > 1) return { many: r.map(function (x) { return x.c; }) };
    return { near: [] };
  }

  /* ---------- dates ---------- */
  function sod(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function parseRange(text) {
    var t = norm(text), now = sod(new Date()), m;
    var mon = addDays(now, -((now.getDay() + 6) % 7));
    if (/\btoday\b/.test(t)) return { from: iso(now), to: iso(now), label: 'today' };
    if (/\byesterday\b/.test(t)) { var y = addDays(now, -1); return { from: iso(y), to: iso(y), label: 'yesterday' }; }
    if (/\bthis week\b/.test(t)) return { from: iso(mon), to: iso(now), label: 'this week' };
    if (/\blast week\b/.test(t)) return { from: iso(addDays(mon, -7)), to: iso(addDays(mon, -1)), label: 'last week' };
    if (/\bthis month\b/.test(t)) return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now), label: 'this month' };
    if (/\blast month\b/.test(t)) { var f = new Date(now.getFullYear(), now.getMonth() - 1, 1), l = new Date(now.getFullYear(), now.getMonth(), 0); return { from: iso(f), to: iso(l), label: 'last month' }; }
    if ((m = t.match(/\b(?:past|last|previous)\s+(\d+)\s+(day|days|week|weeks|month|months)\b/))) { var n = +m[1], u = /day/.test(m[2]) ? 1 : /week/.test(m[2]) ? 7 : 30; return { from: iso(addDays(now, -n * u)), to: iso(now), label: 'the past ' + n + ' ' + m[2] }; }
    if (/\b(past|last)\s+(week)\b/.test(t)) return { from: iso(addDays(now, -7)), to: iso(now), label: 'the past week' };
    if (/\b(past|last)\s+(month)\b/.test(t)) return { from: iso(addDays(now, -30)), to: iso(now), label: 'the past month' };
    if (/\b(past|last)\s+(day)\b/.test(t)) return { from: iso(addDays(now, -1)), to: iso(now), label: 'the past day' };
    if ((m = t.match(/\bterm\s*(\d)\b/))) return { from: null, to: null, term: 'term ' + m[1], label: 'term ' + m[1] };
    return { from: null, to: null, label: 'on record' };
  }
  function inRange(d, r) { if (!r) return true; if (r.from && d < r.from) return false; if (r.to && d > r.to) return false; return true; }
  function dayLabel(d) { try { var p = d.split('-'); return +p[2] + ' ' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+p[1] - 1]; } catch (e) { return d; } }

  /* ---------- data per learner / class ---------- */
  function attendanceOf(studentId, range, classId) {
    var key = idKey(studentId), byDay = {};
    S.att.forEach(function (a) {
      if (idKey(a.studentId) !== key || !a.date || !inRange(a.date, range)) return;
      if (classId && a.classId && String(a.classId) !== String(classId)) return;
      if (range && range.term && a.term && norm(a.term).indexOf(range.term) < 0) return;
      var cur = byDay[a.date]; if (!cur || String(a.updatedAt || '') >= String(cur.updatedAt || '')) byDay[a.date] = a;
    });
    var days = Object.keys(byDay).sort(), pres = [], abs = [];
    days.forEach(function (d) { (byDay[d].present ? pres : abs).push(d); });
    return { present: pres, absent: abs, total: days.length };
  }
  function attendanceOfClass(classId, range) {
    var by = {};
    S.att.forEach(function (a) { if (String(a.classId) !== String(classId) || !a.date || !inRange(a.date, range)) return; var k = idKey(a.studentId) + '|' + a.date; var cur = by[k]; if (!cur || String(a.updatedAt || '') >= String(cur.updatedAt || '')) by[k] = a; });
    return Object.keys(by).map(function (k) { return by[k]; });
  }
  function resultsOf(studentId, range, subjectSpoken) {
    var key = idKey(studentId), out = [];
    S.results.forEach(function (r) {
      if (!r || !r.scores) return;
      var d = String(r.date || r.createdAt || '').slice(0, 10);
      if (range && (range.from || range.to) && d && !inRange(d, range)) return;
      var sc; Object.keys(r.scores).forEach(function (k) { if (idKey(k) === key) sc = r.scores[k]; });
      if (sc === undefined || sc === null || sc === '') return;
      if (subjectSpoken) { var s1 = M.tsim(norm(subjectSpoken).replace(/ /g, ''), norm(r.subject).replace(/ /g, '')); if (s1 < 0.78) return; }
      out.push({ date: d, subject: r.subject || '', test: r.testName || '', category: r.category || '', level: r.level || '', score: Number(sc) });
    });
    return out.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  }
  function feesOf(studentId, classId) {
    var f = (S.fees || []).filter(function (x) { return idKey(x && x.id) === idKey(studentId); })[0];
    var paid = f && Array.isArray(f.payments) ? f.payments.reduce(function (a, p) { return a + (Number(p.amount) || 0); }, 0) : 0;
    var cfg = S.cfg[classId], total = cfg && Number(cfg.totalAmount) || 0;
    return { paid: paid, total: total, balance: total ? Math.max(0, total - paid) : null, status: total > 0 ? (paid > total ? 'over paid' : paid === total ? 'fully paid' : paid > 0 ? 'outstanding balance' : 'not paid') : (paid > 0 ? 'paid (no total set)' : 'not paid') };
  }

  window.TeachMateKnowledge = {
    refresh: refresh, onChange: function (f) { listeners.push(f); }, markDirty: markDirty,
    findLearners: findLearners, extract: extract, hasLearner: function (t) { try { return extract(t).found.length > 0; } catch (e) { return false; } },
    findClass: findClass, parseRange: parseRange, dayLabel: dayLabel,
    attendanceOf: attendanceOf, attendanceOfClass: attendanceOfClass, resultsOf: resultsOf, feesOf: feesOf,
    classes: function () { return Object.keys(S.cmap || {}).map(function (id) { return S.cmap[id]; }); },
    className: function (id) { return S.cmap && S.cmap[id] ? S.cmap[id].name : pretty(id || ''); },
    learnersOf: function (classId) { return byClass[classId] || []; },
    allLearners: function () { return S.stu || []; },
    isWord: function (w) { return !!nameWords[w]; },
    names: function () { var o = {}; Object.keys(nameWords).forEach(function (k) { if (k.indexOf('c:') !== 0) o[k] = 1; }); return o; },
    subjects: function () { var u = {}; (S.results || []).forEach(function (r) { if (r && r.subject) u[String(r.subject).trim()] = 1; }); return Object.keys(u); },
    summary: function () { return { classes: Object.keys(S.cmap || {}).length, learners: (S.stu || []).length, attendance: S.att.length, results: S.results.length }; }
  };
})();
