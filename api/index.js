const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const SHEET_BASE = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json";

const CATALOGS = {
    "mcu_chronological": {
        name: "MCU Chronological",
        url: `${SHEET_BASE}&sheet=Chronological%20Order`
    },
    "mcu_release": {
        name: "MCU Release Order",
        url: `${SHEET_BASE}&sheet=Release%20Order`
    },
    "mcu_upcoming": {
        name: "MCU Upcoming",
        url: `${SHEET_BASE}&sheet=Upcoming`
    }
};

const TMDB_KEY             = "aca5177e4921fcdcb0ece67dc17b5bd0";
const DEFAULT_POSTER       = "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg";
const TMDB_LOW_CONFIDENCE  = 10;

// ─── Manifest ─────────────────────────────────────────────────────────────────

const manifest = {
    id: "org.mcu.improved.search.stable",
    version: "3.3.4", // Incremented version
    name: "MCU Ultimate Watchlist",
    description: "MCU lists with precise S:X E:Y formatting",
    resources: ["catalog"],
    types: ["movie", "series"],
    // Map catalogs to BOTH "movie" and "series" so Stremio can load them in both sections
    catalogs: [
        ...Object.entries(CATALOGS).map(([id, { name }]) => ({
            type: "movie",
            id,
            name
        })),
        ...Object.entries(CATALOGS).map(([id, { name }]) => ({
            type: "series",
            id,
            name
        }))
    ]
};

const builder = new addonBuilder(manifest);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractYear(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/\d{4}/);
    return match ? match[0] : null;
}

// Formats the poster link using the requested EasyRatingsDB endpoint structure
function getEasyRatingsPoster(isSeries, tmdbId) {
    if (!tmdbId) return null;
    const type = isSeries ? 'tv' : 'movie';
    return `https://easyratingsdb.com/Tk-629ea1caa0bf7de91711135f7d1d47632f3e402b396c4d83/poster/tmdb:${type}:${tmdbId}.jpg`;
}

// ─── Title Parser ─────────────────────────────────────────────────────────────

function parseTitle(title) {
    // Check for "Slingshot" style episodes
    const slingshotMatch = title.match(/^(.+?)\s+Slingshot\s+Episode\s+(\d+)/i);
    if (slingshotMatch) {
        return {
            showName: `${slingshotMatch[1].trim()}: Slingshot`,
            isSeries: true,
            season: "1",
            episode: slingshotMatch[2]
        };
    }

    // Check for "Season X Episode Y" style titles
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

// ─── TMDB Search ──────────────────────────────────────────────────────────────

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
        if (!isSeries && results.length === 0 && year) results = await search(false);
        if (results.length === 0) return { imdbId: null, tmdbId: null, poster: null, confident: false };

        const item      = results.sort((a, b) => b.vote_count - a.vote_count)[0];
        const confident = (item.vote_count ?? 0) >= TMDB_LOW_CONFIDENCE;

        if (!confident) return { imdbId: null, tmdbId: null, poster: null, confident: false };

        const extRes  = await fetch(`https://api.themoviedb.org/3/${type}/${item.id}/external_ids?api_key=${TMDB_KEY}`);
        const extData = await extRes.json();

        return {
            imdbId: extData.imdb_id || null,
            tmdbId: item.id || null,
            poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
            confident: true
        };
    } catch (e) {
        return { imdbId: null, tmdbId: null, poster: null, confident: false };
    }
}

// ─── Row Processor ────────────────────────────────────────────────────────────

async function processRow(row, index, catalogName) {
    try {
        const rawTitle = row.c?.[1]?.v?.toString().trim() ?? null;
        const rawDate  = row.c?.[2] ? (row.c[2].f || row.c[2].v?.toString()) : null;

        if (!rawTitle) return null;

        const year = extractYear(rawDate);
        const { showName, isSeries, season, episode } = parseTitle(rawTitle);
        const tmdb = await getTmdbData(showName, isSeries, year);

        const baseId = (tmdb.confident && tmdb.imdbId) ? tmdb.imdbId : `promo_${index}`;
        
        let id = baseId;
        let displayName = `#${index + 1} ${rawTitle}`;

        // SPECIFIC SYNTAX: #Index S:Season E:Episode Original Title
        if (isSeries && season && episode) {
            displayName = `#${index + 1} S:${season} E:${episode} ${rawTitle}`;
            id = `${baseId}:${season}:${episode}`;
        }

        // Apply new EasyRatings API Poster format, falls back to tmdb poster, then default image
        const poster = getEasyRatingsPoster(isSeries, tmdb.tmdbId) || tmdb.poster || DEFAULT_POSTER;

        return {
            id,
            type: isSeries ? "series" : "movie",
            name: displayName,
            poster,
            description: `MCU ${catalogName} • ${year ?? 'TBA'}`
        };

    } catch (err) {
        return null;
    }
}

// ─── Sheet Fetcher ────────────────────────────────────────────────────────────

async function fetchCatalog(catalogId) {
    const catalog = CATALOGS[catalogId];
    if (!catalog) return [];

    const res  = await fetch(catalog.url);
    const text = await res.text();
    const json = JSON.parse(text.substring(47).slice(0, -2));
    const allRows = json.table.rows;

    const rows = allRows.filter((row) => {
        const title = row.c?.[1]?.v?.toString().trim() || "";
        const date  = row.c?.[2] ? (row.c[2].f || row.c[2].v?.toString() || "") : "";
        const hasYear = /\d{4}/.test(date);
        const isLegitTitle = title.length > 0 && !title.toLowerCase().includes("phase");
        
        return catalogId === "mcu_upcoming" ? isLegitTitle : (isLegitTitle && hasYear);
    });

    const metas = await Promise.all(
        rows.map((row, index) => processRow(row, index, catalog.name))
    );

    return metas.filter(Boolean);
}

// ─── Catalog Handler ──────────────────────────────────────────────────────────

builder.defineCatalogHandler(async (args) => {
    if (!CATALOGS[args.id]) return { metas: [] };
    try {
        const metas = await fetchCatalog(args.id);
        // Filter catalog metas depending on whether the catalog requested is for "movie" or "series"
        return { metas: metas.filter(meta => meta.type === args.type) };
    } catch (error) {
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
        if (url.endsWith('manifest.json')) return res.status(200).json(addonInterface.manifest);

        if (url.includes('/catalog/')) {
            // Regex updated to accept both /movie/ and /series/ types
            const idMatch = url.match(/\/catalog\/(movie|series)\/([^\/\?]+?)(?:\/|\.json)/);
            const contentType = idMatch ? idMatch[1] : null;
            const catalogId = idMatch ? decodeURIComponent(idMatch[2]) : null;
            
            if (!catalogId || !CATALOGS[catalogId]) return res.status(200).json({ metas: [] });

            const resp = await addonInterface.get('catalog', contentType, catalogId, {});
            return res.status(200).json(resp);
        }
        return res.status(404).json({ error: "Not Found" });
    } catch (err) {
        return res.status(500).json({ error: "Internal Error" });
    }
};
