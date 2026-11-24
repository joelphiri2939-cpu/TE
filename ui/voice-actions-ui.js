/* ui/voice-actions-ui.js — (1) the full RESULTS feature by voice (fields, marks, summaries, save with storage check,
 * report cards for a class or a single learner) and (2) a GENERAL operator that can press any visible button, fill any
 * visible field and tick any box on ANY screen by its on-screen label, so every feature of TeachMate is reachable.
 * Rule kept everywhere: changes are read back in a pop-up and can be undone; risky buttons need a spoken "yes" first. */
(function () {
  'use strict';
  var A = window.TeachMateVoiceActions, M = window.TeachMateVoiceMatch;
  if (!A || !A.ext || !M) { console.error('[voice-actions-ui] load voice-match.js and voice-actions.js first'); return; }
  var E = A.ext, norm = A.norm, $ = E.$, wait = E.wait, fail = E.fail, add = E.add, list = E.list;
  function cap(s) { return String(s).replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }
  function strip(t) { return t.replace(/^(?:(?:please|teachmate|can you|could you|would you|kindly)\s+)+/, '').trim(); }

  /* ================= shared helpers ================= */
  function setVal(el, v) {
    try {
      var proto = el.tagName === 'SELECT' ? window.HTMLSelectElement : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      var d = proto && Object.getOwnPropertyDescriptor(proto.prototype, 'value');
      if (d && d.set) d.set.call(el, v); else el.value = v;
    } catch (e) { el.value = v; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function phrase(spoken, label) {                          // how well a spoken phrase fits an on-screen label (spelling + sound)
    var S = spoken.split(' ').filter(Boolean), L = label.split(' ').filter(Boolean);
    if (!S.length || !L.length) return 0;
    var tot = 0, cov = 0;
    S.forEach(function (w) { var b = 0; L.forEach(function (v) { var x = M.tsim(w, v); if (x > b) b = x; }); tot += b; });
    L.forEach(function (v) { var b = 0; S.forEach(function (w) { var x = M.tsim(w, v); if (x > b) b = x; }); if (b >= 0.8) cov++; });
    return (tot / S.length) * 0.75 + 0.25 * (cov / L.length);
  }
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parseDate(t) {
    var d = new Date();
    if (/\btoday\b/.test(t)) return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (/\byesterday\b/.test(t)) { d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    if (/\btomorrow\b/.test(t)) { d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    var mi = -1, i; MONTHS.forEach(function (m, k) { if (new RegExp('\\b' + m.slice(0, 3) + '[a-z]*\\b').test(t)) mi = k; });
    var dm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/), ym = t.match(/\b(20\d\d)\b/);
    if (mi > -1 && dm) return (ym ? ym[1] : String(new Date().getFullYear())) + '-' + pad(mi + 1) + '-' + pad(+dm[1]);
    return null;
  }

  /* ================= RESULTS ================= */
  function resRows() {
    return [].slice.call(document.querySelectorAll('#results-table tbody tr')).map(function (tr) {
      var inp = tr.querySelector('.result-input');
      return inp ? { tr: tr, inp: inp, id: (inp.dataset.id || '').trim(), name: ((tr.children[1] || {}).textContent || '').replace(/No photo/i, '').trim() } : null;
    }).filter(Boolean);
  }
  async function readyResults(p, needRows) {
    if (!(await E.ensureSection('results'))) return 'I couldn\u2019t open results tracking. Are you logged in?';
    var sel = $('results-class'), changed = false;
    if (p && p.classValue && sel && sel.value !== p.classValue) {
      if (!(await E.pickClass('results-class', p))) return (p.classLabel || 'That class') + ' isn\u2019t in the class list.';
      changed = true;
    }
    if (!sel || !sel.value) return 'Which class? Say, for example, \u201copen Grade 8 results\u201d.';
    if (needRows && (changed || !resRows().length)) {
      if (typeof window.loadResultsStudents === 'function') { try { await window.loadResultsStudents(); } catch (e) {} }
      var t0 = Date.now(); while (Date.now() - t0 < 4000 && !resRows().length) await wait(200);
    }
    if (needRows && !resRows().length) return 'There are no learners loaded for this class.';
    return null;
  }

  /* ---- result form fields: subject, test name, category, level, date ---- */
  var RF = { 'subject': 'subject', 'test name': 'test-name', 'test': 'test-name', 'category': 'test-category', 'level': 'results-level', 'date': 'test-date', 'test date': 'test-date' };
  function chooseOption(sel, spoken) {
    var best = null, bs = 0;
    [].slice.call(sel.options).forEach(function (o) {
      if (!o.value) return;
      var s = Math.max(phrase(spoken, norm(o.text)), phrase(spoken, norm(o.value)));
      if (s > bs) { bs = s; best = o; }
    });
    return bs >= 0.78 ? best : null;
  }
  function describeField(el) { return el.id; }
  add('res_set_fields', 'set the results details', [['set', 'change', 'enter', 'select', 'choose', 'put'], ['subject', 'test name', 'category', 'level', 'date', 'test date']], {
    parse: function (t) {
      t = strip(t); var re = /\b(test name|test date|subject|category|level|date)\b/g, m, marks = [];
      while ((m = re.exec(t))) marks.push({ k: m[1], at: m.index, end: re.lastIndex });
      if (!marks.length) return { ask: 'Which detail: subject, test name, category, level or date?' };
      var out = [];
      for (var i = 0; i < marks.length; i++) {
        var raw = t.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : undefined).replace(/^\s*(?:to|as|is|equals?)\s+/, '').replace(/\s+(?:and|then)\s*$/, '').trim();
        if (!raw) return { ask: 'What should the ' + marks[i].k + ' be?' };
        out.push({ field: RF[marks[i].k], key: marks[i].k, value: raw });
      }
      return { params: { sets: out } };
    },
    describe: function (p) { return 'set ' + list(p.sets.map(function (x) { return x.key + ' to ' + x.value; }), 4); }
  }, async function (p) {
    var e = await readyResults(p, false); if (e) return fail(e);
    var done = [], undo = [];
    for (var i = 0; i < p.sets.length; i++) {
      var s = p.sets[i], el = $(s.field);
      if (!el) { undo.forEach(function (u) { u(); }); return fail('I couldn\u2019t find the ' + s.key + ' box. Nothing was changed.'); }
      var old = el.value, v;
      if (el.tagName === 'SELECT') {
        var o = chooseOption(el, s.value);
        if (!o) { undo.forEach(function (u) { u(); }); return fail('I couldn\u2019t match \u201c' + s.value + '\u201d to the ' + s.key + ' choices: ' + list([].slice.call(el.options).filter(function (x) { return x.value; }).map(function (x) { return x.text; }), 6) + '. Nothing was changed.'); }
        v = o.value;
      } else if (s.field === 'test-date') {
        v = parseDate(s.value);
        if (!v) { undo.forEach(function (u) { u(); }); return fail('I couldn\u2019t understand the date \u201c' + s.value + '\u201d. Say, for example, \u201ctoday\u201d or \u201c23 November\u201d. Nothing was changed.'); }
      } else v = cap(s.value);
      setVal(el, v);
      if (String(el.value) !== String(v)) { undo.forEach(function (u) { u(); }); return fail('The ' + s.key + ' box didn\u2019t accept that. Nothing was changed.'); }
      undo.push((function (el, old) { return function () { setVal(el, old); }; })(el, old));
      done.push(cap(s.key) + ': ' + (el.tagName === 'SELECT' ? el.options[el.selectedIndex].text : v) + (old ? ' (was ' + old + ')' : ''));
    }
    return { ok: true, message: 'Done. ' + done.join('. ') + '.', verify: { title: 'Results details set', lines: done, undo: async function () { undo.forEach(function (u) { u(); }); return 'Undone. The results details are back to how they were.'; } } };
  });

  /* ---- entering marks by name ---- */
  var FILL = /^(enter|record|put|give|add|write|type|mark|marks|score|scores|scored|got|gets|get|has|had|is|was|for|to|on|with|percent|out|of|the|learner|student|pupil|please|points|point|teachmate)$/;
  function parseMarks(t) {
    var toks = strip(t).replace(/\b(grade|class|form)\s*\d+\s*[a-z]?\b/g, ' ').split(' ').filter(Boolean), pairs = [], i;
    var isNum = function (w) { return /^\d+(\.\d+)?$/.test(w); };
    var firstMeaningful = toks.filter(function (w) { return !FILL.test(w); })[0];
    var numberFirst = firstMeaningful && isNum(firstMeaningful);
    var cur = { name: [], num: null };
    function flush() { if (cur.num !== null && cur.name.length) pairs.push({ name: cur.name.join(' '), score: parseFloat(cur.num) }); cur = { name: [], num: null }; }
    toks.forEach(function (w) {
      if (w === 'and') { if (!numberFirst) flush(); return; }
      if (isNum(w)) {
        if (numberFirst) { if (cur.num !== null) flush(); cur.num = w; } else { cur.num = w; flush(); }
        return;
      }
      if (FILL.test(w)) return;
      cur.name.push(w);
    });
    flush();
    return pairs;
  }
  add('res_enter_marks', 'enter marks for learners', [['enter', 'record', 'put', 'give', 'write', 'add', 'type', 'score', 'scored', 'got', 'gets'], ['marks', 'mark', 'score', 'scored', 'got', 'gets', 'for', 'percent', 'points']], {
    classSection: 'results',
    alsoIf: function (t) { return /\b(enter|record|put|give|add|write|score|scored|got|gets)\b/.test(t) && /\b\d+(\.\d+)?\b/.test(t) && !/\b(in|into|on)\s+(?:the\s+)?[a-z ]*\b(name|field|box|school|teacher|phone|subject|category|level|date|term|week)\b/.test(t) && !/\b(present|absent)\b/.test(t); },
    parse: function (t) {
      var pairs = parseMarks(t);
      if (!pairs.length) return { ask: 'Which learner and which mark? Say, for example, \u201center 45 for Peter Banda\u201d.' };
      var bad = pairs.filter(function (x) { return !(x.score >= 0 && x.score <= 100); })[0];
      if (bad) return { ask: 'Marks must be between 0 and 100, but I heard ' + bad.score + ' for ' + bad.name + '. Please say it again.' };
      return { params: { pairs: pairs } };
    },
    describe: function (p) { return 'enter ' + list(p.pairs.map(function (x) { return x.score + ' for ' + x.name; }), 4); }
  }, async function (p) {
    if (E.autoClass) { var ac = await E.autoClass(p, p.pairs.map(function (x) { return x.name; }), resRows, function (x) { return x.name; }); if (ac && ac.err) return fail(ac.err); }
    var e = await readyResults(p, true); if (e) return fail(e);
    var rows = resRows(), picked = [], seen = {};
    for (var i = 0; i < p.pairs.length; i++) {
      var r = E.pickByName(rows, p.pairs[i].name, function (x) { return x.name; });
      if (r.many) return fail('More than one learner sounds like \u201c' + p.pairs[i].name + '\u201d: ' + list(r.many.map(function (x) { return x.name; }), 5) + '. Please use the full name. Nothing was changed.');
      if (!r.hit) return fail('I couldn\u2019t find \u201c' + p.pairs[i].name + '\u201d in this class.' + (r.near.length ? ' Did you mean ' + list(r.near.map(function (x) { return x.name; }), 3) + '?' : '') + ' Nothing was changed.');
      if (seen[r.hit[0].id]) return fail('I heard ' + r.hit[0].name + ' twice. Please say it again. Nothing was changed.');
      seen[r.hit[0].id] = 1; picked.push({ row: r.hit[0], score: p.pairs[i].score });
    }
    var old = {}; picked.forEach(function (x) { old[x.row.id] = x.row.inp.value; });
    picked.forEach(function (x) { setVal(x.row.inp, String(x.score)); });
    await wait(80);
    var bad = picked.filter(function (x) { return parseFloat(x.row.inp.value) !== x.score; });
    if (bad.length) { picked.forEach(function (x) { setVal(x.row.inp, old[x.row.id]); }); return fail('The mark box didn\u2019t accept the value for ' + list(bad.map(function (x) { return x.row.name; }), 3) + '. I restored it.'); }
    var lines = picked.map(function (x) { return x.row.name + ': ' + (old[x.row.id] === '' ? 'empty' : old[x.row.id]) + ' \u2192 ' + x.score; });
    lines.push('Not saved yet. Say \u201csave results\u201d when all marks are correct.');
    return { ok: true, message: 'Entered ' + list(picked.map(function (x) { return x.score + ' for ' + x.row.name; }), 4) + '.',
      verify: { title: 'Marks entered on screen', lines: lines, undo: async function () { picked.forEach(function (x) { setVal(x.row.inp, old[x.row.id]); }); return 'Undone. Those marks are back to how they were. Nothing was saved.'; } } };
  });

  /* ---- read-only summaries ---- */
  add('res_summary', 'tell you the class average, highest, lowest or missing marks', [['what', 'who', 'how many', 'list', 'tell me', 'show me', 'which', 'read'], ['average', 'mean', 'highest', 'lowest', 'top', 'best', 'worst', 'bottom', 'no marks', 'without marks', 'missing marks', 'marks entered', 'not entered']], {
    classSection: 'results',
    parse: function (t) { return { params: { want: /\b(average|mean)\b/.test(t) ? 'avg' : /\b(highest|top|best)\b/.test(t) ? 'high' : /\b(lowest|worst|bottom)\b/.test(t) ? 'low' : /\b(no marks|without|missing|not entered|empty|yet)\b/.test(t) ? 'missing' : 'all' } }; }
  }, async function (p) {
    var e = await readyResults(p, true); if (e) return fail(e);
    var rows = resRows(), got = rows.filter(function (r) { return r.inp.value !== '' && !isNaN(parseFloat(r.inp.value)); }).map(function (r) { return { n: r.name, v: parseFloat(r.inp.value) }; });
    var miss = rows.filter(function (r) { return r.inp.value === ''; }).map(function (r) { return r.name; });
    var sum = got.reduce(function (a, x) { return a + x.v; }, 0), avg = got.length ? Math.round(sum / got.length * 100) / 100 : 0;
    got.sort(function (a, b) { return b.v - a.v; });
    var cls = E.classText('results-class') || 'this class', lines = ['Class: ' + cls, 'Marks entered: ' + got.length + ' of ' + rows.length, got.length ? 'Average: ' + avg : 'No marks entered yet'], msg;
    if (!got.length && p.want !== 'missing') msg = 'No marks have been entered yet for ' + cls + '.';
    else if (p.want === 'avg') msg = 'The class average is ' + avg + ' from ' + got.length + ' marks.';
    else if (p.want === 'high') { msg = got[0].n + ' has the highest mark, ' + got[0].v + '.'; lines.push('Highest: ' + got[0].n + ' ' + got[0].v); }
    else if (p.want === 'low') { var lo = got[got.length - 1]; msg = lo.n + ' has the lowest mark, ' + lo.v + '.'; lines.push('Lowest: ' + lo.n + ' ' + lo.v); }
    else if (p.want === 'missing') { msg = miss.length ? miss.length + ' learner' + (miss.length === 1 ? ' has' : 's have') + ' no mark yet: ' + list(miss, 8) + '.' : 'Every learner has a mark.'; lines.push('No mark: ' + (miss.join(', ') || 'none')); }
    else { msg = got.length + ' of ' + rows.length + ' marks entered, class average ' + avg + (got.length ? ', highest ' + got[0].n + ' ' + got[0].v : '') + '.'; }
    return { ok: true, message: msg, verify: { title: 'Marks on screen', lines: lines, question: 'Is this what you asked for?', noLabel: 'Not right', undo: null } };
  });

  /* ---- save results, then check storage ---- */
  add('res_save', 'save results', [['save', 'submit', 'record'], ['results', 'marks']], { risk: 'medium', confirmText: 'save the results' }, async function () {
    var e = await readyResults({}, false); if (e) return fail(e);
    var cls = $('results-class').value.trim(), subject = ($('subject') || {}).value || '', testName = ($('test-name') || {}).value || '',
        category = ($('test-category') || {}).value || '', level = ($('results-level') || {}).value || '';
    var missing = []; if (!subject.trim()) missing.push('subject'); if (!testName.trim()) missing.push('test name'); if (!category) missing.push('category'); if (!level) missing.push('level');
    if (missing.length) return fail('I can\u2019t save yet: the ' + list(missing, 4) + (missing.length > 1 ? ' are' : ' is') + ' empty. Say, for example, \u201cset subject to Mathematics\u201d. Nothing was saved.');
    var rows = resRows(), exp = {};
    rows.forEach(function (r) { if (r.inp.value !== '' && !isNaN(parseFloat(r.inp.value))) exp[r.id] = Math.round(parseFloat(r.inp.value) * 100) / 100; });
    var ids = Object.keys(exp); if (!ids.length) return fail('No marks are entered yet, so there is nothing to save.');
    var names = {}; rows.forEach(function (r) { names[r.id] = r.name; });
    if (typeof window.saveResults !== 'function') return fail('Saving results isn\u2019t available right now.');
    var t0 = Date.now();
    try { await window.saveResults(); } catch (err) { return fail('Saving failed: ' + (err && err.message || 'unknown error') + '. Nothing is confirmed.'); }
    await wait(300);
    var recs; try { recs = await E.db('results'); } catch (err) { return fail('I pressed save but I can\u2019t read storage to check it. Please verify in the history page.'); }
    var mine = (Array.isArray(recs) ? recs : []).filter(function (r) { return r && r.classId === cls && r.subject === subject.trim() && r.testName === testName.trim() && r.category === category; })
      .sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    var rec = mine[0], bad = rec ? ids.filter(function (id) { return !rec.scores || Number(rec.scores[id]) !== exp[id]; }) : ids;
    if (!rec || bad.length) return { ok: false, message: 'I could NOT confirm the save: ' + (rec ? bad.length + ' of ' + ids.length + ' marks differ in storage (' + list(bad.map(function (id) { return names[id] || id; }), 4) + ')' : 'no matching record was found in storage') + '. Please check the screen and try again.',
      verify: { title: 'Save not confirmed', warn: 'Do not assume the results were saved.', lines: ['Checked ' + ids.length + ' marks against storage.'], question: 'Please review the page.', yesLabel: 'OK', noLabel: 'Close', undo: null } };
    var lines = ['Class: ' + E.classText('results-class'), subject + ' \u2014 ' + testName + ' (' + category + ', ' + level + ')', ids.length + ' marks saved and checked in storage', (rows.length - ids.length) ? (rows.length - ids.length) + ' learners have no mark (not saved)' : 'Every learner has a mark'];
    return { ok: true, message: 'Results saved and checked in storage: ' + ids.length + ' marks for ' + subject + ', ' + testName + '.',
      verify: { title: 'Results saved', lines: lines, question: 'Is this what you expected?', yesLabel: 'Yes', noLabel: 'No, wrong', undo: null } };
  });

  /* ---- report cards: whole class or one learner, then "generate" ---- */
  var NOISE = /^(for|of|the|whole|all|entire|class|learners|students|pupils|every|everyone|everybody|bulk|please|each|and|cards|card|report|reports|generate|create|make|print|prepare|produce|open|pdf|a|my)$/;
  function extractOption(toks, texts) {
    var best = null, bs = 0, bi = 0, bn = 0;
    for (var n = 4; n >= 1; n--) for (var i = 0; i + n <= toks.length; i++) {
      var ph = toks.slice(i, i + n).join(' ');
      texts.forEach(function (tx) { var s = phrase(ph, norm(tx)); if (s > bs + 0.0001 && s >= 0.9) { bs = s; best = tx; bi = i; bn = n; } });
    }
    if (best === null) return { opt: null, toks: toks };
    return { opt: best, toks: toks.slice(0, bi).concat(toks.slice(bi + bn)) };
  }
  function optTexts(id) { var s = $(id); return s ? [].slice.call(s.options).filter(function (o) { return o.value && o.value !== 'All'; }).map(function (o) { return o.text; }) : []; }
  function visible(id) { var e = $(id); return !!e && e.offsetParent !== null; }
  add('res_reportcards', 'open the report card form', [['generate', 'create', 'make', 'print', 'prepare', 'produce', 'open'], ['report cards', 'report card', 'reports', 'report']], {
    classSection: 'results',
    parse: function (t) { return { params: { rest: strip(t).replace(/\b(grade|class|form)\s*\d+\s*[a-z]?\b/g, ' ') } }; },
    describe: function (p) { return 'open the report card form'; }
  }, async function (p) {
    var e = await readyResults(p, true); if (e) return fail(e);
    var toks = (p.rest || '').split(' ').filter(Boolean);
    var cat = extractOption(toks, optTexts('test-category')); toks = cat.toks;
    var lvl = extractOption(toks, ['Primary', 'Junior Secondary', 'Senior Secondary']); toks = lvl.toks;
    var nameToks = toks.filter(function (w) { return !NOISE.test(w); });
    var cf = $('results-category-filter'), lf = $('results-level-filter') || $('results-level');
    if (cat.opt && cf) { var co = chooseOption(cf, cat.opt); if (co) setVal(cf, co.value); }
    if (lvl.opt && lf) { var lo = chooseOption(lf, lvl.opt); if (lo) setVal(lf, lo.value); }
    var cls = E.classText('results-class');
    if (nameToks.length) {                                           // ----- one learner
      if (E.autoClass) {
        var ac = await E.autoClass(p, [nameToks.join(' ')], resRows, function (x) { return x.name; }); if (ac && ac.err) return fail(ac.err);
        if (p.classValue && $('results-class').value !== p.classValue) { var e2 = await readyResults(p, true); if (e2) return fail(e2); cls = E.classText('results-class'); }
      }
      var rows = resRows(), r = E.pickByName(rows, nameToks.join(' '), function (x) { return x.name; });
      if (r.many) return fail('More than one learner sounds like \u201c' + nameToks.join(' ') + '\u201d: ' + list(r.many.map(function (x) { return x.name; }), 5) + '. Please use the full name.');
      if (!r.hit) return fail('I couldn\u2019t find \u201c' + nameToks.join(' ') + '\u201d in ' + cls + '.' + (r.near.length ? ' Did you mean ' + list(r.near.map(function (x) { return x.name; }), 3) + '?' : ''));
      var sid = $('results-search-student-id'); if (!sid || typeof window.openIndividualStudentPDFForm !== 'function') return fail('The single report card form isn\u2019t available.');
      setVal(sid, r.hit[0].id);
      window.openIndividualStudentPDFForm();                        // may show TeachMate\u2019s own "pre-fill from history?" box first
      var t1 = Date.now(); while (Date.now() - t1 < 8000 && !visible('generate-pdf-btn')) await wait(250);
      if (!visible('generate-pdf-btn')) return fail('The report card form for ' + r.hit[0].name + ' didn\u2019t open. Please check the screen.');
      return { ok: true, message: 'The report card form for ' + r.hit[0].name + ' is open. Check it, then say \u201cgenerate\u201d to create the PDF, or \u201ccancel the form\u201d.' };
    }
    if (typeof window.openBulkReportCardForm !== 'function') return fail('The class report card form isn\u2019t available.');   // ----- whole class
    window.openBulkReportCardForm();
    var t2 = Date.now(); while (Date.now() - t2 < 6000 && !visible('start-bulk-generate-btn')) await wait(250);
    if (!visible('start-bulk-generate-btn')) return fail('The class report card form didn\u2019t open. Please select a class with learners and try again.');
    var bc = $('bulk-pdf-category'), bl = $('bulk-pdf-level');
    if (cat.opt && bc) { var bo = chooseOption(bc, cat.opt); if (bo) setVal(bc, bo.value); }
    if (lvl.opt && bl) { var blo = chooseOption(bl, lvl.opt); if (blo) setVal(bl, blo.value); }
    var count = (($('start-bulk-generate-btn') || {}).textContent || '').match(/\((\d+)\)/);
    return { ok: true, message: 'The class report card form is open for ' + cls + (count ? ', ' + count[1] + ' learners' : '') + ', category ' + (bc && bc.options[bc.selectedIndex] ? bc.options[bc.selectedIndex].text : 'all') + '. Check it, then say \u201cgenerate\u201d to start, or \u201ccancel the form\u201d.' };
  });

  add('form_generate', 'generate the report cards now', [['generate', 'generate now', 'start generating', 'go ahead and generate', 'generate it', 'generate them', 'generate the pdf', 'generate pdf', 'start the generation']], { risk: 'medium', confirmText: 'start generating the report cards' }, async function () {
    var id = visible('start-bulk-generate-btn') ? 'start-bulk-generate-btn' : visible('generate-pdf-btn') ? 'generate-pdf-btn' : null;
    if (!id) return fail('No report card form is open. Say, for example, \u201cgenerate report cards for the whole class\u201d first.');
    if (id === 'start-bulk-generate-btn' && !((($('bulk-pdf-school') || {}).value || '').trim())) return fail('The form needs the school name first. Say, for example, \u201center Muchinga Secondary in school name\u201d.');
    if (id === 'generate-pdf-btn' && !((($('pdf-school') || {}).value || '').trim())) return fail('The form needs the school name first. Say, for example, \u201center Muchinga Secondary in school name\u201d.');
    $(id).click(); await wait(400);
    return { ok: true, message: 'I started generating. Your phone may ask permission to download several files. Please check your downloads.',
      verify: { title: 'Report cards started', lines: ['I pressed generate on the open form.', 'Allow downloads if your browser asks.', 'I cannot see the downloaded files myself.'], question: 'Did the report cards download correctly?', yesLabel: 'Yes', noLabel: 'No', undo: null } };
  });
  add('form_cancel', 'close the open form', [['cancel', 'close', 'dismiss', 'exit'], ['form', 'this form', 'the form', 'window', 'dialog', 'pop up', 'popup']], {}, async function () {
    var ids = ['close-bulk-pdf-form', 'close-bulk-pdf-form-x', 'close-pdf-form-x'];
    for (var i = 0; i < ids.length; i++) if (visible(ids[i])) { $(ids[i]).click(); return { ok: true, message: 'I closed the form.' }; }
    return fail('I can\u2019t see an open form to close.');
  });

  /* ================= GENERAL OPERATOR: any button / field on any screen ================= */
  function isOurs(el) { return !!(el.closest && el.closest('#tmv-root,#tmv-fab,#tmv-toast,#tmvv,.tm-speech-mic,#tm-speech-status,[id^="tm-tts"]')); }
  function vis(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    var cs = window.getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && (el.offsetParent !== null || cs.position === 'fixed');
  }
  function activeRoot() {                                              // the pop-up or page the user is looking at
    var kids = [].slice.call(document.body.children).reverse();
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i]; if (isOurs(k) || !k.getBoundingClientRect) continue;
      var cs = window.getComputedStyle(k);
      if (cs.position === 'fixed' && vis(k)) { var r = k.getBoundingClientRect(); if (r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.5 && k.querySelector('button,input,select,textarea')) return k; }
    }
    return document.body;
  }
  function labelText(s) { return norm(String(s || '')); }
  function idWords(id) { return labelText(String(id || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/\b(btn|button|input|field|el)\b/gi, ' ')); }
  function btnLabels(b) { return [labelText(b.innerText || b.textContent), labelText(b.getAttribute && b.getAttribute('aria-label')), labelText(b.title), labelText(b.value)].filter(Boolean).concat([idWords(b.id)].filter(Boolean)); }
  function fieldLabels(f) {
    var L = [], lb;
    try { if (f.id && window.CSS && CSS.escape) { lb = document.querySelector('label[for="' + CSS.escape(f.id) + '"]'); if (lb) L.push(lb.textContent); } } catch (e) {}
    var pl = f.closest && f.closest('label'); if (pl) L.push(pl.textContent);
    var par = f.parentElement; if (par) { var l2 = par.querySelector('label'); if (l2 && !l2.contains(f)) L.push(l2.textContent); }
    L.push(f.getAttribute('aria-label') || '', f.placeholder || '', f.title || '', String(f.name || '').replace(/[-_]+/g, ' '), idWords(f.id));
    return L.map(labelText).filter(Boolean);
  }
  var JUNK = /\b(the|button|field|box|option|please|on|in|into|for)\b/g;
  function rankBy(spoken, els, labelsOf, root) {
    var s = norm(spoken).replace(JUNK, ' ').replace(/\s+/g, ' ').trim(); if (!s) return [];
    return els.map(function (el) {
      var best = 0; labelsOf(el).forEach(function (l, i) { var x = phrase(s, l) * (i >= 4 && l === idWords(el.id) ? 0.92 : 1); if (x > best) best = x; });
      if (root && root.contains && root.contains(el) && root !== document.body) best += 0.06;
      return { el: el, score: best, label: (labelsOf(el)[0] || el.id || '').trim() };
    }).filter(function (x) { return x.score > 0.45; }).sort(function (a, b) { return b.score - a.score; });
  }
  function controls(sel) { var root = activeRoot(); return { root: root, els: [].slice.call(document.querySelectorAll(sel)).filter(function (e) { return !isOurs(e) && vis(e); }) }; }
  var BTN = 'button,[role="button"],a.btn,input[type="button"],input[type="submit"]';
  var HIGH = /\b(delete|remove|erase|clear|reset|wipe|destroy|log ?out|sign ?out|discard)\b/, MED = /\b(save|submit|send|publish|generate|add|create|update|import|upload|pay|record|mark|confirm|approve|bulk|sms|apply|post|finish|done|export|download)\b/;
  function riskOf(label) { return HIGH.test(label) ? 'high' : MED.test(label) ? 'medium' : 'low'; }
  function niceLabel(b) { return (b.innerText || b.textContent || b.value || b.getAttribute('aria-label') || b.title || b.id || 'that button').replace(/\s+/g, ' ').trim().slice(0, 60); }
  function findButtons(spoken) { var c = controls(BTN); return rankBy(spoken, c.els, btnLabels, c.root); }

  A.uiGuess = function (t) { var r = findButtons(t); return r.length ? r[0] : null; };

  add('ui_press', 'press a button on the screen', [['press', 'tap', 'click', 'push', 'hit', 'touch']], {
    parse: function (t, strict) {
      var s = strip(t), hasVerb = /^(press|tap|click|push|hit|touch)\b/.test(s);
      var label = s.replace(/^(press|tap|click|push|hit|touch)\s+(?:on\s+)?/, '');
      var r = findButtons(label);
      if (!r.length || r[0].score < (strict ? 0.9 : 0.72)) return { ask: hasVerb && !strict ? 'I couldn\u2019t find a button called \u201c' + label + '\u201d on this screen. Say \u201cwhat can I press\u201d to hear the buttons.' : REPEAT_NONE };
      if (!strict && r[1] && r[1].score > r[0].score - 0.05 && r[1].label !== r[0].label) return { ask: 'There are two buttons like that: \u201c' + r[0].label + '\u201d and \u201c' + r[1].label + '\u201d. Say press and the full name.' };
      var nl = niceLabel(r[0].el), risk = riskOf(norm(nl));
      return { params: { el: r[0].el, label: nl, score: r[0].score, risk: risk, confirmText: 'press \u201c' + nl + '\u201d' } };
    },
    describe: function (p) { return 'press \u201c' + p.label + '\u201d'; }
  }, async function (p) {
    var el = p.el;
    if (!el || !el.isConnected || !vis(el)) { var r = findButtons(p.label); el = r[0] && r[0].score >= 0.9 ? r[0].el : null; }
    if (!el) return fail('That button is no longer on the screen.');
    if (el.disabled) return fail('\u201c' + p.label + '\u201d is disabled right now.');
    el.click(); await wait(300);
    var res = { ok: true, message: 'I pressed \u201c' + p.label + '\u201d.' };
    if (p.risk !== 'low') res.verify = { title: 'Button pressed', lines: ['I pressed \u201c' + p.label + '\u201d.', 'Check the screen for the result.'], question: 'Did that do what you expected?', yesLabel: 'Yes', noLabel: 'No', undo: null };
    return res;
  });
  var REPEAT_NONE = '\u0000none';

  function findFields(spoken, filter) {
    var c = controls('input:not([type=hidden]):not([type=file]):not([type=button]):not([type=submit]),select,textarea');
    return rankBy(spoken, c.els.filter(filter || function () { return true; }), fieldLabels, c.root);
  }
  add('ui_set', 'fill in or choose a value in a field', [['set', 'change', 'select', 'choose', 'pick', 'enter', 'type', 'put', 'fill', 'write']], {
    parse: function (t) {
      var s = strip(t), m;
      if ((m = s.match(/^(?:set|change|select|choose|pick|make|fill|update)\s+(?:the\s+)?(.+?)\s+(?:to|as|equals?)\s+(.+)$/))) return { params: { field: m[1], value: m[2] } };
      if ((m = s.match(/^(?:select|choose|pick)\s+(.+?)\s+(?:in|from|for)\s+(?:the\s+)?(.+)$/))) return { params: { field: m[2], value: m[1] } };
      if ((m = s.match(/^(?:enter|type|put|write|fill in|add)\s+(.+?)\s+(?:in|into|on|for|as)\s+(?:the\s+)?(.+?)(?:\s+(?:field|box|input))?$/))) return { params: { field: m[2], value: m[1] } };
      return { ask: 'Which field and which value? Say, for example, \u201center Muchinga Secondary in school name\u201d or \u201cset level to Junior Secondary\u201d.' };
    },
    describe: function (p) { return 'set ' + p.field + ' to ' + p.value; }
  }, async function (p) {
    var r = findFields(p.field, function (f) { return f.type !== 'password' && f.type !== 'checkbox' && f.type !== 'radio'; });
    if (!r.length || r[0].score < 0.72) return fail('I couldn\u2019t find a field called \u201c' + p.field + '\u201d on this screen.');
    if (r[1] && r[1].score > r[0].score - 0.05 && r[1].label !== r[0].label) return fail('Two fields look like that: \u201c' + r[0].label + '\u201d and \u201c' + r[1].label + '\u201d. Please say the full field name.');
    var f = r[0].el, old = f.value, v, shown;
    if (f.tagName === 'SELECT') {
      var o = chooseOption(f, norm(p.value));
      if (!o) return fail('I couldn\u2019t match \u201c' + p.value + '\u201d to the choices: ' + list([].slice.call(f.options).filter(function (x) { return x.value; }).map(function (x) { return x.text; }), 6) + '.');
      v = o.value; shown = o.text;
    } else if (f.type === 'date') { v = parseDate(norm(p.value)); if (!v) return fail('I couldn\u2019t understand that date. Say, for example, \u201ctoday\u201d or \u201c23 November\u201d.'); shown = v; }
    else if (f.type === 'number') { var nm = norm(p.value).match(/\d+(\.\d+)?/); if (!nm) return fail('That field needs a number.'); v = nm[0]; shown = v; }
    else { v = /[a-z]/i.test(p.value) && !/@|\d{4,}/.test(p.value) ? cap(p.value) : p.value; shown = v; }
    setVal(f, v);
    if (String(f.value) !== String(v)) { setVal(f, old); return fail('The field didn\u2019t accept that value. I restored it.'); }
    return { ok: true, message: 'I set ' + r[0].label + ' to ' + shown + '.',
      verify: { title: 'Field filled in', lines: [cap(r[0].label) + ': ' + shown + (old ? ' (was ' + old + ')' : '')], undo: async function () { setVal(f, old); return 'Undone. ' + r[0].label + ' is back to how it was.'; } } };
  });

  add('ui_toggle', 'tick or untick a box', [['tick', 'untick', 'check', 'uncheck', 'enable', 'disable', 'switch on', 'switch off', 'turn on', 'turn off']], {
    parse: function (t) {
      var s = strip(t), m = s.match(/^(tick|untick|check|uncheck|enable|disable|switch on|switch off|turn on|turn off)\s+(?:the\s+)?(.+)$/);
      if (!m) return { ask: 'Which box? Say, for example, \u201ctick remember me\u201d.' };
      return { params: { want: /^(tick|check|enable|switch on|turn on)$/.test(m[1]), field: m[2] } };
    },
    describe: function (p) { return (p.want ? 'tick ' : 'untick ') + p.field; }
  }, async function (p) {
    var r = findFields(p.field, function (f) { return f.type === 'checkbox' || f.type === 'radio'; });
    if (!r.length || r[0].score < 0.72) return fail('I couldn\u2019t find a box called \u201c' + p.field + '\u201d on this screen.');
    var f = r[0].el, was = f.checked;
    if (was !== p.want) f.click();
    await wait(100);
    if (f.checked !== p.want) return fail('The box didn\u2019t change.');
    return { ok: true, message: r[0].label + ' is now ' + (p.want ? 'ticked' : 'unticked') + '.',
      verify: { title: 'Box changed', lines: [cap(r[0].label) + ': ' + (p.want ? 'ticked' : 'unticked')], undo: async function () { if (f.checked !== was) f.click(); return 'Undone.'; } } };
  });

  add('ui_list', 'tell you what you can press here', [['what', 'which', 'list', 'read', 'tell me'], ['can i press', 'can i tap', 'buttons', 'is on this screen', 'is on the screen', 'options here', 'can i do here', 'on this page']], {}, async function () {
    var c = controls(BTN), seen = {}, labels = [];
    c.els.forEach(function (b) { var l = niceLabel(b); if (l && !seen[l] && l.length < 40) { seen[l] = 1; labels.push(l); } });
    var inRoot = labels.slice(0, 12);
    if (!inRoot.length) return fail('I can\u2019t see any buttons on this screen.');
    return { ok: true, message: 'You can press: ' + inRoot.join(', ') + '.' };
  });
  add('ui_scroll', 'scroll the screen', [['scroll'], ['down', 'up', 'top', 'bottom', 'end']], {
    parse: function (t) { return { params: { dir: /\b(up|top)\b/.test(t) ? -1 : 1, far: /\b(top|bottom|end)\b/.test(t) } }; }
  }, async function (p) {
    var root = activeRoot(), sc = root !== document.body && root.scrollHeight > root.clientHeight + 4 ? root : (document.scrollingElement || document.documentElement);
    var big = p.far ? 100000 : window.innerHeight * 0.8;
    if (sc.scrollBy) sc.scrollBy({ top: p.dir * big, behavior: 'smooth' }); else sc.scrollTop += p.dir * big;
    return { ok: true, message: 'Scrolled ' + (p.dir > 0 ? 'down' : 'up') + '.' };
  });
})();
