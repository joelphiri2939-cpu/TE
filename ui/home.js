/* TeachMate 3.0 — React home shell (no build step: React 18 UMD + htm).
   The engine (Firebase, IndexedDB, sync, feature pages) is untouched.
   This file only draws the home screen and calls the engine's own functions:
     showSection(id), #logout-btn, #tm-help-btn, #openPlannerBtn. */
(function () {
  'use strict';
  if (!window.React || !window.ReactDOM || !window.htm) { console.warn('[TM-UI] React not loaded — keeping old home'); return; }

  var h = React.createElement;
  var html = htm.bind(h);
  var useState = React.useState, useEffect = React.useEffect, useMemo = React.useMemo;

  /* ── icons (Feather-style paths) ── */
  var P = {
    home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
    att: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M9 2h6v4H9z M9 14l2 2 4-4',
    users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
    chart: 'M18 20V10 M12 20V4 M6 20v-6',
    cash: 'M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    book: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
    help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01',
    out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
    grid: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
    go: 'M5 12h14 M12 5l7 7-7 7',
    school: 'M3 21h18 M5 21V8l7-5 7 5v13 M9 21v-6h6v6',
    cap: 'M22 10L12 5 2 10l10 5 10-5z M6 12v5c0 1 2.7 3 6 3s6-2 6-3v-5'
  };
  function Icon(props) {
    var size = props.size || 20;
    return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${P[props.n]} /></svg>`;
  }

  /* ── reading the engine's local database (read-only, never creates it) ── */
  function readStore(name) {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open('TeachMateDB');
        req.onupgradeneeded = function (e) { try { e.target.transaction.abort(); } catch (x) {} };
        req.onerror = function () { resolve([]); };
        req.onsuccess = function () {
          var db = req.result;
          try {
            if (!db.objectStoreNames.contains(name)) { db.close(); return resolve([]); }
            var r = db.transaction(name, 'readonly').objectStore(name).getAll();
            r.onsuccess = function () { db.close(); resolve(r.result || []); };
            r.onerror = function () { db.close(); resolve([]); };
          } catch (e) { try { db.close(); } catch (x) {} resolve([]); }
        };
      } catch (e) { resolve([]); }
    });
  }
  function dayKey(d) { return d.toISOString().split('T')[0]; }

  function useStats(active) {
    var s = useState({ classes: 0, students: 0, plans: 0, week: [], todayRate: null });
    var stats = s[0], setStats = s[1];
    useEffect(function () {
      if (!active) return;
      var alive = true;
      function load() {
        Promise.all([readStore('classes'), readStore('students'), readStore('attendanceHistory'),
          readStore('lp_v3_plans'), readStore('lessonplans')]).then(function (r) {
          if (!alive) return;
          var att = r[2], byDay = {};
          att.forEach(function (a) {
            if (!a || !a.date) return;
            var k = String(a.date).slice(0, 10), o = byDay[k] || (byDay[k] = { p: 0, t: 0 });
            o.t++; if (a.present === true) o.p++;
          });
          var week = [];
          for (var i = 6; i >= 0; i--) {
            var d = new Date(Date.now() - i * 864e5), k2 = dayKey(d), o2 = byDay[k2];
            week.push({ label: d.toLocaleDateString('en-GB', { weekday: 'short' }), rate: o2 && o2.t ? Math.round(o2.p / o2.t * 100) : null });
          }
          var today = week[6].rate;
          setStats({ classes: r[0].length, students: r[1].length, plans: r[3].length + r[4].length, week: week, todayRate: today });
        });
      }
      load();
      var t1 = setTimeout(load, 2500), t2 = setTimeout(load, 8000); // pick up data the sync engine restores after login
      return function () { alive = false; clearTimeout(t1); clearTimeout(t2); };
    }, [active]);
    return stats;
  }

  /* ── engine bridge ── */
  function openSection(id) { try { window.showSection(id); } catch (e) { console.error(e); } }
  function clickLegacy(id) { var el = document.getElementById(id); if (el) el.click(); }
  function legacyText(id) { var el = document.getElementById(id); return el ? (el.textContent || '').trim() : ''; }

  function useEngineState() {
    var s = useState({ on: false, plannerOn: false, name: '', school: '' });
    var st = s[0], set = s[1];
    useEffect(function () {
      var dash = document.getElementById('dashboard');
      function pull() {
        var on = !!dash && dash.style.display === 'block';
        var plan = document.getElementById('openPlannerBtn');
        var plannerOn = !!plan && plan.style.display !== 'none';
        var w = legacyText('welcome'), name = '';
        var m = w.match(/^Welcome Teacher (.+) to TeachMate$/);
        name = m ? m[1] : (w.replace(/^Welcome,?\s*/, '') || '');
        var school = legacyText('tm-school-name');
        document.documentElement.classList.toggle('tm-home-on', on);
        set(function (p) { return (p.on === on && p.plannerOn === plannerOn && p.name === name && p.school === school) ? p : { on: on, plannerOn: plannerOn, name: name, school: school }; });
      }
      pull();
      var mo = new MutationObserver(pull);
      if (dash) mo.observe(dash, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true, characterData: true });
      var plan = document.getElementById('openPlannerBtn');
      if (plan) mo.observe(plan, { attributes: true, attributeFilter: ['style'] });
      window.addEventListener('popstate', pull);
      var iv = setInterval(pull, 2000); // cheap safety net
      return function () { mo.disconnect(); clearInterval(iv); window.removeEventListener('popstate', pull); };
    }, []);
    return st;
  }

  function useClock() {
    var s = useState(''); var t = s[0], set = s[1];
    useEffect(function () {
      function tick() { set(new Date().toLocaleTimeString('en-US', { timeZone: 'Africa/Harare', hour: '2-digit', minute: '2-digit', hour12: true })); }
      tick(); var iv = setInterval(tick, 20000); return function () { clearInterval(iv); };
    }, []);
    return t;
  }
  function greeting() {
    var hr = Number(new Date().toLocaleString('en-US', { timeZone: 'Africa/Harare', hour: 'numeric', hour12: false }));
    return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  }

  /* ── pieces ── */
  var TOOLS = [
    { id: 'attendance', n: 'att', t: 'Attendance Register', d: 'Mark and review daily attendance', c: 'var(--tm-mint)', i: 'var(--tm-mint-i)' },
    { id: 'class-management', n: 'users', t: 'Class Management', d: 'Students and class rosters', c: 'var(--tm-violet)', i: 'var(--tm-violet-i)' },
    { id: 'results', n: 'chart', t: 'Results Tracking', d: 'Enter marks, make report cards', c: 'var(--tm-amber)', i: 'var(--tm-amber-i)' },
    { id: 'fees', n: 'cash', t: 'Fees Tracking (ZMW)', d: 'See who has paid and who owes', c: 'var(--tm-pink)', i: 'var(--tm-pink-i)' },
    { id: 'messages', n: 'chat', t: 'Messages', d: 'Notes between you and the school', c: 'var(--tm-mint)', i: 'var(--tm-mint-i)' }
  ];

  function Stat(p) {
    return html`<div class="tmx-stat" style=${{ '--c': p.c, '--i': p.i }}>
      <div class="chip"><${Icon} n=${p.n} size=${18} /></div>
      <strong>${p.value}</strong><span>${p.label}</span></div>`;
  }
  function Bars(p) {
    var any = p.week.some(function (d) { return d.rate !== null; });
    if (!any) return html`<div class="tmx-empty">No attendance marked in the last 7 days.<br/>Open the Attendance Register to start.</div>`;
    return html`<div class="tmx-bars" role="img" aria-label="Attendance rate for the last seven days">
      ${p.week.map(function (d, i) {
        return html`<div class="tmx-bar" key=${i}>
          <u>${d.rate === null ? '' : d.rate + '%'}</u>
          <i class=${d.rate === null ? 'off' : ''} style=${{ height: d.rate === null ? '4px' : Math.max(6, d.rate * 0.82) + 'px' }}></i>
          <em>${d.label}</em></div>`;
      })}</div>`;
  }

  function App() {
    var eng = useEngineState();
    var stats = useStats(eng.on);
    var clock = useClock();
    var more = useState(false), moreOpen = more[0], setMore = more[1];
    var name = eng.name || 'Teacher';
    var initial = (name.replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '').charAt(0) || 'T').toUpperCase();

    var nav = useMemo(function () {
      var l = [{ k: 'home', n: 'home', t: 'Home', f: function () {} }]
        .concat(TOOLS.map(function (x) { return { k: x.id, n: x.n, t: x.t, f: function () { openSection(x.id); } }; }));
      if (eng.plannerOn) l.push({ k: 'planner', n: 'book', t: 'Lesson Planner', f: function () { clickLegacy('openPlannerBtn'); } });
      return l;
    }, [eng.plannerOn]);

    if (!eng.on) return null;

    var tools = TOOLS.slice();
    if (eng.plannerOn) tools.push({ id: '_planner', n: 'book', t: 'Lesson Planner', d: 'Plan lessons in the Zambian format', c: 'var(--tm-violet)', i: 'var(--tm-violet-i)' });
    function openTool(id) { if (id === '_planner') clickLegacy('openPlannerBtn'); else openSection(id); }

    return html`<div class="tmx">
      <aside class="tmx-side" aria-label="Main navigation">
        <div class="tmx-brand"><div class="logo"><${Icon} n="cap" size=${20} /></div><div>TeachMate<small>CLASSROOM 3.0</small></div></div>
        <div class="lbl">Menu</div>
        <nav class="tmx-nav">${nav.map(function (x) {
          return html`<button key=${x.k} class=${x.k === 'home' ? 'on' : ''} onClick=${x.f}><${Icon} n=${x.n} size=${18} />${x.t}</button>`;
        })}</nav>
        <div class="sp"></div>
        <nav class="tmx-nav">
          <button onClick=${function () { clickLegacy('tm-help-btn'); }}><${Icon} n="help" size=${18} />How to use TeachMate</button>
          <button class="danger" onClick=${function () { clickLegacy('logout-btn'); }}><${Icon} n="out" size=${18} />Logout</button>
        </nav>
      </aside>

      <main class="tmx-main"><div class="tmx-wrap">
        <div class="tmx-top">
          <div class="tmx-hello"><small>${greeting()}</small><h1>${name}</h1></div>
          <div class="tmx-clock">${clock}</div>
          <button class="tmx-avatar" aria-label="Account" onClick=${function () { setMore(true); }}>${initial}</button>
        </div>

        <div class="tmx-school"><div class="ic"><${Icon} n="school" size=${22} /></div>
          <div><small>Your school</small><b>${eng.school || 'TeachMate'}</b></div></div>

        <div class="tmx-stats">
          <${Stat} n="users" label="Students" value=${stats.students} c="var(--tm-pink)" i="var(--tm-pink-i)" />
          <${Stat} n="school" label="Classes" value=${stats.classes} c="var(--tm-amber)" i="var(--tm-amber-i)" />
          <${Stat} n="att" label="Present today" value=${stats.todayRate === null ? '\u2014' : stats.todayRate + '%'} c="var(--tm-mint)" i="var(--tm-mint-i)" />
          <${Stat} n="book" label="Lesson plans" value=${stats.plans} c="var(--tm-violet)" i="var(--tm-violet-i)" />
        </div>

        <div class="tmx-section-title">Your tools</div>
        <div class="tmx-tools">${tools.map(function (x) {
          return html`<button key=${x.id} class="tmx-tool" style=${{ '--c': x.c, '--i': x.i }} onClick=${function () { openTool(x.id); }}>
            <div class="chip"><${Icon} n=${x.n} size=${22} /></div><b>${x.t}</b><span>${x.d}</span>
            <div class="go">Open <${Icon} n="go" size=${14} /></div></button>`;
        })}</div>

        <div class="tmx-card"><h2>Attendance this week <small>last 7 days</small></h2><${Bars} week=${stats.week} /></div>
      </div></main>

      <nav class="tmx-bottom" aria-label="Main navigation">
        <button class="tmx-bn on"><span class="pill"><${Icon} n="home" size=${20} /></span>Home</button>
        <button class="tmx-bn" onClick=${function () { openSection('attendance'); }}><span class="pill"><${Icon} n="att" size=${20} /></span>Attendance</button>
        <button class="tmx-bn" onClick=${function () { openSection('results'); }}><span class="pill"><${Icon} n="chart" size=${20} /></span>Results</button>
        <button class="tmx-bn" onClick=${function () { openSection('fees'); }}><span class="pill"><${Icon} n="cash" size=${20} /></span>Fees</button>
        <button class="tmx-bn" onClick=${function () { setMore(true); }}><span class="pill"><${Icon} n="grid" size=${20} /></span>More</button>
      </nav>

      ${moreOpen && html`<div class="tmx-scrim" onClick=${function () { setMore(false); }}>
        <div class="tmx-sheet" onClick=${function (e) { e.stopPropagation(); }}>
          <div class="grab"></div>
          <button onClick=${function () { setMore(false); openSection('class-management'); }}><${Icon} n="users" />Class Management</button>
          <button onClick=${function () { setMore(false); openSection('messages'); }}><${Icon} n="chat" />Messages</button>
          ${eng.plannerOn && html`<button onClick=${function () { setMore(false); clickLegacy('openPlannerBtn'); }}><${Icon} n="book" />Lesson Planner</button>`}
          <button onClick=${function () { setMore(false); clickLegacy('tm-help-btn'); }}><${Icon} n="help" />How to use TeachMate</button>
          <button class="danger" onClick=${function () { setMore(false); clickLegacy('logout-btn'); }}><${Icon} n="out" />Logout</button>
        </div></div>`}
    </div>`;
  }

  function mount() {
    var root = document.getElementById('tm-react-root');
    if (!root) return;
    ReactDOM.createRoot(root).render(h(App));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
