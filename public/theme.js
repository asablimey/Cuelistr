/* theme.css - the one place the light theme lives (dark is the base each page already ships).
 * Load AFTER the page's own <style>-free head links, i.e.:
 *     <link rel="stylesheet" href="/theme.css">
 * theme.js puts data-theme="light" | "dark" on <html>; everything here keys off that.
 *
 * Light is designed, not inverted:
 *   - a cool off-white page, with WHITE surfaces lifted off it by soft shadows
 *     (dark UIs separate layers with darkness; light UIs do it with shadow)
 *   - slightly tinted fields/cards so inputs read as inputs on a white panel
 *   - a deeper green (#12823b) so green text, links and filled buttons all pass
 *     contrast on white; buttons keep white text
 *   - softer scrims behind modals, and the handful of hard-coded dark-theme greys
 *     / pastel-on-dark colours re-pointed at readable ones
 * Dark mode is untouched: every new token below has its old value in :root.
 */

/* ---------- Tokens ---------- */
:root {
    --on-accent: #ffffff;           /* text on a green/red filled button */
    --text-faint: #666666;          /* captions, placeholders, empty states */
    --text-ghost: #555555;          /* disabled / lowest-emphasis text */
    --danger-text: #ff6b6b;         /* red text on a surface */
    --accent-soft: rgba(29, 185, 84, 0.15);
    --red-soft: rgba(233, 20, 41, 0.15);
    --scrim: rgba(0, 0, 0, 0.7);
    --shadow-sm: none;
    --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.4);
    --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.6);
}

html[data-theme="light"] {
    color-scheme: light;

    --spotify-green: #12823b;
    --spotify-black: #f2f4f8;       /* page background */
    --panel-bg: #ffffff;            /* cards / panels / modals */
    --card-bg: #eef1f6;             /* fields and nested cards on a panel */
    --inset-bg: #f7f9fc;
    --hover-bg: #e4e9f0;
    --stage-bg: #e8ecf2;
    --red-action: #c8102e;
    --blue-action: #0a66d9;

    --text: #111827;
    --text-soft: #374151;
    --text-muted: #566174;
    --text-dim: #566174;
    --text-faint: #6b7587;
    --text-ghost: #8a94a3;

    --border: #e1e6ee;
    --border-strong: #cbd3de;
    --overlay-soft: rgba(15, 23, 42, 0.06);

    --on-accent: #ffffff;
    --danger-text: #c8102e;
    --accent-soft: rgba(18, 130, 59, 0.12);
    --red-soft: rgba(200, 16, 46, 0.10);
    --scrim: rgba(15, 23, 42, 0.5);
    --shadow-sm: 0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.08);
    --shadow-md: 0 4px 12px rgba(16, 24, 40, 0.10), 0 2px 4px rgba(16, 24, 40, 0.06);
    --shadow-lg: 0 16px 40px rgba(16, 24, 40, 0.20);
}

/* ---------- Depth: lift surfaces off the page ---------- */
html[data-theme="light"] .panel,
html[data-theme="light"] .settings-card,
html[data-theme="light"] .stat-box,
html[data-theme="light"] .card,
html[data-theme="light"] .lock-container,
html[data-theme="light"] .event-card,
html[data-theme="light"] .account-recovery-panel,
html[data-theme="light"] .account-bar,
html[data-theme="light"] .my-event-item,
html[data-theme="light"] .cp-list,
html[data-theme="light"] .cp-add,
html[data-theme="light"] .pv-card,
html[data-theme="light"] .vc-bar,
html[data-theme="light"] .day-box,
html[data-theme="light"] .song-row,
html[data-theme="light"] .my-request-row {
    box-shadow: var(--shadow-sm);
}
html[data-theme="light"] .modal,
html[data-theme="light"] .modal-card,
html[data-theme="light"] .vc-card,
html[data-theme="light"] .vc-modal-card,
html[data-theme="light"] .sidebar-panel.is-visible,
html[data-theme="light"] .leaflet-popup-content-wrapper {
    box-shadow: var(--shadow-lg);
}

/* ---------- Scrims behind modals / menus: dim, don't black out ---------- */
html[data-theme="light"] #venue-code-overlay,
html[data-theme="light"] .modal-overlay,
html[data-theme="light"] .sidebar-backdrop,
html[data-theme="light"] #account-modal-overlay,
html[data-theme="light"] #modal-backdrop,
html[data-theme="light"] #music-video-modal-backdrop,
html[data-theme="light"] #ambient-modal-backdrop,
html[data-theme="light"] #cv-modal-backdrop,
html[data-theme="light"] .vc-modal {
    background: var(--scrim);
}

/* ---------- Text that was hard-coded for a dark background ---------- */
html[data-theme="light"] .settings-card-hint,
html[data-theme="light"] .playback-progress-wrap span,
html[data-theme="light"] .playback-upcoming-row .up-artist,
html[data-theme="light"] .site-credit a:hover { color: var(--text-muted); }
html[data-theme="light"] .playback-device,
html[data-theme="light"] .drag-handle,
html[data-theme="light"] .empty-placeholder,
html[data-theme="light"] .privacy-updated,
html[data-theme="light"] .qv-empty { color: var(--text-faint); }
html[data-theme="light"] .site-credit,
html[data-theme="light"] .site-credit a,
html[data-theme="light"] .search-box:disabled,
html[data-theme="light"] .qv-row-rank,
html[data-theme="light"] .avm-seq-drag { color: var(--text-ghost); }
html[data-theme="light"] .vote-btn-up svg { stroke: var(--text-faint); }

/* red text */
html[data-theme="light"] .settings-nav-item.danger-nav,
html[data-theme="light"] .settings-nav-item.danger-nav:hover,
html[data-theme="light"] .utility-btn,
html[data-theme="light"] .acct-error,
html[data-theme="light"] .avm-delete-link,
html[data-theme="light"] .cp-del,
html[data-theme="light"] .pv-meta button { color: var(--danger-text); }
html[data-theme="light"] .settings-nav-item.danger-nav.active-nav,
html[data-theme="light"] .utility-btn:hover { color: var(--on-accent); }

/* pastel-on-dark pills become dark-on-pale */
html[data-theme="light"] .tz-warning,
html[data-theme="light"] .avm-settings-remove { background: var(--red-soft); color: #9f1239; }
html[data-theme="light"] .avm-icon { background: rgba(126, 34, 206, 0.12); color: #7e22ce; }
html[data-theme="light"] .explicit-badge { background-color: #6b7280; color: #ffffff; }

/* text on filled-green / filled-red buttons (their base colour is --text, which is dark here) */
html[data-theme="light"] .sidebar-account-login,
html[data-theme="light"] .vc-btn-primary,
html[data-theme="light"] .btn-played,
html[data-theme="light"] .btn-remove:hover,
html[data-theme="light"] .playback-icon-btn.toggled-on { color: var(--on-accent); }
html[data-theme="light"] .playback-icon-btn.toggled-on svg { fill: var(--on-accent); }

/* hover borders that were a fixed mid-grey */
html[data-theme="light"] .vc-btn-secondary:hover:not(:disabled),
html[data-theme="light"] .btn-ghost:hover,
html[data-theme="light"] .zoom-btn:hover,
html[data-theme="light"] .upload-label:hover,
html[data-theme="light"] .ambient-file-row-btns button:hover,
html[data-theme="light"] .avm-btn-preview:hover,
html[data-theme="light"] .avm-nav-btn:hover,
html[data-theme="light"] .sidebar-event-link:hover,
html[data-theme="light"] .sidebar-account-logout:hover,
html[data-theme="light"] .my-requests-btn:hover,
html[data-theme="light"] .cv-toggle-btn:hover,
html[data-theme="light"] .cv-quick-align-row button:hover { border-color: var(--text-faint); }

/* the Custom Visual editor's controls were white-on-dark */
html[data-theme="light"] .cv-close,
html[data-theme="light"] .cv-layer-row button:hover,
html[data-theme="light"] .cv-layer-row-btn:hover,
html[data-theme="light"] .cv-settings-field input[type="text"],
html[data-theme="light"] .cv-settings-field input[type="number"],
html[data-theme="light"] .cv-settings-field select,
html[data-theme="light"] .cv-settings-field textarea,
html[data-theme="light"] .cv-toggle-btn,
html[data-theme="light"] .cv-quick-align-row button { color: var(--text); }
html[data-theme="light"] .cv-settings-field input[type="text"],
html[data-theme="light"] .cv-settings-field input[type="number"],
html[data-theme="light"] .cv-settings-field select,
html[data-theme="light"] .cv-settings-field textarea,
html[data-theme="light"] .cv-toggle-btn,
html[data-theme="light"] .cv-quick-align-row button { border-color: var(--border-strong); }

/* ---------- Focus: visible, brand-coloured ---------- */
html[data-theme="light"] :focus-visible { outline-color: var(--spotify-green); }

/* ---------- Scrollbars ---------- */
html[data-theme="light"] { scrollbar-color: #c3cbd6 transparent; }
