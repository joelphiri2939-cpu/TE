/* ui/voice-actions-data.js — voice tasks that use the school's data (not just what is on screen):
 * find any learner in any class, read their attendance / marks / fees for a day, week, month or term,
 * list a class, and make marks / attendance / report-card commands work even when a different class (or no class)
 * is open: the assistant looks up which class the learner is in and switches to it. */
(function () {
  'use strict';
  var A = window.TeachMateVoiceActions, K = window.TeachMateKnowledge, M = window.TeachMateVoiceMatch;
  if (!A || !A.ext || !K || !M) { console.error('[voice-actions-data] needs voice-match, voice-actions and voice-knowledge'); return; }
  var E = A.ext, norm = A.norm, add = E.add, fail = E.fail, list = E.list, wait = E.wait;
  function cap(s) { return String(s).replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }
  function info(title, lines, msg) { return { ok: true, message: msg, verify: { title: title, lines: lines, question: 'Is this what you asked for?', yesLabel: 'Yes', noLabel: 'Not right', undo: null } }; }
  var memo = { t: null, v: false };
  function hasLearner(t) { if (memo.t === t) return memo.v; memo.t = t; memo.v = K.hasLearner(t); return memo.v; }

  /* ---------- cross-class helper (used by attendance, marks, report cards) ---------- */
  async function autoClass(p, names, rowsNow, getName) {
    if (p.classValue) return null;
    await K.refresh();
    if (!K.allLearners().length) return null;
    var rows = rowsNow ? rowsNow() : [], classes = {};
    for (var i = 0; i < names.length; i++) {
      var nm = norm(names[i]);
      if (rows.length && E.pickByName(rows, nm, getName, true).hit) continue;              // already on screen
      var m = K.findLearners(nm);
      if (m.many) {
        var ids = {}; m.many.forEach(function (s) { ids[s.classId] = 1; });
        var cl = Object.keys(ids);
        if (cl.length > 1) return { err: cap(nm) + ' could be in ' + list(cl.map(K.className), 4) + '. Please say the class too, for example \u201cin Grade 8\u201d. Nothing was changed.' };
        classes[cl[0]] = 1; continue;
      }
      if (!m.hit) return { err: 'I couldn\u2019t find \u201c' + nm + '\u201d in any of your classes.' + (m.near.length ? ' Did you mean ' + list(m.near.map(function (s) { return s.name + ' (' + K.className(s.classId) + ')'; }), 3) + '? Nothing was changed.' : ' Nothing was changed.') };
      classes[m.hit[0].classId] = 1;
    }
    var all = Object.keys(classes);
    if (!all.length) return null;
    if (all.length > 1) return { err: 'Those learners are in different classes (' + list(all.map(K.className), 4) + '). Please do one class at a time. Nothing was changed.' };
    p.classValue = all[0]; p.classLabel = K.className(all[0]);
    return null;
  }
  E.autoClass = autoClass;

  /* ---------- parsing a data question ---------- */
  function parseQ(t) {
    var ex = K.extract(t), cls = K.findClass(t), range = K.parseRange(t);
    return { learners: ex.found, cls: cls, range: range, rest: ex.rest };
  }
  function oneLearner(q) {
    if (!q.learners.length) return { err: 'Which learner? Say the name, for example \u201cChileshe Mwewa\u201d.' };
    var f = q.learners[0], cand = f.many || [f.student];
    if (cand.length > 1 && q.cls.hit) { var c = cand.filter(function (s) { return s.classId === q.cls.hit[0].id; }); if (c.length) cand = c; }
    if (cand.length > 1) {
      var ids = {}; cand.forEach(function (s) { ids[s.classId] = 1; }); var cl = Object.keys(ids);
      return { err: 'More than one learner is called ' + cand[0].name + (cl.length > 1 ? ': in ' + list(cl.map(K.className), 4) + '. Please say the class too.' : '. Please use the full name.') };
    }
    return { st: cand[0] };
  }
  function ready() { return K.refresh().then(function () { var s = K.summary(); return s.learners > 0; }); }
  var NODATA = 'I can\u2019t see any learners yet. TeachMate may still be loading your school data, or none has been synced to this phone. Try again in a moment.';

  /* ---------- attendance history ---------- */
  var AW = /\b(absent|absences?|present|attendance|attend|attended|late|missed|come|came)\b/, EDIT = /\b(mark|set|put|record|save|tick|change|clear|delete)\b/;
  add('know_attendance', 'read attendance history', [['how many', 'how often', 'was', 'did', 'show', 'read', 'tell me', 'check', 'what', 'who'], ['absent', 'absences', 'present', 'attendance', 'attended', 'missed']], {
    alsoIf: function (t) { return AW.test(t) && !EDIT.test(t) && (hasLearner(t) || /\b(yesterday|last (week|month)|past|this (week|month)|days?)\b/.test(t)); },
    parse: function (t) { var q = parseQ(t); return { params: { q: q, want: /\babsent|absences?|missed\b/.test(t) ? 'absent' : /\bpresent|attended|came\b/.test(t) ? 'present' : 'all' } }; }
  }, async function (p) {
    if (!(await ready())) return fail(NODATA);
    var q = p.q, r = q.range;
    if (q.learners.length) {
      var o = oneLearner(q); if (o.err) return fail(o.err);
      var st = o.st, a = K.attendanceOf(st.id, r, st.classId), cn = K.className(st.classId);
      if (!a.total) return info('Attendance \u2014 ' + st.name, [cn, 'No attendance records for ' + r.label + '.'], 'I have no attendance records for ' + st.name + ' for ' + r.label + '.');
      var lines = [cn, 'Period: ' + r.label, 'Present: ' + a.present.length + ' days', 'Absent: ' + a.absent.length + ' days'];
      if (a.absent.length) lines.push('Absent on: ' + a.absent.map(K.dayLabel).join(', '));
      var pct = Math.round(a.present.length / a.total * 100), msg;
      if (p.want === 'absent') msg = st.name + ' was absent ' + a.absent.length + (a.absent.length === 1 ? ' day' : ' days') + ' ' + (r.label === 'on record' ? 'on record' : r.label) + (a.absent.length ? ': ' + list(a.absent.map(K.dayLabel), 6) : '') + '.';
      else if (p.want === 'present') msg = st.name + ' was present ' + a.present.length + ' of ' + a.total + ' days ' + r.label + ', ' + pct + ' percent.';
      else msg = st.name + ' in ' + cn + ': present ' + a.present.length + ', absent ' + a.absent.length + ' ' + r.label + ' (' + pct + ' percent present)' + (a.absent.length ? '. Absent on ' + list(a.absent.map(K.dayLabel), 5) : '') + '.';
      return info('Attendance \u2014 ' + st.name, lines, msg);
    }
    if (q.cls.hit || q.cls.many) {
      if (q.cls.many) return fail('Which class: ' + list(q.cls.many.map(function (c) { return c.name; }), 4) + '?');
      var cls = q.cls.hit[0], kids = K.learnersOf(cls.id);
      if (r.from && r.from === r.to) {
        var recs = K.attendanceOfClass(cls.id, r), idsDone = {}, absent = [];
        recs.forEach(function (x) { idsDone[String(x.studentId).trim().toLowerCase()] = 1; if (!x.present) { var s = kids.filter(function (k) { return String(k.id).trim().toLowerCase() === String(x.studentId).trim().toLowerCase(); })[0]; absent.push(s ? s.name : x.studentId); } });
        if (!recs.length) return info('Attendance \u2014 ' + cls.name, ['No attendance was recorded for ' + r.label + '.'], 'No attendance was recorded for ' + cls.name + ' ' + r.label + '.');
        return info('Attendance \u2014 ' + cls.name, ['Day: ' + r.label, 'Recorded: ' + recs.length + ' of ' + kids.length, 'Absent (' + absent.length + '): ' + (absent.join(', ') || 'none')],
          absent.length ? absent.length + ' absent in ' + cls.name + ' ' + r.label + ': ' + list(absent, 8) + '.' : 'Nobody was absent in ' + cls.name + ' ' + r.label + '.');
      }
      var recs2 = K.attendanceOfClass(cls.id, r), cnt = {};
      recs2.forEach(function (x) { if (!x.present) { var k = String(x.studentId).trim().toLowerCase(); cnt[k] = (cnt[k] || 0) + 1; } });
      var rank = Object.keys(cnt).map(function (k) { var s = kids.filter(function (z) { return String(z.id).trim().toLowerCase() === k; })[0]; return { n: s ? s.name : k, c: cnt[k] }; }).sort(function (a, b) { return b.c - a.c; });
      if (!recs2.length) return info('Attendance \u2014 ' + cls.name, ['No attendance was recorded for ' + r.label + '.'], 'No attendance was recorded for ' + cls.name + ' for ' + r.label + '.');
      var top = rank.slice(0, 5);
      return info('Attendance \u2014 ' + cls.name, ['Period: ' + r.label, 'Learners with absences: ' + rank.length].concat(top.map(function (x) { return x.n + ': ' + x.c + ' absent'; })),
        rank.length ? rank.length + ' learners had absences in ' + cls.name + ' ' + r.label + '. Most: ' + list(top.map(function (x) { return x.n + ' ' + x.c; }), 5) + '.' : 'Nobody was absent in ' + cls.name + ' ' + r.label + '.');
    }
    return fail('Whose attendance, or which class? Say, for example, \u201cChileshe Mwewa\u2019s attendance last week\u201d.');
  });

  /* ---------- marks / results history ---------- */
  var RW = /\b(marks|results?|scores?|average|performance|grades|did .* get|got|(?:what|which|his|her|their|the) mark)\b/;
  function subjectIn(t) {
    var subs = K.subjects(), toks = norm(t).split(' '), best = null, bs = 0;
    subs.forEach(function (sj) { var sn = norm(sj); for (var n = 3; n >= 1; n--) for (var i = 0; i + n <= toks.length; i++) { var s = M.tsim(toks.slice(i, i + n).join(''), sn.replace(/ /g, '')); if (s > bs && s >= 0.86) { bs = s; best = sj; } } });
    return best;
  }
  add('know_results', 'read a learner\u2019s marks', [['what', 'show', 'read', 'tell me', 'how', 'check', 'give me'], ['marks', 'results', 'scores', 'average', 'performance']], {
    alsoIf: function (t) { return RW.test(t) && hasLearner(t) && !/\b(enter|record|put|write|add|set|save|mark)\b\s+(?!did|do|is)/.test(t) && !/\b(present|absent)\b/.test(t) && !/\bgive\b.*\b\d+\b/.test(t); },
    parse: function (t) { var q = parseQ(t); return { params: { q: q, subject: subjectIn(t) } }; }
  }, async function (p) {
    if (!(await ready())) return fail(NODATA);
    var o = oneLearner(p.q); if (o.err) return fail(o.err);
    var st = o.st, r = p.q.range, rs = K.resultsOf(st.id, r, p.subject), cn = K.className(st.classId);
    if (!rs.length) return info('Marks \u2014 ' + st.name, [cn, 'No marks found' + (p.subject ? ' for ' + p.subject : '') + ' ' + r.label + '.'], 'I found no marks for ' + st.name + (p.subject ? ' in ' + p.subject : '') + ' ' + r.label + '.');
    var by = {}; rs.forEach(function (x) { var k = x.subject || 'Other'; (by[k] = by[k] || []).push(x.score); });
    var avgs = Object.keys(by).map(function (k) { var a = by[k]; return { s: k, a: Math.round(a.reduce(function (x, y) { return x + y; }, 0) / a.length * 10) / 10, n: a.length }; }).sort(function (a, b) { return b.a - a.a; });
    var overall = Math.round(rs.reduce(function (x, y) { return x + y.score; }, 0) / rs.length * 10) / 10;
    var lines = [cn, 'Period: ' + r.label, 'Overall average: ' + overall + ' from ' + rs.length + ' marks'].concat(avgs.map(function (x) { return x.s + ': average ' + x.a + ' (' + x.n + ')'; }));
    lines = lines.concat(rs.slice(0, 6).map(function (x) { return (x.date ? K.dayLabel(x.date) + ' \u2014 ' : '') + (x.subject || '') + ' ' + (x.test || '') + ': ' + x.score; }));
    var msg = p.subject ? st.name + ' has an average of ' + avgs[0].a + ' in ' + avgs[0].s + ' from ' + avgs[0].n + ' marks ' + r.label + '. Latest: ' + rs[0].test + ' ' + rs[0].score + '.'
      : st.name + ' has an overall average of ' + overall + ' from ' + rs.length + ' marks ' + r.label + '. Best subject: ' + avgs[0].s + ' ' + avgs[0].a + (avgs.length > 1 ? ', lowest: ' + avgs[avgs.length - 1].s + ' ' + avgs[avgs.length - 1].a : '') + '.';
    return info('Marks \u2014 ' + st.name, lines, msg);
  });

  /* ---------- fees for any learner ---------- */
  add('know_fees', 'read a learner\u2019s fees', [['how much', 'what', 'check', 'tell me', 'show'], ['paid', 'balance', 'owe', 'owes', 'fees']], {
    alsoIf: function (t) { return /\b(paid|pay|balance|owe|owes|owing|fees?)\b/.test(t) && hasLearner(t) && !/\b(enter|record|put|write|add|save|change)\b/.test(t); },
    parse: function (t) { return { params: { q: parseQ(t) } }; }
  }, async function (p) {
    if (!(await ready())) return fail(NODATA);
    var o = oneLearner(p.q); if (o.err) return fail(o.err);
    var st = o.st, f = K.feesOf(st.id, st.classId), cn = K.className(st.classId);
    var lines = [cn, 'Paid: ' + f.paid + ' ZMW', f.total ? 'Total fees: ' + f.total + ' ZMW' : 'Total fees not set by admin', f.balance !== null ? 'Balance: ' + f.balance + ' ZMW' : '', 'Status: ' + f.status].filter(Boolean);
    return info('Fees \u2014 ' + st.name, lines, st.name + ' has paid ' + f.paid + ' ZMW' + (f.total ? ' of ' + f.total + ', balance ' + f.balance : '') + '. Status: ' + f.status + '.');
  });

  /* ---------- finding learners and classes ---------- */
  add('know_find_learner', 'find a learner', [['find', 'search for', 'look for', 'locate', 'pull up', 'go to', 'open', 'show'], ['learner', 'student', 'pupil', 'profile', 'details', 'data', 'record', 'information']], {
    alsoIf: function (t) { return /\b(find|locate|pull up|look for|search for|go to|open|show)\b/.test(t) && hasLearner(t) && !AW.test(t) && !RW.test(t) && !/\b(paid|pay|balance|owe|fees?)\b/.test(t); },
    parse: function (t) { return { params: { q: parseQ(t) } }; }
  }, async function (p) {
    if (!(await ready())) return fail(NODATA);
    var o = oneLearner(p.q); if (o.err) return fail(o.err);
    var st = o.st, cn = K.className(st.classId), now = new Date(), from = new Date(now.getFullYear(), now.getMonth(), 1);
    var pad2 = function (n) { return (n < 10 ? '0' : '') + n; }, rg = { from: from.getFullYear() + '-' + pad2(from.getMonth() + 1) + '-01', to: now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()), label: 'this month' };
    var a = K.attendanceOf(st.id, rg, st.classId), rs = K.resultsOf(st.id, null), f = K.feesOf(st.id, st.classId);
    var avg = rs.length ? Math.round(rs.reduce(function (x, y) { return x + y.score; }, 0) / rs.length * 10) / 10 : null;
    if (await E.ensureSection('class-management') && typeof window._cm2Search === 'function') { try { window._cm2Search(st.name); } catch (e) {} }
    var lines = ['Class: ' + cn, 'Learner ID: ' + st.id, 'Attendance this month: ' + a.present.length + ' present, ' + a.absent.length + ' absent', avg !== null ? 'Average mark: ' + avg + ' from ' + rs.length + ' marks' : 'No marks yet', 'Fees: ' + f.status + (f.total ? ' (' + f.paid + ' of ' + f.total + ' ZMW)' : '')];
    return info(st.name, lines, st.name + ' is in ' + cn + '. This month: ' + a.present.length + ' present, ' + a.absent.length + ' absent' + (avg !== null ? '. Average mark ' + avg : '') + '. Fees: ' + f.status + '. I\u2019ve opened their record in class management.');
  });
  add('know_learner_class', 'tell you which class a learner is in', [['which class is', 'what class is', 'which grade is', 'what grade is', 'which class does', 'what class does', 'where does', 'which class']], {
    parse: function (t) { return { params: { q: parseQ(t) } }; }
  }, async function (p) {
    if (!(await ready())) return fail(NODATA);
    var f = p.q.learners[0]; if (!f) return fail('Which learner? Say, for example, \u201cwhich class is Chileshe Mwewa in\u201d.');
    var cand = f.many || [f.student];
    return info('Class of ' + cand[0].name, cand.map(function (s) { return s.name + ': ' + K.className(s.classId); }), cand.length === 1 ? cand[0].name + ' is in ' + K.className(cand[0].classId) + '.' : cand[0].name + ' appears in ' + list(cand.map(function (s) { return K.className(s.classId); }), 4) + '.');
  });
  add('know_class_list', 'read the learners in a class', [['who is in', 'who are in', 'list learners in', 'list students in', 'learners in', 'students in', 'names of learners in', 'read the learners in', 'who is in the class']], {
    parse: function (t) {
      var section = A.currentSection && A.currentSection(), selId = A.CLASS_SEL && A.CLASS_SEL[section];
      var sel = selId ? document.getElementById(selId) : null;
      return { params: { q: parseQ(t), cur: (sel || {}).value || '' } };
    }
  }, async function (p) {
    if (!(await ready())) return fail(NODATA);
    var cls = p.q.cls.hit ? p.q.cls.hit[0] : (p.cur && K.className(p.cur) ? { id: p.cur, name: K.className(p.cur) } : null);
    if (p.q.cls.many) return fail('Which class: ' + list(p.q.cls.many.map(function (c) { return c.name; }), 4) + '?');
    if (!cls) return fail('Which class? Say, for example, \u201cwho is in Grade 8\u201d.');
    var kids = K.learnersOf(cls.id).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!kids.length) return info(cls.name, ['No learners found.'], 'I can\u2019t see any learners in ' + cls.name + '.');
    return info(cls.name + ' \u2014 ' + kids.length + ' learners', kids.map(function (k) { return k.name; }), cls.name + ' has ' + kids.length + ' learners: ' + list(kids.map(function (k) { return k.name; }), 10) + '.');
  });
  add('know_overview', 'tell you about your classes', [['what', 'which', 'list', 'tell me', 'how many'], ['classes', 'my classes', 'classes do i have', 'classes do i teach', 'classes am i teaching']], {}, async function () {
    if (!(await ready())) return fail(NODATA);
    var cs = K.classes().filter(function (c) { return K.learnersOf(c.id).length || true; });
    if (!cs.length) return fail('I can\u2019t see any classes yet.');
    var lines = cs.map(function (c) { return c.name + ': ' + K.learnersOf(c.id).length + ' learners'; });
    return info('Your classes', lines, 'You have ' + cs.length + (cs.length === 1 ? ' class: ' : ' classes: ') + list(cs.map(function (c) { return c.name + ' with ' + K.learnersOf(c.id).length; }), 8) + '.');
  });

  /* ---------- "fetch me Grade 11": choose the class inside whichever feature is open, then wait for commands about it ---------- */
  var CLASSREF = /\b(?:grade|class|form)\s*\d+/;
  async function waitCount(sel, ms) { var t0 = Date.now(); while (Date.now() - t0 < ms) { var n = document.querySelectorAll(sel).length; if (n) return n; await wait(200); } return document.querySelectorAll(sel).length; }
  add('select_class', 'choose a class', [['fetch', 'get', 'bring', 'load', 'select', 'choose', 'switch', 'go to', 'open', 'show', 'pull up', 'take me to', 'give me', 'find', 'use', 'change to', 'change', 'class'], ['grade', 'class', 'form']], {
    alsoIf: function (t) {
      var cur = A.currentSection(); if (!cur || !A.CLASS_SEL[cur] || !CLASSREF.test(t)) return false;
      if (hasLearner(t) || /\b(absent|present|marks?|results?|average|owe|paid|fees?|history|save|export|term|week|report|enter|record|how|who|what|many|generate)\b/.test(t)) return false;
      return t.split(' ').length <= 9;
    },
    parse: function (t) { return { params: { t: t } }; },
    describe: function () { return 'choose that class'; }
  }, async function (p) {
    var cur = A.currentSection(), selId = A.CLASS_SEL[cur];
    if (!selId) return fail('This screen has no class list. Open attendance, results or fees first.');
    var c = A.matchClass(selId, p.t), val, label;
    if (c.hits && c.hits.length === 1) { val = c.hits[0].value; label = c.hits[0].text; }
    else if (c.hits && c.hits.length > 1) return fail('Which class: ' + list(c.hits.map(function (o) { return o.text; }), 4) + '?');
    else {
      await K.refresh(); var kc = K.findClass(p.t);
      if (kc.hit) { val = kc.hit[0].id; label = kc.hit[0].name; }
      else return fail('I couldn\u2019t find that class. Your classes are ' + list(K.classes().map(function (x) { return x.name; }), 6) + '.');
    }
    if (!(await E.pickClass(selId, { classValue: val }))) return fail(label + ' isn\u2019t in the list on this screen.');
    var n = 0;
    if (cur === 'attendance') n = await waitCount('#attendance-table tbody tr .present-btn', 5000);
    else if (cur === 'results') { if (typeof window.loadResultsStudents === 'function') { try { await window.loadResultsStudents(); } catch (e) {} } n = await waitCount('#results-table tbody tr', 4000); }
    else if (cur === 'fees') { if (typeof window.loadFeesStudents === 'function') { try { await window.loadFeesStudents(); } catch (e) {} } n = await waitCount('#fees-table tbody tr', 4000); }
    K.syncDom();
    p.classValue = val; p.classLabel = label;
    return { ok: true, message: label + ' is ready' + (n ? ' with ' + n + ' learners' : '') + '. What would you like to do with it?' };
  });

  add('know_status', 'tell you what school data I can see', [['what', 'how much', 'which'], ['data', 'do you know', 'can you see', 'have you loaded', 'is loaded']], {}, async function () {
    await K.refresh(true); var s = K.summary();
    return info('School data I can see', ['Classes: ' + s.classes, 'Learners: ' + s.learners, 'Attendance records: ' + s.attendance, 'Results saved: ' + s.results], 'I can see ' + s.classes + ' classes, ' + s.learners + ' learners, ' + s.attendance + ' attendance records and ' + s.results + ' saved results.');
  });
})();
