/* theme.js - the site is dark-only. Light / dark / auto switching has been removed.
 * This tiny file just pins the dark colour scheme and keeps the old CrowdTheme API as
 * harmless no-ops, so any page that still calls CrowdTheme.use() / set() / follow() keeps working. */
(function () {
    var doc = document.documentElement;
    doc.setAttribute('data-theme', 'dark');
    doc.setAttribute('data-theme-mode', 'dark');
    doc.style.colorScheme = 'dark';
    var noop = function () {};
    window.CrowdTheme = { use: noop, set: noop, follow: noop, get: function () { return 'dark'; } };
})();
