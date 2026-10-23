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
 *
 * FILE MAP
 *   1. SETTINGS ............ constants you can tweak
 *   2. PARSERS ............. turn messy input into clean values
 *   3. MATCHING KEYS ....... normalise titles/artists so songs can be matched
 *   4. VALIDATION .......... check one incoming row
 *   5. FACTORY ............. createVideoCatalog({ redis })
 *        5a. In-memory cache + loading
 *        5b. Picking the best row
 *        5c. Looking up a playing song
 *        5d. Reading (list / stats)
 *        5e. Writing (upsert / upsertMany / remove)
 *        5f. What the factory returns
 */
'use strict';


/* =============================================================================
 * 1. SETTINGS
 * ========================================================================== */

const CATALOG_KEY = 'video-catalog:rows';
const CACHE_TTL_MS = 120 * 1000;      // safety net only; writes invalidate immediately
const MAX_START_MS = 10 * 60 * 1000;  // an intro longer than 10 minutes is a typo
const MIN_START_MS = -2 * 60 * 1000;  // negative = the video starts this long AFTER the song starts (e.g. -0:05)
const MAX_ROWS = 20000;


/* =============================================================================
 * 2. PARSERS
 * Each one takes whatever a person typed/pasted and returns a clean value.
 * Convention: '' = blank, null = "I don't recognise that" (becomes an error).
 * ========================================================================== */

/* ----- YouTube ID: accepts a bare 11-char ID or any common YouTube link ----- */
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


/* ----- Spotify ID: bare 22-char ID, open.spotify.com link, or spotify: URI -- */
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


/* ----- ISRC: 12 characters, e.g. USRC17607839 ------------------------------- */
function parseIsrc(input) {
    const s = String(input == null ? '' : input).trim().toUpperCase().replace(/[\s-]/g, '');
    if (!s) return '';
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(s) ? s : null;
}


/* ----- Start offset (ms) ---------------------------------------------------- */
// Accepts a number of ms, or text: "12", "12.5", "0:12", "1:02.5", "1:02:03".
function parseStartMs(input) {
    if (input === null || input === undefined || input === '') return 0;

    // Plain number = already milliseconds
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

    // "1:02.5" -> [1, 2.5] -> 62.5 seconds
    const parts = body.split(':').map(Number);
    let seconds = 0;
    for (const p of parts) seconds = seconds * 60 + p;

    const ms = Math.round(seconds * 1000) * (neg ? -1 : 1);
    return ms >= MIN_START_MS && ms <= MAX_START_MS ? (ms === 0 ? 0 : ms) : null;
}


/* ----- "Video ON/OFF" column ------------------------------------------------ */
// Returns true/false, `fallback` for blank, null if unrecognised.
function parseOnOff(input, fallback) {
    if (typeof input === 'boolean') return input;
    if (input === null || input === undefined) return fallback;

    const s = String(input).trim().toLowerCase();
    if (s === '') return fallback;

    if (['on', 'true', 'yes', 'y', '1', 'x', '✓'].includes(s)) return true;
    if (['off', 'false', 'no', 'n', '0'].includes(s)) return false;
    return null;
}


/* ----- "Video type" column -------------------------------------------------- */
// What kind of video this row is. When a song has several usable videos,
// Music video is preferred over Visualizer, then Lyric video, then Audio.
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


/* ----- "Suggestive? YES/NO" column (was "NSFW YES/NO") ---------------------- */
// Returns 'yes' | 'no' | '' (blank), or null if unrecognised.
function parseNsfw(input) {
    if (typeof input === 'boolean') return input ? 'yes' : 'no';

    const s = String(input == null ? '' : input).trim().toLowerCase();
    if (s === '') return '';

    // yes = video is suggestive in any way (blocked in Family mode); no = fine (plays in Family mode)
    if (['yes', 'y', 'true', '1', 'nsfw', 'suggestive', 'explicit', 'e'].includes(s)) return 'yes';
    if (['no', 'n', 'false', '0', 'safe', 'clean', 'c', 'family', 'ok', 'not suggestive'].includes(s)) return 'no';
    return null;
}


/* ----- Generic true/false (unrecognised input just uses the fallback) ------- */
function parseBool(input, fallback) {
    if (typeof input === 'boolean') return input;
    if (input === null || input === undefined || input === '') return fallback;

    const s = String(input).trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 'x', '✓'].includes(s)) return true;
    if (['false', 'no', 'n', '0', 'off'].includes(s)) return false;
    return fallback;
}


/* ----- Plain text: strip control characters and cap the length -------------- */
function clampStr(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
}


/* =============================================================================
 * 3. MATCHING KEYS
 * Spotify decorates titles ("- Remastered 2011", "(feat. X)", "- Single Version")
 * and joins artists with ", ". Both sides go through the same cleaning, so a row
 * typed as "Beatles" / "Hey Jude" still matches "The Beatles" / "Hey Jude -
 * Remastered 2015".
 * ========================================================================== */

/* ----- Remove accents (é -> e) ---------------------------------------------- */
function stripDiacritics(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}


/* ----- Lowercase, "&" -> "and", keep only letters and digits ---------------- */
const clean = (v) => stripDiacritics(v).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');


/* ----- Song title with all the decoration removed --------------------------- */
function coreTitle(song) {
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

    // Anything after " - " (e.g. "- Remastered 2015")
    const dash = t.split(/\s[-\u2013\u2014]\s/)[0].trim();
    if (dash) t = dash;

    return clean(t);
}


/* ----- Every artist in an "A, B & C feat. D" string, cleaned ---------------- */
function artistKeys(artist) {
    return String(artist || '')
        .split(/,|;|&|\band\b|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b|\//i)
        .map(a => clean(a).replace(/^the/, ''))
        .filter(Boolean);
}


/* ----- Primary artist + core title, e.g. "beatles|heyjude" ------------------ */
function titleKey(artist, song) {
    const a = artistKeys(artist)[0], t = coreTitle(song);
    return a && t ? `${a}|${t}` : '';
}


/* =============================================================================
 * 4. VALIDATION
 * ========================================================================== */

/* ----- Validate one incoming row against an optional existing row ----------- */
// Returns { row, errors } - errors is { field: message } and means "do not save".
function normalizeInput(input, existing) {
    const src = input || {};
    const errors = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
    const base = existing || { enabled: true, nsfw: '', startMs: 0 };

    // Start from the existing values (or defaults)...
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
        isrc: base.isrc || '',
        notes: has('notes') ? clampStr(src.notes, 500) : (base.notes || '')
    };

    // ...then overwrite only the fields the caller actually sent.
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

    return { row, errors };
}


/* =============================================================================
 * 5. FACTORY
 * Usage: const catalog = require('./videoCatalog')({ redis });
 * ========================================================================== */

module.exports = function createVideoCatalog({ redis }) {

    let state = null;          // { loadedAt, rows: Map, bySpotify, byIsrc, byTitle, byCore }
    let loading = null;        // the in-flight reload, so parallel callers share it
    let idCounter = 0;


    /* -------------------------------------------------------------------------
     * 5a. IN-MEMORY CACHE + LOADING
     * ---------------------------------------------------------------------- */

    /* ----- Build the lookup indexes from a { id: row } object ---------------- */
    function build(rowsObj) {
        const rows = new Map();
        const bySpotify = new Map(), byIsrc = new Map(), byTitle = new Map(), byCore = new Map();

        // Adds `row` to the list stored under `key` (skips blank keys)
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
            push(byCore, coreTitle(row.song), row);
        }

        return { loadedAt: Date.now(), rows, bySpotify, byIsrc, byTitle, byCore };
    }


    /* ----- Read every row from Redis (one HGETALL) --------------------------- */
    async function fetchAll() {
        const flat = await redis(['HGETALL', CATALOG_KEY]);
        const out = {};

        if (Array.isArray(flat)) {
            // Redis replied with a flat list: [id1, json1, id2, json2, ...]
            for (let i = 0; i + 1 < flat.length; i += 2) {
                try {
                    const row = JSON.parse(flat[i + 1]);
                    if (row && row.id) out[row.id] = row;
                } catch (e) { /* skip a corrupt row rather than lose the catalog */ }
            }
        } else if (flat && typeof flat === 'object') {
            // Redis replied with an object: { id: json, ... }
            for (const [id, v] of Object.entries(flat)) {
                try { const row = JSON.parse(v); if (row && row.id) out[id] = row; } catch (e) { /* skip */ }
            }
        }

        return out;
    }


    /* ----- Reload when invalidated or stale ---------------------------------- */
    // If Redis is unreachable, keeps serving the last good copy instead of
    // failing the live display.
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


    /* ----- Throw the cache away so the next read reloads from Redis ---------- */
    function invalidate() { state = null; }


    /* ----- New row id: sorts in creation order ------------------------------- */
    function newId() {
        // Timestamp + an in-order counter (then a little randomness), so ids sort in
        // the order rows were created, even for a whole batch made in one millisecond.
        idCounter = (idCounter + 1) % 46656;
        return 'r_' + Date.now().toString(36) + idCounter.toString(36).padStart(3, '0') + Math.random().toString(36).slice(2, 5);
    }


    /* -------------------------------------------------------------------------
     * 5b. PICKING THE BEST ROW
     * When several rows match one song, choose which to play.
     * ---------------------------------------------------------------------- */

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
            // Rule 0: usable (enabled + has a video) first
            const sa = (a.enabled && a.youtubeId) ? 1 : 0, sb = (b.enabled && b.youtubeId) ? 1 : 0;
            if (sa !== sb) return sb - sa;

            // Rule 1: family mode preference
            if (sa) {
                const wa = want(a), wb = want(b);
                if (wa !== wb) return wb - wa;
            }

            // Rule 2: video type
            if (sa) {
                const ka = KIND_RANK[a.kind || ''], kb = KIND_RANK[b.kind || ''];
                if (ka !== kb) return ka - kb;
            }

            // Rule 3: newest edit
            return (b.updatedAt || 0) - (a.updatedAt || 0);
        })[0];
    }


    /* -------------------------------------------------------------------------
     * 5c. LOOKING UP A PLAYING SONG
     * ---------------------------------------------------------------------- */

    // np: { trackId, isrc, title, artist }. A row only needs Title + Artist and
    // a YouTube ID. Spotify ID and ISRC are optional extras that pin an exact
    // version of a song. Tiers, strongest first: Spotify ID, ISRC, Title+Artist
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

        // Tier 1 + 2: exact IDs
        const tiers = [['spotify', st.bySpotify.get(n.trackId) || []],
                       ['isrc', st.byIsrc.get(parseIsrc(n.isrc) || '') || []]];

        // Tier 3: title + any of the playing artists
        const titleHits = [];
        for (const a of artistKeys(n.artist)) {
            for (const r of (st.byTitle.get(`${a}|${coreTitle(n.title)}`) || [])) if (!titleHits.includes(r)) titleHits.push(r);
        }
        tiers.push(['title', titleHits]);

        // Tier 4: title only, for rows that have no artist filled in
        const core = coreTitle(n.title);
        tiers.push(['title_only', core ? (st.byCore.get(core) || []).filter(r => !artistKeys(r.artist).length) : []]);

        // Walk the tiers, strongest first
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


    /* -------------------------------------------------------------------------
     * 5d. READING
     * ---------------------------------------------------------------------- */

    /* ----- All rows, sorted by artist then song ------------------------------ */
    async function list() {
        const st = await ensureLoaded();
        return [...st.rows.values()].sort((a, b) =>
            (a.artist || '').localeCompare(b.artist || '') || (a.song || '').localeCompare(b.song || ''));
    }


    /* ----- Totals: how many rows, how many can actually play ----------------- */
    async function stats() {
        const st = await ensureLoaded();
        let withVideo = 0;
        for (const r of st.rows.values()) if (r.youtubeId && r.enabled) withVideo++;
        return { rows: st.rows.size, playable: withVideo };
    }


    /* -------------------------------------------------------------------------
     * 5e. WRITING
     * ---------------------------------------------------------------------- */

    /* ----- Soft warnings shown after a save (these don't block it) ----------- */
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


    /* ----- Create or update ONE row ------------------------------------------ */
    // `input.id` updates that row (or recreates it for undo when `input.restore`
    // is set). With no id, a row with the same Spotify ID is updated instead of
    // duplicated.
    async function upsert(input) {
        const st = await ensureLoaded();

        // Find the row being edited (by id, or by matching Spotify ID)
        let existing = input && input.id ? st.rows.get(input.id) : null;
        if (!existing && input && !input.id && input.spotifyId) {
            const sid = parseSpotifyId(input.spotifyId);
            if (sid) existing = pickBest(st.bySpotify.get(sid) || []) || null;
        }

        if (!existing && st.rows.size >= MAX_ROWS) return { errors: { _row: `Catalog is full (${MAX_ROWS} rows).` } };

        // Validate
        const { row, errors } = normalizeInput(input, existing);
        if (Object.keys(errors).length) return { errors };

        // Stamp id + time, save, refresh cache
        row.id = existing ? existing.id : (input && input.id && /^[A-Za-z0-9_-]{4,40}$/.test(input.id) ? input.id : newId());
        row.updatedAt = Date.now();
        await redis(['HSET', CATALOG_KEY, row.id, JSON.stringify(row)]);
        invalidate();

        const fresh = await ensureLoaded().catch(() => st);
        return { row, warnings: warningsFor(fresh, row), created: !existing };
    }


    /* ----- Create or update MANY rows (paste / CSV) -------------------------- */
    // One HSET for the whole batch. Rows that fail validation are reported by
    // index and skipped; the rest are saved.
    async function upsertMany(inputs) {
        const st = await ensureLoaded();
        const results = [];
        const pairs = [];
        const seenSpotify = new Map(); // spotifyId -> id, to merge duplicates inside one batch
        let capacityLeft = MAX_ROWS - st.rows.size;

        inputs.forEach((input, index) => {
            // Find the row being edited (by id, or by matching Spotify ID,
            // including one added earlier in this same batch)
            let existing = input && input.id ? st.rows.get(input.id) : null;
            if (!existing && input && input.spotifyId) {
                const sid = parseSpotifyId(input.spotifyId);
                if (sid) {
                    if (seenSpotify.has(sid)) existing = { ...(pairs.find(p => p.row.id === seenSpotify.get(sid)) || {}).row };
                    if (!existing || !existing.id) existing = pickBest(st.bySpotify.get(sid) || []) || null;
                }
            }

            if (!existing && capacityLeft <= 0) { results.push({ index, errors: { _row: 'Catalog is full.' } }); return; }

            // Validate
            const { row, errors } = normalizeInput(input, existing);
            if (Object.keys(errors).length) { results.push({ index, errors }); return; }

            // Accept it
            if (!existing) capacityLeft--;
            row.id = existing && existing.id ? existing.id : newId();
            row.updatedAt = Date.now();
            if (row.spotifyId) seenSpotify.set(row.spotifyId, row.id);

            const prior = pairs.findIndex(p => p.row.id === row.id);
            if (prior >= 0) pairs[prior] = { row }; else pairs.push({ row });
            results.push({ index, row, created: !existing });
        });

        // Save everything accepted in one go
        if (pairs.length) {
            const cmd = ['HSET', CATALOG_KEY];
            for (const p of pairs) cmd.push(p.row.id, JSON.stringify(p.row));
            await redis(cmd);
            invalidate();
        }

        return { results, saved: pairs.length };
    }


    /* ----- Delete one row ---------------------------------------------------- */
    async function remove(id) {
        const n = await redis(['HDEL', CATALOG_KEY, String(id)]);
        invalidate();
        return { removed: Number(n) > 0 };
    }


    /* -------------------------------------------------------------------------
     * 5f. WHAT THE FACTORY RETURNS
     * ---------------------------------------------------------------------- */

    return {
        lookup, list, stats, upsert, upsertMany, remove, invalidate,
        parse: { parseKind, parseYouTubeId, parseSpotifyId, parseIsrc, parseStartMs, titleKey, coreTitle, artistKeys }
    };
};
