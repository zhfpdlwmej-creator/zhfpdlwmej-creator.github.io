/* 첫 페인트 전에 테마 적용 (FOUC 방지) — 인라인 스크립트 대신 외부 파일 (CSP script-src 'self') */
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('promptslim.theme') || 'system'; } catch (e) {}
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.setAttribute('data-theme-pref', pref);
})();
