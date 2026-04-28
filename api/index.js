const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const SHEET_BASE = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json";

const GENRE_MAP = {
    "Chronological": `${SHEET_BASE}&sheet=Chronological%20Order`,
    "Release Order": `${SHEET_BASE}&sheet=Release%20Order`,
    "Upcoming":      `${SHEET_BASE}&sheet=Upcoming`
};

const TMDB_KEY = "aca5177e4921fcdcb0ece67dc17b5bd0";
const DEFAULT_POSTER = "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg";
const TMDB_LOW_CONFIDENCE_THRESHOLD = 10;

const manifest = {
    id: "org.mcu.improved.search.stable",
    version: "3.2.4",
    name: "MCU Ultimate Watchlist",
    description: "Stable MCU list with Year-Aware TMDB Search",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [
        {
            type: "movie",
            id: "mcu_master_list",
            name: "MCU Ultimate",
            // FIX: "genre" is the special Stremio-recognized extra name.
            // Stremio renders these as filter tabs in the Discover page.
            // The SDK parses /genre=X.json from the URL and passes it as args.extra.genre.
            extra: [
                {
                    name: "genre",
                    options: ["Chronological", "Release Order", "Upcoming"],
                    isRequired: false
                }
            ]
        }
    ]
};

const builder = new addonBuilder(manifest);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractYear(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/\d{4}/);
    return match ? match[0] : null;
}

// ─── Title Parser ─────────────────────────────────────────────────────────────

function parseTitle(title) {
    // "ShowName Slingshot Episode N" — sub-series, treat as Season 1
    const slingshotMatch = title.match(/^(.+?)\s+Slingshot\s+Episode\s+(\d+)/i);
    if (slingshotMatch) {
        return {
            showName: `${slingshotMatch[1].trim()}: Slingshot`,
            isSeries: true,
            season: "1",
            episode: slingshotMatch[2]
        };
    }

    // "ShowName Season X Episode Y: Optional Episode Title"
    const epMatch = title.match(/^(.+?)\s+Season\s+(\d+)\s+Episode\s+(\d+)/i);
    if (epMatch) {
        return {
            showName: epMatch[1].trim(),
            isSeries: true,
            season: epMatch[2],
            episode: epMatch[3]
        };
    }

    return { showName: title, isSeries: false, season: null, episode: null };
}

// ─── TMDB Search — confidence-aware ──────────────────────────────────────────

async function getTmdbData(title, isSeries, year) {
    const type = isSeries ? 'tv' : 'movie';

    const search = async (withYear) => {
        let url = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}`;
        // Only apply year for movies — episode air dates ≠ show premiere year
        if (!isSeries && withYear && year) url += `&primary_release_year=${year}`;
        const res  = await fetch(url);
        const data = await res.json();
        return data.results || [];
    };

    try {
        let results = await search(true);

        // Movie-only: retry without year if nothing found
        if (!isSeries && results.length === 0 && year) {
            results = await search(false);
        }

        if (results.length === 0) return { imdbId: null, poster: null, confident: false };

        const item = results.sort((a, b) => b.vote_count - a.vote_count)[0];
        const confident = (item.vote_count ?? 0) >= TMDB_LOW_CONFIDENCE_THRESHOLD;

        if (!confident) {
            console.warn(`[LOW CONFIDENCE] "${title}" — vote_count: ${item.vote_count}, matched: ${item.title || item.name}`);
            return { imdbId: null, poster: null, confident: false };
        }

        const extRes  = await fetch(`https://api.themoviedb.org/3/${type}/${item.id}/external_ids?api_key=${TMDB_KEY}`);
        const extData = await extRes.json();

        return {
            imdbId: extData.imdb_id || null,
            poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
            confident: true
        };
    } catch (e) {
        console.error(`TMDB Error for "${title}":`, e.message);
        return { imdbId: null, poster: null, confident: false };
    }
}

// ─── Row Processor ────────────────────────────────────────────────────────────

async function processRow(row, index, genre) {
    try {
        const rawTitle = row.c?.[1]?.v?.toString().trim() ?? null;
        const rawDate  = row.c?.[2] ? (row.c[2].f || row.c[2].v?.toString()) : null;

        if (!rawTitle) return null;

        const year = extractYear(rawDate);

        // Filter out anything with a known release year before 1990
        if (year && parseInt(year) < 1990) {
            console.log(`[FILTERED] "${rawTitle}" — year ${year} is before 1990`);
            return null;
        }

        const { showName, isSeries, season, episode } = parseTitle(rawTitle);
        const tmdb = await getTmdbData(showName, isSeries, year);

        const baseId = (tmdb.confident && tmdb.imdbId)
            ? tmdb.imdbId
            : `promo_${index}`;

        if (!tmdb.confident) {
            console.log(`[PROMO/UNMATCHED] "${rawTitle}" — placeholder ID assigned`);
        }

        // Display number is position + 1 based on order in the sheet
        const num = index + 1;
        let id          = baseId;
        let displayName;

        if (isSeries && season && episode) {
            // Format: #23 S:2 E:10 Agent Carter Season 2 Episode 10: Hollywood Ending
            displayName = `#${num} S:${season} E:${episode} ${rawTitle}`;
            id          = `${baseId}:${season}:${episode}`;
        } else {
            // Format: #5 Captain America: The First Avenger
            displayName = `#${num} ${rawTitle}`;
        }

        return {
            id,
            type: isSeries ? "series" : "movie",
            name: displayName,
            poster: tmdb.poster || DEFAULT_POSTER,
            description: `MCU ${genre} • ${year ?? 'Release date unknown'}`
        };

    } catch (err) {
        console.error(`Row ${index} error:`, err.message);
        return null;
    }
}

// ─── Catalog Handler ──────────────────────────────────────────────────────────
// FIX: The SDK already parses the genre from the URL path and passes it as
// args.extra.genre — no manual URL parsing needed. Just read args.extra.genre.

builder.defineCatalogHandler(async (args) => {
    const genre = (args.extra && args.extra.genre && GENRE_MAP[args.extra.genre])
        ? args.extra.genre
        : "Chronological";

    console.log(`[Catalog] genre="${genre}"`);

    const sheetUrl = GENRE_MAP[genre];

    try {
        const res  = await fetch(sheetUrl);
        const text = await res.text();

        if (!text.includes("google.visualization.Query.setResponse")) {
            throw new Error("Invalid Google Sheets response");
        }

        const json    = JSON.parse(text.substring(47).slice(0, -2));
        const allRows = json.table.rows;

        // Skip header rows dynamically — headers have no 4-digit year in column 2
        const rows = allRows.filter((row) => {
            const col2 = row.c?.[2] ? (row.c[2].f || row.c[2].v?.toString() || "") : "";
            return /\d{4}/.test(col2) || col2 === "";
        });

        const metas = await Promise.all(
            rows.map((row, index) => processRow(row, index, genre))
        );

        return { metas: metas.filter(Boolean) };

    } catch (error) {
        console.error("Catalog Handler Error:", error.message);
        return { metas: [] };
    }
});

// ─── HTTP / Vercel Handler ────────────────────────────────────────────────────
// FIX: Use serveHTTP from the SDK for local dev, and a lean Vercel handler
// for production. The SDK router handles all URL parsing internally.

const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
        const url = req.url || '';

        // Manifest
        if (url.endsWith('manifest.json')) {
            return res.status(200).json(addonInterface.manifest);
        }

        // Catalog — let the SDK parse the URL properly
        // Stremio sends: /catalog/movie/mcu_master_list/genre=Chronological.json
        if (url.includes('/catalog/')) {
            // Extract extra props string from path: "genre=Chronological"
            // Pattern: /catalog/{type}/{id}/{extraProps}.json
            const pathMatch = url.match(/\/catalog\/[^/]+\/[^/]+\/([^?]+)\.json/);
            const extraStr  = pathMatch ? pathMatch[1] : '';

            // Parse all key=value pairs from the extra path segment
            const extra = {};
            extraStr.split('&').forEach(part => {
                const [key, val] = part.split('=');
                if (key && val) extra[decodeURIComponent(key)] = decodeURIComponent(val);
            });

            // Also check query string as fallback
            const qs = url.split('?')[1] || '';
            new URLSearchParams(qs).forEach((val, key) => {
                if (!extra[key]) extra[key] = val;
            });

            // Validate genre
            if (!extra.genre || !GENRE_MAP[extra.genre]) extra.genre = "Chronological";

            console.log(`[HTTP] catalog request extra:`, extra);

            const resp = await addonInterface.get('catalog', 'movie', 'mcu_master_list', extra);
            return res.status(200).json(resp);
        }

        return res.status(404).json({ error: "Not Found" });

    } catch (err) {
        console.error("Handler Error:", err.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};