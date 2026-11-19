/* videoCatalog.js - the curated music-video catalog.
 *
 * One global Redis hash (CATALOG_KEY) holds every row, field = row id, value =
 * JSON. The server keeps a derived in-memory copy with lookup indexes (Spotify
 * ID, ISRC, normalised artist+title) so /api/music-video never hits Redis per
 * poll. Every write goes to Redis first, then drops the in-memory copy; the
 * next lookup reloads it with a single HGETALL. That is what makes an edit in
 * the master grid show up on the very next poll, even for the song playing now.
 *
 * Row shape:
 *   { id, song, artist, spotifyId, youtubeId, startMs, enabled, nsfw,
 *     isrc, notes, updatedAt }
 *   enabled = the sheet's "Video ON/OFF" column.
 *   nsfw    = the sheet's "NSFW YES/NO" column: 'yes' | 'no' | '' (not set).
 *             Family mode only plays rows marked 'no'; a blank is NOT treated as safe.
 *   startMs = how far into the YouTube video the song actually begins
 *             (what the player calls introOffsetMs).
 */
'use strict';

const CATALOG_KEY = 'video-catalog:rows';
const CACHE_TTL_MS = 120 * 1000;      // safety net only; writes invalidate immediately
const MAX_START_MS = 10 * 60 * 1000;  // an intro longer than 10 minutes is a typo
const MIN_START_MS = -2 * 60 * 1000;  // negative = the video starts this long AFTER the song starts (e.g. -0:05)
const MAX_ROWS = 20000;

// ---------- parsing / normalising -------------------------------------------

function parseYouTubeId(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s) return '';
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    let m = s.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/i);
    if (m) return m[1];
    m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/i);
    if (m) return m[1];
    return null; // non-empty but not recognisable
}

function parseSpotifyId(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s) return '';
    if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
    let m = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})/i);
    if (m) return m[1];
    m = s.match(/^spotify:track:([A-Za-z0-9]{22})$/i);
    if (m) return m[1];
    return null;
}

function parseIsrc(input) {
    const s = String(input == null ? '' : input).trim().toUpperCase().replace(/[\s-]/g, '');
    if (!s) return '';
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(s) ? s : null;
}

// Accepts a number of ms, or text: "12", "12.5", "0:12", "1:02.5", "1:02:03".
function parseStartMs(input) {
    if (input === null || input === undefined || input === '') return 0;
    if (typeof input === 'number') {
        return Number.isFinite(input) && input >= MIN_START_MS && input <= MAX_START_MS ? Math.round(input) : null;
    }
    const s = String(input).trim();
    if (!s) return 0;
    // A leading minus (or the typographic "\u2212") means the video begins AFTER the song has started.
    const m = /^([-\u2212]?)(.*)$/.exec(s);
    const neg = m[1] !== '';
    const body = m[2].trim();
    if (!/^\d+(\.\d+)?(:\d+(\.\d+)?){0,2}$/.test(body)) return null;
    const parts = body.split(':').map(Number);
    let seconds = 0;
    for (const p of parts) seconds = seconds * 60 + p;
    const ms = Math.round(seconds * 1000) * (neg ? -1 : 1);
    return ms >= MIN_START_MS && ms <= MAX_START_MS ? (ms === 0 ? 0 : ms) : null;
}

// "Skip points" column: parts of the video to jump over while it plays (talking, skits, breaks the song
// doesn't have). Times are VIDEO times (what YouTube shows), as ranges: "2:14-2:31, 3:40-3:52".
// Accepts that text, or an array of { fromMs, toMs }. Returns a sorted, non-overlapping array of
// { fromMs, toMs } ([] for blank), or null if anything is invalid.
const MAX_SKIPS = 20;
const MAX_SKIP_MS = 3 * 3600 * 1000;
function parseClockMs(text) {
    const s = String(text == null ? '' : text).trim();
    if (!/^\d+(\.\d+)?(:\d+(\.\d+)?){0,2}$/.test(s)) return null;
    let seconds = 0;
    for (const p of s.split(':').map(Number)) seconds = seconds * 60 + p;
    const ms = Math.round(seconds * 1000);
    return ms >= 0 && ms <= MAX_SKIP_MS ? ms : null;
}
function parseSkips(input) {
    if (input === null || input === undefined || input === '') return [];
    const pairs = [];
    if (Array.isArray(input)) {
        for (const s of input) {
            const a = Number(s && s.fromMs), b = Number(s && s.toMs);
            if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
            pairs.push([Math.round(a), Math.round(b)]);
        }
    } else {
        const text = String(input).trim();
        if (!text) return [];
        for (const part of text.split(/[,;\n]+/)) {
            const p = part.trim();
            if (!p) continue;
            const m = /^(.+?)\s*(?:-|\u2013|\u2014|\bto\b)\s*(.+)$/i.exec(p);
            if (!m) return null;
            const a = parseClockMs(m[1]), b = parseClockMs(m[2]);
            if (a === null || b === null) return null;
            pairs.push([a, b]);
        }
    }
    if (pairs.length > MAX_SKIPS) return null;
    pairs.sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of pairs) {
        if (a < 0 || b > MAX_SKIP_MS || b - a < 500) return null;                // each skip must be at least half a second
        if (out.length && a < out[out.length - 1].toMs) return null;            // overlapping
        out.push({ fromMs: a, toMs: b });
    }
    return out;
}

// "Video ON/OFF" column. Returns true/false, `fallback` for blank, null if unrecognised.
function parseOnOff(input, fallback) {
    if (typeof input === 'boolean') return input;
    if (input === null || input === undefined) return fallback;
    const s = String(input).trim().toLowerCase();
    if (s === '') return fallback;
    if (['on', 'true', 'yes', 'y', '1', 'x', '✓'].includes(s)) return true;
    if (['off', 'false', 'no', 'n', '0'].includes(s)) return false;
    return null;
}

// "Video type" column: what kind of video this row is. When a song has several
// usable videos, Music video is preferred over Visualizer, then Lyric video, then Audio.
// Returns 'video' | 'visualizer' | 'lyric' | 'audio' | '' (blank), or null if unrecognised.
function parseKind(input) {
    const s = String(input == null ? '' : input).trim().toLowerCase().replace(/[^a-z]/g, '');
    if (!s) return '';
    if (['video', 'musicvideo', 'officialvideo', 'officialmusicvideo', 'mv', 'official'].includes(s)) return 'video';
    if (['visualizer', 'visualiser', 'viz', 'officialvisualizer', 'officialvisualiser'].includes(s)) return 'visualizer';
    if (['lyric', 'lyrics', 'lyricvideo'].includes(s)) return 'lyric';
    if (['audio', 'officialaudio', 'topic'].includes(s)) return 'audio';
    return null;
}

// "Suggestive? YES/NO" column (was "NSFW YES/NO"). Returns 'yes' | 'no' | '' (blank), or null if unrecognised.
function parseNsfw(input) {
    if (typeof input === 'boolean') return input ? 'yes' : 'no';
    const s = String(input == null ? '' : input).trim().toLowerCase();
    if (s === '') return '';
    // yes = video is suggestive in any way (blocked in Family mode); no = fine (plays in Family mode)
    if (['yes', 'y', 'true', '1', 'nsfw', 'suggestive', 'explicit', 'e'].includes(s)) return 'yes';
    if (['no', 'n', 'false', '0', 'safe', 'clean', 'c', 'family', 'ok', 'not suggestive'].includes(s)) return 'no';
    return null;
}

function parseBool(input, fallback) {
    if (typeof input === 'boolean') return input;
    if (input === null || input === undefined || input === '') return fallback;
    const s = String(input).trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 'x', '✓'].includes(s)) return true;
    if (['false', 'no', 'n', '0', 'off'].includes(s)) return false;
    return fallback;
}

function stripDiacritics(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Matching keys. Spotify decorates titles ("- Remastered 2011", "(feat. X)",
// "- Single Version") and joins artists with ", ". Both sides go through the
// same cleaning, so a row typed as "Beatles" / "Hey Jude" still matches
// "The Beatles" / "Hey Jude - Remastered 2015".
const clean = (v) => stripDiacritics(v).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

function coreTitleText(song) {
    let t = String(song || '').trim();
    // Drop trailing "(...)" / "[...]" groups, but never the whole title
    // (e.g. "(I Can't Get No) Satisfaction" keeps its opening bracket).
    for (let i = 0; i < 4; i++) {
        const next = t.replace(/\s*[(\[][^()\[\]]*[)\]]\s*$/, '').trim();
        if (next === t || !next) break;
        t = next;
    }
    // Unbracketed featured artist: "Song ft. X", "Song feat. X", "Song featuring X".
    const unfeat = t.replace(/\s+(?:feat|ft|featuring)\b\.?\s.*$/i, '').trim();
    if (unfeat) t = unfeat;
    const dash = t.split(/\s[-\u2013\u2014]\s/)[0].trim();
    if (dash) t = dash;
    return t;
}
function coreTitle(song) { return clean(coreTitleText(song)); }

function artistKeys(artist) {
    return String(artist || '')
        .split(/,|;|&|\band\b|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b|\//i)
        .map(a => clean(a).replace(/^the/, ''))
        .filter(Boolean);
}

// Primary artist + core title, e.g. "beatles|heyjude".
function titleKey(artist, song) {
    const a = artistKeys(artist)[0], t = coreTitle(song);
    return a && t ? `${a}|${t}` : '';
}
// A row typed with its version tag but no bracket or dash ("Song Re-edit", "Song Extended Mix") would never be found by
// its core title. Index it a second time with those trailing version words dropped. rowMatchesVersion still compares
// the version words, so this only lets such rows be FOUND; it can't make a wrong version match.
function coreTitleLoose(song) {
    const tokens = coreTitleText(song).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const droppable = w => VERSION_MARKERS[w] || w === 're' || w === 'original' || w === 'version';
    while (tokens.length > 1 && droppable(tokens[tokens.length - 1])) tokens.pop();
    return clean(tokens.join(' '));
}
function titleKeyLoose(artist, song) {
    const a = artistKeys(artist)[0], t = coreTitleLoose(song);
    return a && t ? `${a}|${t}` : '';
}

// ---------- "is this the same VERSION of the song?" --------------------------
// Matching by title + artist deliberately ignores decorations ("- Remastered 2011", "(feat. X)", "- Single
// Version"), so a row would also fire for a different recording: a remix, a re-edit, a live cut, or the version
// with/without a guest artist. Different recordings have different starts and lengths, so a video made for one
// cannot sync to the other. These checks stop that; they apply to the Title+Artist tiers only (Spotify ID and
// ISRC matches are already exact).
const VERSION_MARKERS = { remix: 'remix', rmx: 'remix', remixed: 'remix', edit: 'edit', edited: 'edit', rework: 'rework', reworked: 'rework',
    bootleg: 'bootleg', flip: 'flip', vip: 'vip', mashup: 'mashup', live: 'live', acoustic: 'acoustic', instrumental: 'instrumental',
    extended: 'extended', sped: 'spedup', speedup: 'spedup', slowed: 'slowed', reverb: 'reverb', nightcore: 'nightcore', cover: 'cover',
    demo: 'demo', stripped: 'stripped', piano: 'piano', orchestral: 'orchestral', acapella: 'acapella', acappella: 'acapella',
    mix: 'mix', club: 'club', radio: 'radio', dub: 'dub', dance: 'dance' };
// The whole title is scanned, so a tag typed with or without brackets / a dash counts the same, on both sides.
// "Remastered", "Single Version", "Album Version" are the SAME recording and don't count.
function versionKey(song) {
    const tokens = String(song || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const found = new Set();
    tokens.forEach((w, i) => {
        if (!VERSION_MARKERS[w]) return;
        if (w === 'mix' && tokens[i - 1] === 'original') return;     // "Original Mix" is the plain song
        found.add(VERSION_MARKERS[w]);
    });
    return [...found].sort().join('+');
}
// Artists named in "(feat. X)" / "ft. X" / "featuring X" in a title.
function featKeysFromTitle(title) {
    const t = String(title || '');
    const out = [];
    const m = t.match(/[(\[]\s*(?:feat|ft|featuring|with)\b\.?\s+([^)\]]+)[)\]]/i) || t.match(/\s(?:feat|ft|featuring)\b\.?\s+(.+)$/i);
    if (m) for (const k of artistKeys(m[1])) out.push(k);
    return out;
}
// Everyone credited on a row (Artist box + any "(feat. X)" / "ft. X" in its title) and on the playing track.
// A row lists ALL the artists in its video, so the two sets must be the same: a video that has a guest artist is
// not the version without them, and the reverse.
function creditSet(artist, title) {
    return new Set([...artistKeys(artist), ...featKeysFromTitle(title)]);
}
// np: the playing track { trackId, isrc, title, artist }.
function rowMatchesVersion(row, np) {
    const nIsrc = parseIsrc(np.isrc) || '';
    if (row.spotifyId && np.trackId && row.spotifyId !== np.trackId) return false;   // pinned to a different Spotify track (an ISRC match would already have won)
    if (row.isrc && nIsrc && row.isrc !== nIsrc) return false;                      // pinned to a different recording
    if (versionKey(row.song) !== versionKey(np.title)) return false;                 // remix / re-edit / live / ... on only one side
    const rowSet = creditSet(row.artist, row.song);
    if (rowSet.size) {
        const playSet = creditSet(np.artist, np.title);
        let same = rowSet.size === playSet.size;
        if (same) for (const k of rowSet) if (!playSet.has(k)) { same = false; break; }
        if (!same) {
            // Names run together because a comma was missed ("Dua Lipa DaBaby"): every artist on the track must be inside
            // the row's text, with nothing left over. ("the" is ignored on both sides.)
            const strip = x => x.replace(/the/g, '');
            const blob = strip([...rowSet].join(''));
            const keys = [...playSet].map(strip);
            same = keys.length > 0 && keys.every(k => blob.includes(k)) && blob.length === keys.reduce((n, k) => n + k.length, 0);
        }
        if (!same) return false;                                                     // an artist is on one side only
    }
    return true;
}

function clampStr(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
}

// Validates one incoming row against an optional existing row. Returns
// { row, errors } - errors is { field: message } and means "do not save".
function normalizeInput(input, existing) {
    const src = input || {};
    const errors = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
    const base = existing || { enabled: true, nsfw: '', startMs: 0 };
    const row = {
        id: existing ? existing.id : undefined,
        song: has('song') ? clampStr(src.song, 200) : (base.song || ''),
        artist: has('artist') ? clampStr(src.artist, 200) : (base.artist || ''),
        spotifyId: base.spotifyId || '',
        youtubeId: base.youtubeId || '',
        startMs: base.startMs || 0,
        enabled: base.enabled !== false,
        nsfw: base.nsfw === 'yes' || base.nsfw === 'no' ? base.nsfw : '',
        kind: ['video', 'visualizer', 'lyric', 'audio'].includes(base.kind) ? base.kind : '',
        skips: Array.isArray(base.skips) ? base.skips : [],
        isrc: base.isrc || '',
        notes: has('notes') ? clampStr(src.notes, 500) : (base.notes || '')
    };
    if (has('spotifyId')) {
        const v = parseSpotifyId(src.spotifyId);
        if (v === null) errors.spotifyId = 'Not a Spotify track link or 22-character ID.';
        else row.spotifyId = v;
    }
    if (has('youtubeId')) {
        const v = parseYouTubeId(src.youtubeId);
        if (v === null) errors.youtubeId = 'Not a YouTube link or 11-character video ID.';
        else row.youtubeId = v;
    }
    if (has('startMs')) {
        const v = parseStartMs(src.startMs);
        if (v === null) errors.startMs = 'Use seconds (12.5) or m:ss (1:02.5), 0 to 10:00. A minus (-0:05) makes the video start that long after the song starts.';
        else row.startMs = v;
    }
    if (has('isrc')) {
        const v = parseIsrc(src.isrc);
        if (v === null) errors.isrc = 'ISRC is 12 characters, e.g. USRC17607839.';
        else row.isrc = v;
    }
    if (has('enabled')) {
        const v = parseOnOff(src.enabled, true);
        if (v === null) errors.enabled = 'Use ON or OFF.';
        else row.enabled = v;
    }
    if (has('nsfw')) {
        const v = parseNsfw(src.nsfw);
        if (v === null) errors.nsfw = 'Use YES (suggestive) or NO (or leave blank).';
        else row.nsfw = v;
    }
    if (has('kind')) {
        const v = parseKind(src.kind);
        if (v === null) errors.kind = 'Use Music video, Visualizer, Lyric video or Audio (or leave blank).';
        else row.kind = v;
    }
    if (has('skips')) {
        const v = parseSkips(src.skips);
        if (v === null) errors.skips = 'Use video times as ranges, e.g. 2:14-2:31, 3:40-3:52 (each end later than its start, in order, not overlapping).';
        else row.skips = v;
    }
    return { row, errors };
}

// ---------- factory ---------------------------------------------------------

module.exports = function createVideoCatalog({ redis }) {
    let state = null;          // { loadedAt, rows: Map, bySpotify, byIsrc, byTitle }
    let loading = null;
    let idCounter = 0;

    function build(rowsObj) {
        const rows = new Map();
        const bySpotify = new Map(), byIsrc = new Map(), byTitle = new Map(), byCore = new Map();
        const push = (map, key, row) => {
            if (!key) return;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(row);
        };
        for (const row of Object.values(rowsObj)) {
            rows.set(row.id, row);
            push(bySpotify, row.spotifyId, row);
            push(byIsrc, row.isrc, row);
            push(byTitle, titleKey(row.artist, row.song), row);
            const lk = titleKeyLoose(row.artist, row.song);
            if (lk && lk !== titleKey(row.artist, row.song)) push(byTitle, lk, row);
            push(byCore, coreTitle(row.song), row);
            const lc = coreTitleLoose(row.song);
            if (lc && lc !== coreTitle(row.song)) push(byCore, lc, row);
        }
        return { loadedAt: Date.now(), rows, bySpotify, byIsrc, byTitle, byCore };
    }

    async function fetchAll() {
        const flat = await redis(['HGETALL', CATALOG_KEY]);
        const out = {};
        if (Array.isArray(flat)) {
            for (let i = 0; i + 1 < flat.length; i += 2) {
                try {
                    const row = JSON.parse(flat[i + 1]);
                    if (row && row.id) out[row.id] = row;
                } catch (e) { /* skip a corrupt row rather than lose the catalog */ }
            }
        } else if (flat && typeof flat === 'object') {
            for (const [id, v] of Object.entries(flat)) {
                try { const row = JSON.parse(v); if (row && row.id) out[id] = row; } catch (e) { /* skip */ }
            }
        }
        return out;
    }

    // Reloads when invalidated or stale. If Redis is unreachable, keeps serving
    // the last good copy instead of failing the live display.
    async function ensureLoaded() {
        if (state && Date.now() - state.loadedAt < CACHE_TTL_MS) return state;
        if (!loading) {
            loading = fetchAll()
                .then((obj) => { state = build(obj); return state; })
                .catch((err) => {
                    console.error('[CATALOG] Reload from Redis failed:', err.message);
                    if (state) { state.loadedAt = Date.now() - CACHE_TTL_MS + 15000; return state; } // retry in ~15s
                    throw err;
                })
                .finally(() => { loading = null; });
        }
        return loading;
    }

    function invalidate() { state = null; }

    function newId() {
        // Timestamp + an in-order counter (then a little randomness), so ids sort in
        // the order rows were created, even for a whole batch made in one millisecond.
        idCounter = (idCounter + 1) % 46656;
        return 'r_' + Date.now().toString(36) + idCounter.toString(36).padStart(3, '0') + Math.random().toString(36).slice(2, 5);
    }

    // Lower = preferred. Blank (unlabelled, e.g. older rows) sits between a real music video and a visualizer.
    const KIND_RANK = { video: 0, '': 1, visualizer: 2, lyric: 3, audio: 4 };
    function pickBest(list, familyMode) {
        // A row that is enabled and has a video always beats one that does not.
        // Among usable rows the order is:
        //   1. Family mode: ON prefers Suggestive = NO, OFF prefers the other one.
        //   2. Video type: Music video, then (blank), Visualizer, Lyric video, Audio.
        //   3. The newest edit.
        const want = familyMode ? (r => r.nsfw === 'no' ? 1 : 0) : (r => r.nsfw === 'no' ? 0 : 1);
        return [...list].sort((a, b) => {
            const sa = (a.enabled && a.youtubeId) ? 1 : 0, sb = (b.enabled && b.youtubeId) ? 1 : 0;
            if (sa !== sb) return sb - sa;
            if (sa) {
                const wa = want(a), wb = want(b);
                if (wa !== wb) return wb - wa;
            }
            if (sa) {
                const ka = KIND_RANK[a.kind || ''], kb = KIND_RANK[b.kind || ''];
                if (ka !== kb) return ka - kb;
            }
            return (b.updatedAt || 0) - (a.updatedAt || 0);
        })[0];
    }

    // np: { trackId, isrc, title, artist }. A row only needs Title + Artist and
    // a YouTube ID. Spotify ID and ISRC are optional extras that pin an exact
    // version of a song: a row that has one is used for THAT recording only, and
    // the Title+Artist tiers also refuse a different version (remix, re-edit,
    // live, a track with or without a guest artist) - see rowMatchesVersion. Tiers, strongest first: Spotify ID, ISRC, Title+Artist
    // (any of the playing artists), then Title alone for rows whose Artist is
    // blank. The first tier holding a usable row wins; a row a person switched
    // OFF stops the search; a row with no YouTube ID yet does not block a
    // looser match that has one.
    // opts.familyMode: when a song has both a suggestive and a family-friendly
    // video, pick the family-friendly one (see pickBest).
    async function lookup(np, opts) {
        const familyMode = !!(opts && opts.familyMode);
        const st = await ensureLoaded();
        const n = np || {};
        const tiers = [['spotify', st.bySpotify.get(n.trackId) || []],
                       ['isrc', st.byIsrc.get(parseIsrc(n.isrc) || '') || []]];
        const titleHits = [];
        for (const a of artistKeys(n.artist)) {
            for (const r of (st.byTitle.get(`${a}|${coreTitle(n.title)}`) || [])) if (!titleHits.includes(r) && rowMatchesVersion(r, n)) titleHits.push(r);
        }
        tiers.push(['title', titleHits]);
        const core = coreTitle(n.title);
        tiers.push(['title_only', core ? (st.byCore.get(core) || []).filter(r => !artistKeys(r.artist).length && rowMatchesVersion(r, n)) : []]);
        let noVideo = null;
        for (const [via, list] of tiers) {
            if (!list.length) continue;
            const row = pickBest(list, familyMode);
            if (!row.enabled) return { status: 'disabled', via, row };
            if (!row.youtubeId) { noVideo = noVideo || { status: 'no_video', via, row }; continue; }
            return { status: 'hit', via, row };
        }
        return noVideo || { status: 'miss', rowCount: st.rows.size };
    }

    async function list() {
        const st = await ensureLoaded();
        return [...st.rows.values()].sort((a, b) =>
            (a.artist || '').localeCompare(b.artist || '') || (a.song || '').localeCompare(b.song || ''));
    }

    async function stats() {
        const st = await ensureLoaded();
        let withVideo = 0;
        for (const r of st.rows.values()) if (r.youtubeId && r.enabled) withVideo++;
        return { rows: st.rows.size, playable: withVideo };
    }

    function warningsFor(st, row) {
        const warnings = [];
        if (row.spotifyId) {
            const dupes = (st.bySpotify.get(row.spotifyId) || []).filter(r => r.id !== row.id);
            if (dupes.length) warnings.push({ field: 'spotifyId', message: `Another row already uses this Spotify ID (${dupes[0].artist || '?'} - ${dupes[0].song || '?'}).` });
        }
        if (!row.spotifyId && !row.isrc && !(row.song && row.artist)) {
            warnings.push({ field: 'song', message: 'Fill in Title and Artist so the player can recognise the song (Spotify ID and ISRC are optional).' });
        }
        return warnings;
    }

    // Creates or updates one row. `input.id` updates that row (or recreates it
    // for undo when `input.restore` is set). With no id, a row with the same
    // Spotify ID is updated instead of duplicated.
    async function upsert(input) {
        const st = await ensureLoaded();
        let existing = input && input.id ? st.rows.get(input.id) : null;
        if (!existing && input && !input.id && input.spotifyId) {
            const sid = parseSpotifyId(input.spotifyId);
            if (sid) existing = pickBest(st.bySpotify.get(sid) || []) || null;
        }
        if (!existing && st.rows.size >= MAX_ROWS) return { errors: { _row: `Catalog is full (${MAX_ROWS} rows).` } };
        const { row, errors } = normalizeInput(input, existing);
        if (Object.keys(errors).length) return { errors };
        row.id = existing ? existing.id : (input && input.id && /^[A-Za-z0-9_-]{4,40}$/.test(input.id) ? input.id : newId());
        row.updatedAt = Date.now();
        await redis(['HSET', CATALOG_KEY, row.id, JSON.stringify(row)]);
        invalidate();
        const fresh = await ensureLoaded().catch(() => st);
        return { row, warnings: warningsFor(fresh, row), created: !existing };
    }

    // Bulk upsert (paste / CSV). One HSET for the whole batch. Rows that fail
    // validation are reported by index and skipped; the rest are saved.
    async function upsertMany(inputs) {
        const st = await ensureLoaded();
        const results = [];
        const pairs = [];
        const seenSpotify = new Map(); // spotifyId -> id, to merge duplicates inside one batch
        let capacityLeft = MAX_ROWS - st.rows.size;
        inputs.forEach((input, index) => {
            let existing = input && input.id ? st.rows.get(input.id) : null;
            if (!existing && input && input.spotifyId) {
                const sid = parseSpotifyId(input.spotifyId);
                if (sid) {
                    if (seenSpotify.has(sid)) existing = { ...(pairs.find(p => p.row.id === seenSpotify.get(sid)) || {}).row };
                    if (!existing || !existing.id) existing = pickBest(st.bySpotify.get(sid) || []) || null;
                }
            }
            if (!existing && capacityLeft <= 0) { results.push({ index, errors: { _row: 'Catalog is full.' } }); return; }
            const { row, errors } = normalizeInput(input, existing);
            if (Object.keys(errors).length) { results.push({ index, errors }); return; }
            if (!existing) capacityLeft--;
            row.id = existing && existing.id ? existing.id : newId();
            row.updatedAt = Date.now();
            if (row.spotifyId) seenSpotify.set(row.spotifyId, row.id);
            const prior = pairs.findIndex(p => p.row.id === row.id);
            if (prior >= 0) pairs[prior] = { row }; else pairs.push({ row });
            results.push({ index, row, created: !existing });
        });
        if (pairs.length) {
            const cmd = ['HSET', CATALOG_KEY];
            for (const p of pairs) cmd.push(p.row.id, JSON.stringify(p.row));
            await redis(cmd);
            invalidate();
        }
        return { results, saved: pairs.length };
    }

    async function remove(id) {
        const n = await redis(['HDEL', CATALOG_KEY, String(id)]);
        invalidate();
        return { removed: Number(n) > 0 };
    }

    return { lookup, list, stats, upsert, upsertMany, remove, invalidate,
             parse: { parseKind, parseYouTubeId, parseSpotifyId, parseIsrc, parseStartMs, titleKey, coreTitle, artistKeys } };
};
