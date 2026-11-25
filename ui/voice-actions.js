/* ui/voice-actions.js — catalog of every voice-operable TeachMate task.
 * Fixed registry: no eval. Tasks call existing TeachMate functions or press the app's OWN
 * buttons (so the app's validation and native confirm dialogs still apply).
 * kw = groups that must ALL match (each group = alternatives). risk: low | medium | high.
 * Every run() returns {ok, message} describing what really happened. */
(function () {
  'use strict';

  var UNITS = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19 };
  var TENS = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
  function numberize(toks) {
    var o = [], i;
    for (i = 0; i < toks.length; i++) {
      var w = toks[i];
      if (UNITS.hasOwnProperty(w)) o.push(String(UNITS[w])); else if (TENS.hasOwnProperty(w)) o.push(String(TENS[w])); else o.push(w);
    }
    var r = [];
    for (i = 0; i < o.length; i++) {
      var x = o[i];
      if (/^\d+$/.test(x) && +x >= 20 && +x <= 90 && +x % 10 === 0 && /^[1-9]$/.test(o[i + 1] || '')) { r.push(String(+x + +o[i + 1])); i++; continue; }          // forty 5 -> 45
      if (x === 'hundred' || x === 'hundreds') { var pv = r.length && /^\d+$/.test(r[r.length - 1]) ? +r.pop() : 1; r.push(String(pv * 100)); continue; }
      if (x === 'point' && r.length && /^\d+(\.\d+)?$/.test(r[r.length - 1]) && /^\d+$/.test(o[i + 1] || '')) { r.push(r.pop() + '.' + o[i + 1]); i++; continue; }  // 78 point 5 -> 78.5
      r.push(x);
    }
    return r;
  }
  function norm(s) {
    var t = String(s || '').toLowerCase().replace(/(\d)\.(\d)/g, '$1 point $2').replace(/[^a-z0-9 ]/g, ' ');
    return numberize(t.split(/\s+/).filter(Boolean)).join(' ');
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function $(id) { return document.getElementById(id); }
  function db(store) {
    if (typeof window.getIndexedDB === 'function') return window.getIndexedDB(store);
    if (typeof getIndexedDB === 'function') return getIndexedDB(store);
    return Promise.reject(new Error('Data layer not available'));
  }
  var LABEL = { attendance: 'the attendance register', results: 'results tracking', fees: 'fees tracking',
    messages: 'messages', 'class-management': 'class management', dashboard: 'the dashboard' };

  function vis(el) {
    if (!el) return false;
    try {
      var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
      if (el.style && el.style.display === 'none') return false;
      if (el.getBoundingClientRect) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    } catch (e) {}
    return !!el.offsetParent || (el.style && el.style.display === 'block');
  }
  function sectionOpen(id) { var e = $(id); return !!e && e.style.display !== 'none' && vis(e) && (e.style.display === 'block' || (window.getComputedStyle && window.getComputedStyle(e).display !== 'none')); }
  async function ensureSection(id) {
    if (typeof window.showSection !== 'function') return false;
    if (!sectionOpen(id)) { window.showSection(id); await wait(450); }
    return sectionOpen(id);
  }
  async function press(btnId, section, what, allowHidden) {
    if (section && !(await ensureSection(section))) return { ok: false, message: 'I couldn\u2019t open ' + LABEL[section] + ' (are you logged in?).' };
    var b = $(btnId);
    if (!b || (!allowHidden && !vis(b))) return { ok: false, message: 'The \u201c' + what + '\u201d button isn\u2019t available on this screen.' };
    if (b.disabled) return { ok: false, message: 'The \u201c' + what + '\u201d button is disabled right now.' };
    b.click();
    return { ok: true, message: 'I pressed \u201c' + what + '\u201d. Please check the screen for the result.' };
  }

  /* ----- classes: matched against the real <select> options, never guessed ----- */
  function matchClass(selectId, t) {
    var sel = $(selectId);
    if (!sel) return { options: [] };
    var opts = [].slice.call(sel.options).filter(function (o) { return o.value; });
    var m = t.match(/(?:grade|class|form)\s*(\d+)\s*([a-z])?\b/);
    var all = opts.map(function (o) { return o.text; });
    if (!m) return { options: all, none: true };
    var hits = opts.filter(function (o) { return new RegExp('(^|[^0-9])' + m[1] + '([^0-9]|$)').test(o.text + ' ' + o.value); });
    if (hits.length > 1 && m[2] && m[2].length === 1) {
      var f = hits.filter(function (o) { return new RegExp('\\b' + m[1] + '\\s*' + m[2] + '|' + m[2] + 'form', 'i').test(o.text + ' ' + o.value); });
      if (f.length) hits = f;
    }
    return { hits: hits, options: all };
  }
  async function pickClass(selectId, p) {
    var sel = $(selectId);
    if (!sel) return false;
    sel.value = p.classValue;
    if (sel.value !== p.classValue) return false;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  var CLASS_SEL = { attendance: 'attendance-class', results: 'results-class', fees: 'fees-class' };

  function nav(section) {
    return async function () {
      var ok = await ensureSection(section);
      return ok ? { ok: true, message: 'I\u2019ve opened ' + LABEL[section] + '.' }
                : { ok: false, message: 'I couldn\u2019t open ' + LABEL[section] + '. Are you logged in?' };
    };
  }
  function openWithClass(section, loadBtn, loadFn) {
    return async function (p) {
      if (!(await ensureSection(section))) return { ok: false, message: 'I couldn\u2019t open ' + LABEL[section] + '.' };
      if (!p.classValue) return { ok: true, message: 'I\u2019ve opened ' + LABEL[section] + '.' };
      if (!(await pickClass(CLASS_SEL[section], p))) return { ok: false, message: p.classLabel + ' isn\u2019t in the class list here.' };
      await wait(250);
      if (loadBtn && $(loadBtn) && $(loadBtn).offsetParent !== null) $(loadBtn).click();
      else if (loadFn && typeof window[loadFn] === 'function') { try { window[loadFn](); } catch (e) {} }
      return { ok: true, message: 'I\u2019ve opened ' + LABEL[section] + ' for ' + p.classLabel + '.' };
    };
  }
  function btn(id, section, what, allowHidden) { return function () { return press(id, section, what, allowHidden); }; }

  var T = []; // the task catalog
  function add(id, label, kw, o, run) { o = o || {}; T.push({ id: id, label: label, kw: kw, risk: o.risk || 'low', classSection: o.classSection, slot: o.slot, parse: o.parse, alsoIf: o.alsoIf, confirmText: o.confirmText, run: run }); }
  var OPEN = ['open', 'show', 'go to', 'take me to', 'view', 'see', 'display', 'start'];

  /* ---- Navigation ---- */
  add('nav_attendance', 'open attendance', [OPEN, ['attendance', 'register']], { classSection: 'attendance' }, openWithClass('attendance'));
  add('nav_results', 'open results', [OPEN, ['results', 'marks', 'result tracking']], { classSection: 'results' }, openWithClass('results', 'loadResultsStudentsBtn'));
  add('nav_fees', 'open fees', [OPEN, ['fees', 'payments', 'fee tracking']], { classSection: 'fees' }, openWithClass('fees', null, 'loadFeesStudents'));
  add('nav_messages', 'open messages', [OPEN, ['messages', 'sms inbox']], {}, nav('messages'));
  add('nav_classes', 'open class management', [OPEN, ['class management', 'learners list', 'class list', 'my classes']], {}, nav('class-management'));
  add('nav_home', 'go to the dashboard', [['home', 'dashboard', 'main menu', 'go home']], {}, async function () {
    if (typeof window.showSection !== 'function') return { ok: false, message: 'TeachMate isn\u2019t ready.' };
    window.showSection('dashboard'); await wait(250); return { ok: true, message: 'I\u2019ve gone to the dashboard.' };
  });
  add('go_back', 'go back', [['go back', 'close', 'back', 'exit', 'return', 'close this page']], {}, async function () {
    if (typeof window.closeFullPage === 'function') window.closeFullPage(); return { ok: true, message: 'I\u2019ve closed this page.' };
  });
  add('lesson_planner', 'open the lesson planner', [OPEN, ['lesson planner', 'lesson plan', 'planner']], {}, async function () {
    // TeachMate's own home screen opens the planner by clicking this (hidden) legacy button
    if (typeof window.openLessonPlanner === 'function') { try { window.openLessonPlanner(); return { ok: true, message: 'I\u2019ve asked TeachMate to open the lesson planner.' }; } catch (e) {} }
    var r = await press('openPlannerBtn', null, 'Lesson Planner', true);
    return r.ok ? { ok: true, message: 'I\u2019ve asked TeachMate to open the lesson planner.' } : { ok: false, message: 'The lesson planner isn\u2019t available yet. Finish your profile setup first, then try again.' };
  });
  add('help', 'open help', [['help', 'guide', 'tutorial']], {}, btn('tm-help-btn', null, 'Help', true));
  add('import_data', 'open data import', [['open', 'start', 'run'], ['data import', 'import data', 'data migration', 'import learners']], {}, async function () {
    if (typeof window.openDataMigrationEngine !== 'function') return { ok: false, message: 'Data import isn\u2019t available.' };
    window.openDataMigrationEngine(); return { ok: true, message: 'I\u2019ve opened the data import tool.' };
  });
  add('logout', 'log out', [['log out', 'logout', 'sign out']], { risk: 'medium', confirmText: 'log you out' }, btn('logout-btn', null, 'Log out', true));

  /* ---- Attendance ---- */
  add('att_history', 'view attendance history', [OPEN.concat(['check']), ['attendance'], ['history', 'records', 'past', 'previous']], {}, btn('viewAttendanceHistoryBtn', 'attendance', 'View Attendance History'));
  add('att_hide_history', 'hide attendance history', [['hide', 'close'], ['attendance'], ['history', 'records']], {}, btn('hideAttendanceHistoryBtn', 'attendance', 'Hide History'));
  add('att_clear', 'clear the attendance entries', [['clear', 'reset'], ['attendance', 'register']], { risk: 'high', confirmText: 'clear the attendance entries on screen' }, btn('clearAttendanceBtn', 'attendance', 'Clear'));
  add('att_delete_all', 'delete ALL attendance records', [['delete', 'remove', 'erase'], ['all', 'every', 'everything'], ['attendance']], { risk: 'high', confirmText: 'delete ALL attendance records, which may be permanent' }, btn('deleteAllAttendanceBtn', 'attendance', 'Delete All Attendance'));
  add('subj_att_open', 'open subject attendance', [OPEN, ['subject attendance', 'subject register']], {}, btn('openSubjectAttendanceBtn', 'attendance', 'Subject Attendance'));
  add('subj_att_history', 'view subject attendance history', [OPEN, ['subject attendance', 'subject register'], ['history', 'records', 'past']], {}, btn('viewSubjectAttendanceHistoryBtn', 'attendance', 'Subject Attendance History'));
  add('subj_commit', 'save the subject register', [['save', 'commit', 'submit'], ['subject'], ['attendance', 'register']], { risk: 'medium', confirmText: 'save the subject attendance' }, btn('tm-subatt-commit', null, 'Save subject attendance'));

  /* ---- Results ---- */
  add('res_load', 'load results learners', [['load', 'get', 'fetch'], ['results', 'marks'], ['learners', 'students', 'class']], {}, btn('loadResultsStudentsBtn', 'results', 'Load Students'));
  add('res_history', 'view results history', [OPEN, ['results', 'marks'], ['history', 'records', 'past', 'previous']], {}, btn('viewResultsHistoryBtn', 'results', 'View Results History'));
  add('res_pdf', 'export results as PDF', [['export', 'download', 'print', 'create'], ['results', 'marks'], ['pdf', 'document']], {}, btn('exportResultsPdfBtn', 'results', 'Export Results PDF'));
  add('res_automark', 'open AutoMark', [OPEN, ['automark', 'auto mark', 'automatic marking']], {}, btn('openAutoMarkBtn', 'results', 'AutoMark'));
  add('res_analytics', 'generate analytics', [['generate', 'show', 'open', 'create'], ['analytics', 'statistics', 'class performance']], {}, btn('generateAnalyticsBtn', 'results', 'Generate Analytics'));
  add('res_sms_class', 'send an SMS to the class', [['send', 'text', 'sms'], ['class', 'everyone', 'all parents', 'parents'], ['sms', 'message', 'results']], { risk: 'high', confirmText: 'send an SMS to the whole class' }, btn('sendClassSMSBtn', 'results', 'Send Class SMS'));
  add('res_sms_pick', 'pick learners for SMS', [['pick', 'choose', 'select'], ['learners', 'students'], ['sms', 'message']], {}, btn('smsPickStudentsBtn', 'results', 'Pick Students for SMS'));
  add('res_clear_inputs', 'clear the results entries', [['clear', 'reset'], ['results', 'marks', 'inputs']], { risk: 'high', confirmText: 'clear the results entries on screen' }, btn('clearResultsInputsBtn', 'results', 'Clear'));
  add('res_delete_all', 'delete ALL results', [['delete', 'remove', 'erase'], ['all', 'every', 'everything'], ['results', 'marks']], { risk: 'high', confirmText: 'delete ALL results, which may be permanent' }, btn('deleteAllResultsBtn', 'results', 'Delete All Results'));

  /* ---- Fees ---- */
  add('fees_hide_history', 'hide fees history', [['hide', 'close'], ['fees', 'payments'], ['history', 'records']], {}, async function () {
    if (typeof window.hideFeesHistory === 'function') { window.hideFeesHistory(); return { ok: true, message: 'I\u2019ve hidden the fees history.' }; }
    return { ok: false, message: 'The fees history isn\u2019t open.' };
  });

  /* ---- Class management ---- */
  add('cm_search', 'search for a learner', [['search', 'find', 'look for', 'look up'], ['learner', 'student', 'pupil', 'for']], { slot: /(?:search|find|look for|look up)(?: for)?(?: a| the)?(?: learner| student| pupil)? (.+)$/ }, async function (p) {
    if (!(await ensureSection('class-management'))) return { ok: false, message: 'I couldn\u2019t open class management.' };
    if (!p.slot || typeof window._cm2Search !== 'function') return { ok: false, message: 'I couldn\u2019t search just now.' };
    window._cm2Search(p.slot); return { ok: true, message: 'I\u2019m showing learners matching \u201c' + p.slot + '\u201d. Please check the spelling on screen.' };
  });
  add('cm_sort', 'sort the learner list', [['sort', 'order', 'arrange'], ['name', 'grade', 'fee', 'fees', 'attendance']], { slot: /(name|grade|fees?|attendance)/ }, async function (p) {
    if (!(await ensureSection('class-management'))) return { ok: false, message: 'I couldn\u2019t open class management.' };
    var f = { name: 'name', grade: 'grade', fee: 'fee', fees: 'fee', attendance: 'att' }[p.slot];
    if (!f || typeof window._cm2SortCol !== 'function') return { ok: false, message: 'I couldn\u2019t sort the list.' };
    window._cm2SortCol(f); return { ok: true, message: 'I\u2019ve sorted the list by ' + p.slot + '.' };
  });
  add('cm_export', 'export the class list to CSV', [['export', 'download'], ['class list', 'learners', 'csv', 'spreadsheet']], {}, async function () {
    if (!(await ensureSection('class-management'))) return { ok: false, message: 'I couldn\u2019t open class management.' };
    if (typeof window._cm2ExportCSV !== 'function') return { ok: false, message: 'Export isn\u2019t available.' };
    window._cm2ExportCSV(); return { ok: true, message: 'I asked TeachMate to export the class list.' };
  });
  add('count_learners', 'count learners', [['how many', 'number of', 'count'], ['learners', 'students', 'pupils']], { classSection: 'attendance' }, async function (p) {
    try {
      var s = await db('students'); if (!Array.isArray(s)) s = [];
      var l = p.classValue ? s.filter(function (x) { return x.classId === p.classValue; }) : s, n = l.length;
      return { ok: true, message: 'There ' + (n === 1 ? 'is 1 learner' : 'are ' + n + ' learners') + (p.classLabel ? ' in ' + p.classLabel : ' in total') + '.' };
    } catch (e) { return { ok: false, message: 'I couldn\u2019t read the learner records.' }; }
  });


  /* =================== ATTENDANCE & FEES — detailed voice tasks =================== */
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    var d = [], i, j; for (i = 0; i <= a.length; i++) d[i] = [i]; for (j = 1; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function fail(m) { return { ok: false, message: m }; }
  function list(a, n) { return a.length > n ? a.slice(0, n).join(', ') + ' and ' + (a.length - n) + ' more' : a.join(', '); }
  function classText(sel) { var s = $(sel); return s && s.selectedIndex > -1 && s.value ? s.options[s.selectedIndex].text : ''; }

  function attRows() {
    return [].slice.call(document.querySelectorAll('#attendance-table tbody tr')).filter(function (r) { return !r.querySelector('td[colspan]'); })
      .map(function (tr) {
        var p = tr.querySelector('.present-btn'), a = tr.querySelector('.absent-btn');
        return { tr: tr, p: p, a: a, id: p ? p.dataset.id : '', name: (tr.children[2] ? tr.children[2].textContent : '').trim() };
      }).filter(function (r) { return r.p && r.a; });
  }
  function rowState(r) { return r.p.classList.contains('active') ? 'present' : (r.a.classList.contains('active') ? 'absent' : null); }
  function syncSave() { var sb = $('saveAttendanceBtn'); if (sb) sb.disabled = !document.querySelector('#attendance-table .status-btn.active'); }
  function setRow(r, st) {
    if (st === 'present') r.p.click(); else if (st === 'absent') r.a.click();
    else { r.p.classList.remove('active'); r.a.classList.remove('active'); syncSave(); }
  }
  var ST = { present: 'Present', absent: 'Absent', null: 'Unmarked' };
  async function waitRows(ms) { var t0 = Date.now(); while (Date.now() - t0 < ms) { if (attRows().length) return true; await wait(200); } return attRows().length > 0; }
  /* make sure the register is open, on the requested class, with learners loaded */
  async function readyRegister(p) {
    if (!(await ensureSection('attendance'))) return 'I couldn\u2019t open the attendance register. Are you logged in?';
    var sel = $('attendance-class');
    if (p && p.classValue && sel && sel.value !== p.classValue) {
      if (!(await pickClass('attendance-class', p))) return (p.classLabel || 'That class') + ' isn\u2019t in the class list.';
      await wait(300);
    }
    if (!(await waitRows(5000))) return 'No class register is loaded yet. Say, for example, \u201copen Grade 8 attendance\u201d first.';
    return null;
  }
  var M = window.TeachMateVoiceMatch;
  /* rank items by how well the spoken name matches (spelling + sound); every spoken word must match something */
  function rankNames(items, spoken, getName) {
    var q = spoken.split(' ').filter(Boolean);
    if (!q.length) return [];
    return items.map(function (it) {
      var nt = norm(getName(it)).split(' '), tot = 0, ok = true;
      q.forEach(function (w) { var b = 0; nt.forEach(function (n) { var x = M ? M.tsim(w, n) : (w === n ? 1 : 0); if (x > b) b = x; }); if (b < 0.45) ok = false; tot += b; });
      var s1 = ok ? tot / q.length : 0;
      var cat = q.join(''), s2 = M && cat.length >= 5 ? M.tsim(cat, nt.join('')) * 0.97 : 0;       // recognizer split or merged the name
      return { it: it, s: Math.max(s1, s2) };
    }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s; });
  }
  /* returns {hit:[...]} when sure, {many:[...]} when several fit equally, {near:[...]} when only a guess exists */
  function pickByName(items, spoken, getName, relax) {          // relax: the pool is already the open class, so be generous
    var r = rankNames(items, spoken, getName);
    if (!r.length) return { near: [] };
    var top = r[0];
    if (top.s < (relax ? 0.62 : 0.8)) return { near: r.slice(0, 3).map(function (x) { return x.it; }) };
    var tied = r.filter(function (x) { return top.s - x.s < (relax ? 0.08 : 0.06); });
    if (tied.length > 1) return { many: tied.map(function (x) { return x.it; }) };
    return { hit: [top.it] };
  }
  function resolveNames(rows, names) {
    var out = [], seen = {};
    for (var i = 0; i < names.length; i++) {
      var r = pickByName(rows, names[i], function (x) { return x.name; }, true);
      if (r.many) return { err: 'More than one learner sounds like \u201c' + names[i] + '\u201d: ' + list(r.many.map(function (x) { return x.name; }), 5) + '. Please repeat using the full name. Nothing was changed.' };
      if (!r.hit) return { err: 'I couldn\u2019t find \u201c' + names[i] + '\u201d in this register.' + (r.near.length ? ' Did you mean ' + list(r.near.map(function (x) { return x.name; }), 3) + '? Please say the command again with the right name.' : ' Please repeat the name.') + ' Nothing was changed.' };
      if (!seen[r.hit[0].id]) { seen[r.hit[0].id] = 1; out.push(r.hit[0]); }
    }
    return { rows: out };
  }
  function statusOf(t) {
    var p = /\bpresent\b/.test(t), a = /\babsent\b/.test(t);
    return p && !a ? 'present' : a && !p ? 'absent' : null;
  }
  var NAME_STOP = /\b(mark|set|put|record|tick|as|is|are|was|were|learner|learners|student|students|pupil|pupils|today|please|teachmate|present|absent|in|for|of|from|the|register|attendance|can|you|could|would|kindly|go|find|get|me|my|him|her|them|it|that|this|a|an|now|and then)\b/g;
  function stripClass(t) { return t.replace(/\b(grade|class|form)\s*\d+\s*[a-z]?\b/g, ' '); }
  function splitNames(s) { return s.replace(/\s+/g, ' ').trim().split(/\band\b/).map(function (x) { return x.trim(); }).filter(Boolean); }

  function snapshotUndo(rows, before, what) {
    return async function () {
      rows.forEach(function (r) { setRow(r, before[r.id]); });
      await wait(100);
      var still = rows.filter(function (r) { return rowState(r) !== before[r.id]; });
      return still.length ? 'I tried to undo but ' + still.length + ' entries still differ. Please check the register.' : 'Undone. The register is back to how it was before ' + what + '. (Nothing was saved.)';
    };
  }

  add('att_mark_names', 'mark learners present or absent', [['mark', 'set', 'put', 'record', 'tick'], ['present', 'absent']], { classSection: 'attendance',
    parse: function (t) {
      var st = statusOf(t); if (!st) return { ask: 'Do you want them marked present or absent?' };
      var names = splitNames(stripClass(t).replace(NAME_STOP, ' '));
      if (!names.length) return { ask: 'Which learner? Say, for example, \u201cmark Peter Banda absent\u201d.' };
      return { params: { status: st, names: names } };
    } }, async function (p) {
    var X = window.TeachMateVoiceActions.ext;   // a learner from another class? find the class and switch to it
    if (X.autoClass) { var ac = await X.autoClass(p, p.names, attRows, function (r) { return r.name; }); if (ac && ac.err) return fail(ac.err); }
    var e = await readyRegister(p); if (e) return fail(e);
    var rows = attRows(), r = resolveNames(rows, p.names); if (r.err) return fail(r.err);
    var before = {}; r.rows.forEach(function (x) { before[x.id] = rowState(x); });
    r.rows.forEach(function (x) { setRow(x, p.status); });
    await wait(100);
    var wrong = r.rows.filter(function (x) { return rowState(x) !== p.status; });
    if (wrong.length) { r.rows.forEach(function (x) { setRow(x, before[x.id]); }); return fail('The register didn\u2019t accept the change for ' + list(wrong.map(function (x) { return x.name; }), 4) + '. I restored it.'); }
    var lines = r.rows.map(function (x) { return x.name + ': ' + ST[before[x.id]] + ' \u2192 ' + ST[p.status]; });
    lines.push('Not saved yet. Say \u201csave attendance\u201d when it is all correct.');
    return { ok: true, message: 'Marked ' + list(r.rows.map(function (x) { return x.name; }), 4) + ' as ' + p.status + '.',
      verify: { title: 'Attendance updated on screen', lines: lines, undo: snapshotUndo(r.rows, before, 'that change') } };
  });

  T[T.length - 1].describe = function (p) { return 'mark ' + list(p.names, 4) + ' as ' + p.status; };
  add('att_markall', 'mark everyone present or absent', [['mark', 'set', 'put', 'tick'], ['all', 'everyone', 'everybody', 'every learner', 'every student', 'whole class'], ['present', 'absent']], { classSection: 'attendance', risk: 'medium', confirmText: 'mark the whole register',
    parse: function (t) {
      var st = statusOf(t.split(/\b(except|but|apart from|other than|besides|excluding|without)\b/)[0]);
      if (!st) return { ask: 'Do you want everyone marked present or absent?' };
      var m = stripClass(t).match(/\b(?:except|but|apart from|other than|besides|excluding|without)\b\s+(.+)$/);
      var ex = m ? splitNames(m[1].replace(/\b(who|that|is|are|was|were|as|present|absent|learner|learners|student|students|the|please|today)\b/g, ' ')) : [];
      return { params: { status: st, except: ex } };
    } }, async function (p) {
    var modalBtn = $(p.status === 'present' ? 'tm-subatt-markall-present' : 'tm-subatt-markall-absent');
    if (modalBtn && vis(modalBtn)) {
      if (p.except && p.except.length) return fail('Exceptions aren\u2019t supported in the subject attendance form. Mark everyone, then fix individuals by name.');
      modalBtn.click();
      return { ok: true, message: 'I marked everyone ' + p.status + ' in the subject attendance form.', verify: { title: 'Subject attendance updated', lines: ['Everyone is now ' + ST[p.status] + ' in the subject form.', 'Not saved yet.'], undo: null, noLabel: 'Not right' } };
    }
    var e = await readyRegister(p); if (e) return fail(e);
    var rows = attRows(), ex = { rows: [] };
    if (p.except && p.except.length) { ex = resolveNames(rows, p.except); if (ex.err) return fail(ex.err); }
    var exIds = {}; ex.rows.forEach(function (x) { exIds[x.id] = 1; });
    var opp = p.status === 'present' ? 'absent' : 'present', before = {};
    rows.forEach(function (x) { before[x.id] = rowState(x); });
    rows.forEach(function (x) { setRow(x, exIds[x.id] ? opp : p.status); });
    await wait(150);
    var bad = rows.filter(function (x) { return rowState(x) !== (exIds[x.id] ? opp : p.status); });
    if (bad.length) { rows.forEach(function (x) { setRow(x, before[x.id]); }); return fail('The register didn\u2019t accept the change for ' + bad.length + ' learners. I restored it.'); }
    var main = rows.length - ex.rows.length, lines = [main + ' learners \u2192 ' + ST[p.status]];
    ex.rows.forEach(function (x) { lines.push(x.name + ' \u2192 ' + ST[opp] + ' (exception)'); });
    lines.push('Not saved yet. Say \u201csave attendance\u201d when it is correct.');
    return { ok: true, message: 'Marked ' + main + ' learners ' + p.status + (ex.rows.length ? ', and ' + list(ex.rows.map(function (x) { return x.name; }), 4) + ' ' + opp : '') + '.',
      verify: { title: 'Whole register updated on screen', lines: lines, undo: snapshotUndo(rows, before, 'marking the whole register') } };
  });

  T[T.length - 1].describe = function (p) { return 'mark everyone ' + p.status + (p.except && p.except.length ? ' except ' + list(p.except, 4) : ''); };
  add('att_set_termweek', 'set term and week', [['set', 'enter', 'change', 'use', 'it is', 'put'], ['term', 'week']], {
    parse: function (t) {
      var tm = t.match(/\bterm\s*(\d+)/), wk = t.match(/\bweek\s*(\d+)/);
      if (!tm && !wk) return { ask: 'Which term or week? Say, for example, \u201cset term 2 week 5\u201d.' };
      return { params: { term: tm ? 'Term ' + tm[1] : null, week: wk ? 'Week ' + wk[1] : null } };
    } }, async function (p) {
    if (!(await ensureSection('attendance'))) return fail('I couldn\u2019t open the attendance register.');
    var te = $('attendance-term'), we = $('attendance-week');
    if (!te || !we) return fail('I couldn\u2019t find the term and week boxes.');
    var oldT = te.value, oldW = we.value;
    function put(el, v) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    if (p.term) put(te, p.term); if (p.week) put(we, p.week);
    if ((p.term && te.value !== p.term) || (p.week && we.value !== p.week)) return fail('The boxes didn\u2019t accept the change.');
    return { ok: true, message: 'Term is now \u201c' + te.value + '\u201d and week is \u201c' + we.value + '\u201d.',
      verify: { title: 'Term and week set', lines: ['Term: ' + te.value, 'Week: ' + we.value], undo: async function () { put(te, oldT); put(we, oldW); return 'Undone. Term and week are back to \u201c' + oldT + '\u201d and \u201c' + oldW + '\u201d.'; } } };
  });

  T[T.length - 1].describe = function (p) { return 'set ' + [p.term, p.week].filter(Boolean).join(' and '); };
  add('att_summary', 'tell you who is present, absent or unmarked', [['how many', 'who', 'list', 'which', 'tell me', 'show me', 'count'], ['present', 'absent', 'unmarked', 'not marked', 'marked']], { classSection: 'attendance',
    parse: function (t) { return { params: { want: /\bunmarked\b|not marked/.test(t) ? 'unmarked' : /\babsent\b/.test(t) ? 'absent' : /\bpresent\b/.test(t) ? 'present' : 'all' } }; } }, async function (p) {
    var e = await readyRegister(p); if (e) return fail(e);
    var rows = attRows(), g = { present: [], absent: [], unmarked: [] };
    rows.forEach(function (r) { g[rowState(r) || 'unmarked'].push(r.name); });
    var cls = classText('attendance-class') || 'this class';
    var lines = ['Class: ' + cls, 'Present: ' + g.present.length, 'Absent: ' + g.absent.length, 'Unmarked: ' + g.unmarked.length];
    if (p.want !== 'all') lines.push(ST[p.want] + ': ' + (g[p.want].join(', ') || 'none'));
    var msg = p.want === 'all' ? 'In ' + cls + ': ' + g.present.length + ' present, ' + g.absent.length + ' absent, ' + g.unmarked.length + ' unmarked.'
      : g[p.want].length + ' learner' + (g[p.want].length === 1 ? ' is ' : 's are ') + p.want + (g[p.want].length ? ': ' + list(g[p.want], 8) : '') + '.';
    return { ok: true, message: msg, verify: { title: 'Attendance on screen', lines: lines, question: 'Is this what you asked for?', noLabel: 'Not right', undo: null } };
  });

  add('att_save', 'save attendance', [['save', 'submit', 'record'], ['attendance', 'register']], { risk: 'medium', confirmText: 'save the attendance register', alsoIf: function (t) { return currentSection() === 'attendance' && /^(?:(?:please|can you|could you)\s+)*(?:save|submit|record)(?:\s+(?:it|this|these|all|everything|now|that|the entries|entries|my entries|the register|attendance))*$/.test(t); } }, async function () {
    var e = await readyRegister({}); if (e) return fail(e);
    var cls = $('attendance-class'); if (!cls || !cls.value) return fail('Select a class first.');
    var term = ($('attendance-term') || {}).value || '', week = ($('attendance-week') || {}).value || '';
    if (!term.trim() || !week.trim()) return fail('I can\u2019t save yet: the term and week are empty. Say, for example, \u201cset term 2 week 5\u201d. Nothing was saved.');
    var rows = attRows(), marked = rows.filter(function (r) { return rowState(r); });
    if (!marked.length) return fail('No learners are marked yet, so there is nothing to save.');
    if (typeof window.saveAttendance !== 'function') return fail('Saving isn\u2019t available right now.');
    var exp = {}; marked.forEach(function (r) { exp[String(r.id).trim()] = rowState(r) === 'present'; });
    var names = {}; rows.forEach(function (r) { names[String(r.id).trim()] = r.name; });
    var unmarked = rows.length - marked.length, label = classText('attendance-class');
    try { await window.saveAttendance(); } catch (err) { return fail('Saving failed: ' + (err && err.message || 'unknown error') + '. Nothing is confirmed.'); }
    await wait(300);
    var recs; try { recs = await db('attendanceHistory'); } catch (err) { return fail('I pressed save, but I can\u2019t read storage to check it. Please verify on the history page.'); }
    var date = new Date().toISOString().split('T')[0], by = {};
    (Array.isArray(recs) ? recs : []).forEach(function (a) { if (a && a.date === date && a.classId === cls.value) by[String(a.studentId).trim()] = a; });
    var bad = Object.keys(exp).filter(function (id) { return !by[id] || !!by[id].present !== exp[id]; });
    if (bad.length) return { ok: false, message: 'I could NOT confirm the save: ' + bad.length + ' of ' + marked.length + ' records are missing or different in storage (' + list(bad.map(function (id) { return names[id] || id; }), 4) + '). Please check and try again.',
      verify: { title: 'Save not confirmed', warn: 'Do not assume this was saved.', lines: ['Checked ' + marked.length + ' marked learners against storage.', bad.length + ' did not match.'], question: 'Please review the register.', yesLabel: 'OK', noLabel: 'Close', undo: null } };
    var pc = marked.filter(function (r) { return rowState(r) === 'present'; }).length, ac = marked.length - pc;
    var lines = ['Class: ' + label, term + ', ' + week + ', ' + date, pc + ' present, ' + ac + ' absent \u2014 all checked in storage', unmarked ? unmarked + ' learners are still unmarked (not saved)' : 'Every learner was marked'];
    return { ok: true, message: 'Attendance saved and checked in storage for ' + label + ': ' + pc + ' present, ' + ac + ' absent' + (unmarked ? ', ' + unmarked + ' unmarked' : '') + '.',
      verify: { title: 'Attendance saved', lines: lines, question: 'Is this what you expected?', yesLabel: 'Yes', noLabel: 'No, wrong', undo: null } };
  });

  /* ---------------- Fees (read-only for teachers in TeachMate) ---------------- */
  async function readyFees(p) {
    if (!(await ensureSection('fees'))) return 'I couldn\u2019t open fees tracking. Are you logged in?';
    var sel = $('fees-class');
    if (p && p.classValue && sel && sel.value !== p.classValue) { if (!(await pickClass('fees-class', p))) return (p.classLabel || 'That class') + ' isn\u2019t in the class list.'; }
    if (!sel || !sel.value) return 'Which class? Say, for example, \u201cshow Grade 8 fees\u201d.';
    if (typeof window.loadFeesStudents === 'function') { try { await window.loadFeesStudents(); } catch (e) {} }
    var t0 = Date.now(); while (Date.now() - t0 < 3000 && !feeRows().length) await wait(200);
    return feeRows().length ? null : 'There are no learners with fee data for this class.';
  }
  function feeRows() {
    return [].slice.call(document.querySelectorAll('#fees-table tbody tr')).map(function (tr) {
      var c = tr.children, paid = parseFloat((c[2] ? c[2].textContent : '').replace(/[^0-9.]/g, '')) || 0, st = (c[4] ? c[4].textContent : '').toLowerCase();
      return { id: (c[0] ? c[0].textContent : '').trim(), name: (c[1] ? c[1].textContent : '').replace(/No photo/, '').trim(), paid: paid, status: st,
        overdue: tr.classList.contains('tm-fee-row-overdue'), full: /fully paid|over paid/.test(st), outstanding: /outstanding/.test(st) };
    });
  }
  function feeInfo(title, lines, msg) { return { ok: true, message: msg, verify: { title: title, lines: lines, question: 'Is this what you asked for?', yesLabel: 'Yes', noLabel: 'Not right', undo: null } }; }
  function totalText() { var e = $('fees-total-display'); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; }

  add('fees_unpaid', 'list learners who have not paid fees', [['who', 'list', 'show', 'which', 'display', 'see', 'tell me'], ['unpaid', 'not paid', 'hasn t paid', 'haven t paid', 'didn t pay', 'owe', 'owes', 'owing', 'outstanding', 'balance'], ['learners', 'students', 'pupils', 'fees', 'paid', 'pay', 'children']], { classSection: 'fees' }, async function (p) {
    var e = await readyFees(p); if (e) return fail(e);
    var rows = feeRows(), none = rows.filter(function (r) { return r.paid <= 0; }), part = rows.filter(function (r) { return !r.full && r.paid > 0; });
    var lines = ['Class: ' + classText('fees-class'), totalText(), 'Not paid at all (' + none.length + '): ' + (none.map(function (r) { return r.name; }).join(', ') || 'none'),
      'Paid partly (' + part.length + '): ' + (part.map(function (r) { return r.name + ' ' + r.paid + ' ZMW'; }).join(', ') || 'none')];
    return feeInfo('Learners who still owe fees', lines.filter(Boolean), (none.length + part.length) + ' learners still owe: ' + none.length + ' have paid nothing' + (none.length ? ' (' + list(none.map(function (r) { return r.name; }), 6) + ')' : '') + ' and ' + part.length + (part.length === 1 ? ' has' : ' have') + ' paid part.');
  });
  add('fees_counts', 'count fully paid, outstanding and not paid learners', [['how many', 'count', 'number of'], ['paid', 'fully paid', 'outstanding', 'not paid', 'unpaid', 'overdue', 'owe', 'owing'], ['learners', 'students', 'pupils', 'fees', 'have', 'has', 'had']], { classSection: 'fees' }, async function (p) {
    var e = await readyFees(p); if (e) return fail(e);
    var r = feeRows(), full = r.filter(function (x) { return x.full; }).length, out = r.filter(function (x) { return !x.full && x.paid > 0; }).length, np = r.filter(function (x) { return x.paid <= 0; }).length, od = r.filter(function (x) { return x.overdue; }).length;
    return feeInfo('Fees summary', ['Class: ' + classText('fees-class'), 'Fully paid: ' + full, 'Outstanding balance: ' + out, 'Not paid: ' + np, 'Overdue: ' + od, 'Learners: ' + r.length], 'Out of ' + r.length + ' learners: ' + full + ' fully paid, ' + out + ' with an outstanding balance, ' + np + ' not paid, ' + od + ' overdue.');
  });
  add('fees_overdue', 'list overdue fees', [['who', 'list', 'show', 'which', 'how many'], ['overdue', 'late', 'past due']], { classSection: 'fees' }, async function (p) {
    var e = await readyFees(p); if (e) return fail(e);
    var o = feeRows().filter(function (x) { return x.overdue; });
    return feeInfo('Overdue fees', ['Class: ' + classText('fees-class'), 'Overdue (' + o.length + '): ' + (o.map(function (x) { return x.name; }).join(', ') || 'none')], o.length ? o.length + ' learners are overdue: ' + list(o.map(function (x) { return x.name; }), 6) + '.' : 'No learners are overdue in this class.');
  });
  add('fees_total', 'tell you the class fee total', [['what', 'how much', 'show', 'tell me', 'check'], ['total fees', 'total fee', 'fee amount', 'total amount', 'fees amount', 'fee total']], { classSection: 'fees' }, async function (p) {
    var e = await readyFees(p); if (e) return fail(e);
    var t = totalText(); return feeInfo('Class fee total', ['Class: ' + classText('fees-class'), t], t || 'The total fee has not been set for this class.');
  });
  var FEE_STOP = /\b(how|much|has|have|had|did|does|do|paid|pay|paying|balance|owe|owes|owing|fees|fee|what|check|tell|me|for|by|is|of|the|learner|student|pupil|s|zmw|whats|show|status|many|kwacha|in|grade|class|form)\b/g;
  add('fees_learner', 'check one learner\u2019s fees', [['how much', 'what', 'check', 'tell me', 'show'], ['paid', 'pay', 'balance', 'owe', 'owes', 'fees', 'fee status'], ['has', 'have', 'did', 'does', 'for', 'by', 'is', 'of']], { classSection: 'fees',
    parse: function (t) {
      var nm = stripClass(t).replace(/\d+/g, ' ').replace(FEE_STOP, ' ').replace(/\s+/g, ' ').trim();
      if (!nm) return { ask: 'Whose fees? Say, for example, \u201chow much has Peter Banda paid\u201d.' };
      return { params: { name: nm } };
    } }, async function (p) {
    var e = await readyFees(p); if (e) return fail(e);
    var pk = pickByName(feeRows(), p.name, function (x) { return x.name; });
    if (pk.many) return fail('More than one learner sounds like that: ' + list(pk.many.map(function (r) { return r.name; }), 5) + '. Please use the full name.');
    if (!pk.hit) return fail('I couldn\u2019t find \u201c' + p.name + '\u201d in this class.' + (pk.near.length ? ' Did you mean ' + list(pk.near.map(function (r) { return r.name; }), 3) + '? Please ask again with the right name.' : ''));
    var hit = pk.hit;
    var r = hit[0], st = r.full ? 'fully paid' : r.paid > 0 ? 'has an outstanding balance' : 'has not paid';
    return feeInfo('Fees for ' + r.name, ['Paid: ' + r.paid + ' ZMW', 'Status: ' + st + (r.overdue ? ' (overdue)' : ''), totalText()].filter(Boolean), r.name + ' has paid ' + r.paid + ' ZMW and ' + st + '.');
  });
  add('fees_history', 'view fees history', [OPEN.concat(['check']), ['fees', 'payments'], ['history', 'records', 'past', 'previous']], { classSection: 'fees',
    parse: function (t) { var m = t.match(/\b(?:student |learner )?id\s*([a-z0-9-]+)/); return { params: { sid: m ? m[1] : '' } }; } }, async function (p) {
    if (!(await ensureSection('fees'))) return fail('I couldn\u2019t open fees.');
    var cv = p.classValue || ($('fees-class') || {}).value;
    if (!cv) return fail('Which class? Say, for example, \u201cshow Grade 8 fees history\u201d.');
    var hs = $('fees-history-class'), si = $('fees-search-student-id');
    if (!hs || typeof window.viewFeesHistory !== 'function') return fail('Fees history isn\u2019t available.');
    hs.value = cv; if (hs.value !== cv) return fail('That class isn\u2019t in the history list.');
    if (si) si.value = p.sid || '';
    await window.viewFeesHistory(); await wait(200);
    var h = $('fees-history'), has = h && h.querySelector('table');
    return feeInfo('Fees history', ['Class: ' + (p.classLabel || classText('fees-class')), p.sid ? 'Learner ID: ' + p.sid : 'All learners', has ? 'The history table is now showing.' : 'No fee records were found.'],
      has ? 'The fees history is now showing on screen.' : 'There are no fee records for that selection.');
  });
  add('fees_record', 'record a fee payment', [['record', 'save', 'add', 'enter', 'update', 'change', 'edit', 'mark'], ['fees', 'fee', 'payment', 'payments']], {}, async function () {
    return fail('Fees are read-only for teachers in TeachMate: payments are recorded by the school administrator, so I can\u2019t record or change them by voice. I can show who has paid, who owes, and the fees history.');
  });

  function currentSection() {
    var ids = ['attendance', 'results', 'fees', 'messages', 'class-management'];
    for (var i = 0; i < ids.length; i++) if (sectionOpen(ids[i])) return ids[i];
    return null;
  }
  var EXT = { vis: vis, add: add, ensureSection: ensureSection, wait: wait, fail: fail, list: list, classText: classText, pickClass: pickClass,
              pickByName: pickByName, rankNames: rankNames, press: press, db: db, $: $, sectionOpen: sectionOpen, LABEL: LABEL, OPEN: OPEN };
  window.TeachMateVoiceActions = { ext: EXT, currentSection: currentSection, TASKS: T, norm: norm, matchClass: matchClass, CLASS_SEL: CLASS_SEL };
})();
