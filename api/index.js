const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const SHEET_BASE = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json";

const GENRE_MAP = {
    "Chronological": `${SHEET_BASE}&sheet=Chronological%20Order`,
    "Release Order": `${SHEET_BASE}&sheet=Release%20Order`,
    "Upcoming":      `${SHEET_BASE}&sheet=Upcoming`
};

const TMDB_KEY    = "aca5177e4921fcdcb0ece67dc17b5bd0";
const RPDB_KEY    = "t0-free";                                          // ← RPDB free tier
const DEFAULT_POSTER = "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg";
const TMDB_LOW_CONFIDENCE_THRESHOLD = 10;

const manifest = {
    id: "org.mcu.improved.search.stable",
    version: "3.2.3",
    name: "MCU Ultimate Watchlist",
    description: "Stable MCU list with Year-Aware TMDB Search",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [
        {
            type: "movie",
            id: "mcu_master_list",
            name: "MCU Ultimate",
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractYear(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/\d{4}/);
    return match ? match[0] : null;
}

// ─── RPDB Poster ──────────────────────────────────────────────────────────────
// Returns a rounded-blocks RPDB poster URL for a given IMDB ID.
// Falls back to null if the ID is missing or not a real IMDB ID.

function getRpdbPoster(imdbId) {
    if (!imdbId || imdbId.startsWith('promo_')) return null;
    return `https://api.ratingposterdb.com/${RPDB_KEY}/imdb/poster-default/${imdbId}.jpg?rounded-blocks`;
}

// ─── Title Parser ─────────────────────────────────────────────────────────────

function parseTitle(title) {
    const slingshotMatch = title.match(/^(.+?)\s+Slingshot\s+Episode\s+(\d+)/i);
    if (slingshotMatch) {
        return {
            showName: `${slingshotMatch[1].trim()}: Slingshot`,
            isSeries: true,
            season: "1",
            episode: slingshotMatch[2]
        };
    }

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
        if (!isSeries && withYear && year) url += `&primary_release_year=${year}`;
        const res  = await fetch(url);
        const data = await res.json();
        return data.results || [];
    };

    try {
        let results = await search(true);

        if (!isSeries && results.length === 0 && year) {
            results = await search(false);
        }

        if (results.length === 0) {
            return { imdbId: null, poster: null, confident: false };
        }

        const item      = results.sort((a, b) => b.vote_count - a.vote_count)[0];
        const confident = (item.vote_count ?? 0) >= TMDB_LOW_CONFIDENCE_THRESHOLD;

        if (!confident) {
            console.warn(`[LOW CONFIDENCE] "${title}" — top result vote_count: ${item.vote_count}, name: ${item.title || item.name}`);
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
            console.log(`[PROMO/UNMATCHED] "${rawTitle}" — shown with placeholder ID`);
        }

        let id          = baseId;
        let displayName = `#${index + 1} ${rawTitle}`;

        if (isSeries && season && episode) {
            displayName = `#${index + 1} E:${episode} ${rawTitle}`;
            id          = `${baseId}:${season}:${episode}`;
        }

        // ── Poster priority: RPDB → TMDB → default ──────────────────────────
        const rpdbPoster = getRpdbPoster(tmdb.imdbId);
        const poster     = rpdbPoster || tmdb.poster || DEFAULT_POSTER;

        return {
            id,
            type: isSeries ? "series" : "movie",
            name: displayName,
            poster,
            description: `MCU ${genre} • ${year ?? 'Release date unknown'}`
        };

    } catch (err) {
        console.error(`Row ${index} processing error:`, err.message);
        return null;
    }
}

// ─── Catalog Handler ──────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ extra }) => {
    const genre = (extra && extra.genre && GENRE_MAP[extra.genre])
        ? extra.genre
        : "Chronological";

    const sheetUrl = GENRE_MAP[genre];

    try {
        const res  = await fetch(sheetUrl);
        const text = await res.text();

        if (!text.includes("google.visualization.Query.setResponse")) {
            throw new Error("Invalid Google Sheets response");
        }

        const json    = JSON.parse(text.substring(47).slice(0, -2));
        const allRows = json.table.rows;

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

const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
        const url = req.url || '';

        if (url.endsWith('manifest.json')) {
            return res.status(200).json(addonInterface.manifest);
        }

        if (url.includes('/catalog/')) {
            let genre = null;

            const pathMatch = url.match(/\/genre=([^\/\?&]+)/);
            if (pathMatch) {
                genre = decodeURIComponent(pathMatch[1].replace(/\.json$/, ''));
            }

            if (!genre) {
                const qs = url.split('?')[1] || '';
                genre    = new URLSearchParams(qs).get('genre');
            }

            if (!genre || !GENRE_MAP[genre]) genre = "Chronological";

            console.log(`[Catalog Request] genre="${genre}"`);

            const resp = await addonInterface.get(
                'catalog',
                'movie',
                'mcu_master_list',
                { genre }
            );

            return res.status(200).json(resp);
        }

        return res.status(404).json({ error: "Not Found" });

    } catch (err) {
        console.error("Handler Error:", err.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};