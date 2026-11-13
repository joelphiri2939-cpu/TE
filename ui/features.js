/* TeachMate 3.0 — feature page enhancer (vanilla, no build).
   Adds the live summary cards and cleans up the app bars. It only READS the
   page and clicks the engine's own buttons; it never replaces engine elements. */
(function () {
  'use strict';
  var PAGES = ['attendance', 'results', 'fees', 'class-management'];

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  PAGES.forEach(function (id) { var el = document.getElementById(id); if (el) el.classList.add('fx-page'); });

  /* ── app bar: no emoji, a subtitle with school + date ── */
  function tidyBars() {
    $$('.tm-fp').forEach(function (wrap) {
      var t = $('.tm-fp-title', wrap);
      if (!t || t.getAttribute('data-fx')) return;
      var clean = (t.textContent || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s*\(ZMW\)\s*$/, '').trim();
      var school = ($('#tm-school-name') && $('#tm-school-name').textContent || '').trim();
      var date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      t.textContent = clean;
      var small = document.createElement('small');
      small.textContent = (school && !/^teachmate$/i.test(school) ? school + ' · ' : '') + date;
      t.appendChild(small);
      t.setAttribute('data-fx', '1');
    });
  }
  new MutationObserver(tidyBars).observe(document.body, { childList: true });
  tidyBars();

  /* ── Attendance: live summary, search, "all present" ── */
  function initAttendance() {
    var att = document.getElementById('attendance'), table = document.getElementById('attendance-table');
    if (!att || !table || $('.fx-att-sum', att)) return;
    var hero = document.getElementById('openSubjectAttendanceBtn');
    if (hero && !hero.querySelector('small')) {
      hero.innerHTML = '<span>\uD83D\uDCCB Subject Attendance</span><small>Mark attendance per subject \u2192</small>';
    }
    var term = document.getElementById('attendance-term'), week = document.getElementById('attendance-week');
    if (term && !term.placeholder) term.placeholder = 'Term 1';
    if (week && !week.placeholder) week.placeholder = 'Week 1';
    var card = document.createElement('div');
    card.className = 'fx-card fx-att-sum';
    card.innerHTML =
      '<div class="fx-sum-top"><div class="fx-ring"><b>0%</b></div>' +
      '<div class="fx-nums">' +
      '<div class="fx-num p"><b data-k="p">0</b><span>Present</span></div>' +
      '<div class="fx-num a"><b data-k="a">0</b><span>Absent</span></div>' +
      '<div class="fx-num"><b data-k="u">0</b><span>Unmarked</span></div></div></div>' +
      '<div class="fx-sum-tools"><input type="search" placeholder="Search student…" autocomplete="off" aria-label="Search students">' +
      '<button type="button">All present</button></div>';
    att.insertBefore(card, table);

    function rows() { return $$('#attendance-table tbody tr').filter(function (r) { return !$('td[colspan]', r); }); }
    function update() {
      var rs = rows(), p = 0, a = 0;
      rs.forEach(function (r) {
        if ($('.present-btn.active', r)) p++; else if ($('.absent-btn.active', r)) a++;
      });
      var t = rs.length, u = Math.max(0, t - p - a), pct = t ? Math.round(p / t * 100) : 0;
      $('[data-k=p]', card).textContent = p; $('[data-k=a]', card).textContent = a; $('[data-k=u]', card).textContent = u;
      $('.fx-ring', card).style.setProperty('--p', pct);
      $('.fx-ring b', card).textContent = pct + '%';
      card.style.display = t ? '' : 'none';
    }
    var tb = $('tbody', table);
    new MutationObserver(update).observe(tb, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    table.addEventListener('click', function () { setTimeout(update, 0); });

    $('input', card).addEventListener('input', function (e) {
      var q = e.target.value.trim().toLowerCase();
      rows().forEach(function (r) { r.style.display = (!q || (r.textContent || '').toLowerCase().indexOf(q) >= 0) ? '' : 'none'; });
    });
    $('button', card).addEventListener('click', function () {
      $$('#attendance-table .present-btn:not(.active)').forEach(function (b) {
        if (b.closest('tr').style.display !== 'none') b.click();
      });
      update();
    });
    update();
  }

  /* ── Results: live average / range + colour bands ── */
  function initResults() {
    var actions = $('#results .row.actions'), table = document.getElementById('results-table');
    if (!actions || !table || $('.fx-res-sum')) return;
    var card = document.createElement('div');
    card.className = 'fx-card fx-res-sum';
    card.style.display = 'none';
    card.innerHTML =
      '<div class="fx-num"><b data-k="n">0/0</b><span>Entered</span></div>' +
      '<div class="fx-num"><b data-k="avg">–</b><span>Average</span></div>' +
      '<div class="fx-num p"><b data-k="hi">–</b><span>Highest</span></div>' +
      '<div class="fx-num a"><b data-k="lo">–</b><span>Lowest</span></div>';
    actions.parentNode.insertBefore(card, actions.nextSibling);

    function update() {
      var ins = $$('#results-table .result-input'), vals = [];
      ins.forEach(function (inp) {
        var v = parseFloat(inp.value), tr = inp.closest('tr');
        tr.classList.remove('fx-hi', 'fx-mid', 'fx-lo');
        if (!isNaN(v)) { vals.push(v); tr.classList.add(v >= 75 ? 'fx-hi' : v >= 50 ? 'fx-mid' : 'fx-lo'); }
      });
      card.style.display = ins.length ? '' : 'none';
      $('[data-k=n]', card).textContent = vals.length + '/' + ins.length;
      var f = function (x) { return Math.round(x * 10) / 10; };
      $('[data-k=avg]', card).textContent = vals.length ? f(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length) : '–';
      $('[data-k=hi]', card).textContent = vals.length ? f(Math.max.apply(null, vals)) : '–';
      $('[data-k=lo]', card).textContent = vals.length ? f(Math.min.apply(null, vals)) : '–';
    }
    table.addEventListener('input', update);
    new MutationObserver(update).observe($('tbody', table), { childList: true });
    update();
  }

  initAttendance();
  initResults();
})();
