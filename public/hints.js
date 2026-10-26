/* hints.js - one switch for all the little explanatory "hint" text on the admin-side pages.
 * Hints are OFF by default. The lightbulb button turns them on; the choice is remembered in
 * this browser under the same key admin.html and manager.html use ('adminHintsOn'), so
 * flipping it on any page flips it everywhere. admin.html and manager.html have their own
 * bulb in their headers; every other page that loads this file gets one added to its first
 * .header automatically. */
(function () {
    var KEY = 'adminHintsOn';
    var css = document.createElement('style');
    css.textContent =
        'body.hints-hidden .settings-card-hint, body.hints-hidden .filter-hint, body.hints-hidden .field-hint,' +
        'body.hints-hidden .cv-hint, body.hints-hidden .pv-hint, body.hints-hidden .cv-queue-hint { display: none !important; }' +
        'body.hints-hidden .empty-hint { visibility: hidden; }' +
        '.hints-bulb { background: none; border: none; color: var(--text-muted, #a7a7a7); cursor: pointer; padding: 8px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }' +
        '.hints-bulb:hover { color: var(--text, #fff); }' +
        '.hints-bulb.hints-on { color: var(--spotify-green, #1DB954); }' +
        '.hints-bulb svg { width: 22px; height: 22px; fill: currentColor; }';
    document.head.appendChild(css);

    function isOn() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
    function apply(on) {
        document.body.classList.toggle('hints-hidden', !on);
        var b = document.querySelectorAll('.hints-bulb');
        for (var i = 0; i < b.length; i++) b[i].classList.toggle('hints-on', on);
    }
    function toggle() {
        var on = document.body.classList.contains('hints-hidden');
        apply(on);
        try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
    }
    function addButton() {
        if (document.getElementById('toggle-hints') || document.querySelector('.hints-bulb')) return true;
        var header = document.querySelector('.header');
        if (!header) return false;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hints-bulb';
        btn.title = 'Show/hide hints';
        btn.setAttribute('aria-label', 'Show or hide hints');
        btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1l-.85.6V15h-4v-2.3l-.85-.6C7.8 11.16 7 9.63 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 .63-.8 2.16-2.15 3.1z"/></svg>';
        btn.onclick = toggle;
        (header.querySelector('.header-actions') || header).appendChild(btn);
        return true;
    }
    function init() {
        apply(isOn());
        if (!addButton()) setTimeout(function () { addButton(); apply(isOn()); }, 1000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
    window.CueHints = { toggle: toggle, apply: apply, isOn: isOn };
})();
