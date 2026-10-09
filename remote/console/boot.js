// Runs before the first paint (classic script, CSP script-src 'self'): applies the console theme so
// there is no flash. Same rule as applyTheme() in console.js: 'auto' = the display's theme, else the browser's.
(function () {
  var theme = 'dark';
  try {
    var pref = localStorage.getItem('ob.console.theme') || 'auto';
    var display = localStorage.getItem('ob.console.display-theme');
    var system = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    theme = pref === 'light' || pref === 'dark' ? pref : (display === 'light' || display === 'dark' ? display : system);
  } catch (e) { /* storage unavailable: dark */ }
  document.documentElement.setAttribute('data-ob-theme', theme);
})();
