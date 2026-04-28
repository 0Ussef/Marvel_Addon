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

const manifest = {
    id: "org.mcu.improved.search.stable",
    version: "3.2.2",
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractYear(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/\d{4}/);
    return match ? match[0] : null;
}

/**
 * FIX #2 & #5:
 * - Try search WITH year first; if 0 results, retry WITHOUT year.
 *   Episode air dates often differ from a show's premiere year, so the
 *   year-filtered query would return nothing for those rows.
 * - Sort by vote_count instead of popularity. Popularity is volatile and
 *   skews toward whatever's trending, causing unrelated hit shows to
 *   outrank obscure MCU Disney+ entries.
 */
async function getTmdbData(title, isSeries, year) {
    const type     = isSeries ? 'tv' : 'movie';
    const yearParam = isSeries ? "first_air_date_year" : "primary_release_year";

    const trySearch = async (includeYear) => {
        let url = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}`;
        if (includeYear && year) url += `&${yearParam}=${year}`;
        const res  = await fetch(url);
        const data = await res.json();
        return data.results || [];
    };

    try {
        let results = year ? await trySearch(true) : [];

        // Retry without year constraint if nothing found
        if (results.length === 0) results = await trySearch(false);
        if (results.length === 0) return { imdbId: null, poster: null };

        // Prefer the most-voted result — more stable than popularity for niche titles
        const item = results.sort((a, b) => b.vote_count - a.vote_count)[0];

        const extRes  = await fetch(`https://api.themoviedb.org/3/${type}/${item.id}/external_ids?api_key=${TMDB_KEY}`);
        const extData = await extRes.json();

        return {
            imdbId: extData.imdb_id || null,
            poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null
        };
    } catch (e) {
        console.error(`TMDB Search Error for "${title}":`, e.message);
        return { imdbId: null, poster: null };
    }
}

// ─── Catalog Handler ─────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ extra }) => {
    // FIX #1: Validate genre before using it — never let null/unknown slip through
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

        // FIX #4: Detect header rows dynamically instead of a hardcoded slice(1).
        // Header rows have no year in column 2; real data rows do (or have an empty date).
        const rows = allRows.filter((row) => {
            const col2 = row.c?.[2] ? (row.c[2].f || row.c[2].v?.toString() || "") : "";
            // Keep rows that have a 4-digit year OR have no date at all (Upcoming items)
            return /\d{4}/.test(col2) || col2 === "";
        });

        const metas = await Promise.all(
            rows.map(async (row, index) => {
                try {
                    const title   = row.c?.[1]?.v?.toString().trim() ?? null;
                    const rawDate = row.c?.[2] ? (row.c[2].f || row.c[2].v?.toString()) : null;

                    if (!title) return null;

                    const year     = extractYear(rawDate);
                    const epMatch  = title.match(/Season\s+(\d+)\s+Episode\s+(\d+)/i);
                    const isSeries = !!epMatch;

                    // Strip episode info to search for the show itself
                    const showName = isSeries
                        ? title.split(/Season\s+\d+/i)[0].trim()
                        : title;

                    const tmdb = await getTmdbData(showName, isSeries, year);

                    // FIX #3: Log missing IDs; use a clearly-labelled fallback instead
                    // of tt_local_ which silently breaks stream resolution in Stremio.
                    if (!tmdb.imdbId) {
                        console.warn(`[NO IMDB ID] "${title}" (year: ${year ?? 'unknown'})`);
                    }

                    const baseId      = tmdb.imdbId || `tt_missing_${index}`;
                    let   id          = baseId;
                    let   displayName = `#${index + 1} ${title}`;

                    if (isSeries && epMatch) {
                        const [, seasonNum, episodeNum] = epMatch;
                        displayName = `#${index + 1} E:${episodeNum} ${title}`;
                        id          = `${baseId}:${seasonNum}:${episodeNum}`;
                    }

                    return {
                        id,
                        type: isSeries ? "series" : "movie",
                        name: displayName,
                        poster: tmdb.poster || DEFAULT_POSTER,
                        description: `MCU ${genre} • ${year ?? 'Release date unknown'}`
                    };
                } catch (err) {
                    console.error(`Row ${index} processing error:`, err.message);
                    return null;
                }
            })
        );

        return { metas: metas.filter(Boolean) };

    } catch (error) {
        console.error("Catalog Handler Error:", error.message);
        return { metas: [] };
    }
});

// ─── HTTP / Vercel Handler ───────────────────────────────────────────────────

const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
        const url = req.url || '';

        // ── Manifest ──────────────────────────────────────────────────────
        if (url.endsWith('manifest.json')) {
            return res.status(200).json(addonInterface.manifest);
        }

        // ── Catalog ───────────────────────────────────────────────────────
        if (url.includes('/catalog/')) {
            // FIX #1: Stremio encodes extra params in the URL path like:
            //   /catalog/movie/mcu_master_list/genre=Release%20Order.json
            // It may also use a query string. Check both.
            let genre = null;

            const pathMatch = url.match(/\/genre=([^\/\?&]+)/);
            if (pathMatch) {
                genre = decodeURIComponent(pathMatch[1].replace(/\.json$/, ''));
            }

            if (!genre) {
                const qs = url.split('?')[1] || '';
                genre    = new URLSearchParams(qs).get('genre');
            }

            // Final validation — never forward an invalid genre to the handler
            if (!genre || !GENRE_MAP[genre]) genre = "Chronological";

            console.log(`[Catalog Request] genre="${genre}"`);

            const resp = await addonInterface.get(
                'catalog',
                'movie',
                'mcu_master_list',
                { genre }       // always a valid, non-null string
            );

            return res.status(200).json(resp);
        }

        return res.status(404).json({ error: "Not Found" });

    } catch (err) {
        console.error("Handler Error:", err.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};