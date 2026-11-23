/* ui/voice-match.js — "sounds-like" matching for TeachMate voice commands.
 * Speech recognizers mishear ("results tracking" -> "result striking"). Instead of requiring exact words,
 * every heard word is compared, by spelling AND by sound, with TeachMate's own vocabulary
 * (command words, screen names, class words, learner names). Nothing outside TeachMate is consulted. */
(function () {
  'use strict';
  var cache = {};
  /* phonetic skeleton: similar-sounding words collapse to the same few letters
   * (glass~class, clothes~close, great~grade, brook~back) */
  function pk(word) {
    var w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return '';
    if (cache[w] !== undefined) return cache[w];
    var o = w.replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/^wh/, 'w').replace(/^ps/, 's').replace(/^x/, 's')
      .replace(/tion|sion/g, 'xn').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/sch/g, 'sk').replace(/sh|ch/g, 'x')
      .replace(/th/g, 't').replace(/gh/g, '').replace(/dg/g, 'j').replace(/qu/g, 'kw').replace(/q/g, 'k').replace(/x/g, 'ks')
      .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/z/g, 's').replace(/ng/g, 'n')
      .replace(/b/g, 'p').replace(/d/g, 't').replace(/g/g, 'k').replace(/v/g, 'f');
    var first = o.charAt(0), rest = o.slice(1).replace(/[aeiouyhw]/g, '');
    o = (/[aeiouyhw]/.test(first) ? 'a' : first) + rest;      // keep only the first sound if it is a vowel
    o = o.replace(/(.)\1+/g, '$1');
    cache[w] = o;
    return o;
  }
  function lev(a, b) {
    var m = a.length, n = b.length, i, j, d = [];
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 1; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    return d[m][n];
  }
  /* similarity of two words, 0..1 (1 = same word) */
  function tsim(h, v) {
    if (h === v) return 1;
    if (/^\d+$/.test(h) || /^\d+$/.test(v)) return 0;
    var lh = h.length, lv = v.length;
    if (Math.min(lh, lv) <= 2) return 0;
    var L = 1 - lev(h, v) / Math.max(lh, lv), a = pk(h), b = pk(v);
    var P = a && b ? 1 - lev(a, b) / Math.max(a.length, b.length) : 0;
    var s = 0.5 * L + 0.5 * P;
    if (Math.min(lh, lv) >= 4 && (h.indexOf(v) === 0 || v.indexOf(h) === 0)) s = Math.max(s, 0.9);   // result ~ results
    return Math.min(1, s);
  }
  function best(word, list) {
    var b = { word: null, s: 0 };
    for (var i = 0; i < list.length; i++) { var s = tsim(word, list[i]); if (s > b.s) b = { word: list[i], s: s }; }
    return b;
  }
  window.TeachMateVoiceMatch = { pk: pk, lev: lev, tsim: tsim, best: best };
})();
