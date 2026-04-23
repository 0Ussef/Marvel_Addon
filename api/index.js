const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const SHEET_BASE = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json";

const GENRE_MAP = {
    "Chronological": `${SHEET_BASE}&sheet=Chronological%20Order`,
    "Release Order": `${SHEET_BASE}&sheet=Release%20Order`,
    "Upcoming": `${SHEET_BASE}&sheet=Upcoming`
};

const TMDB_KEY = "aca5177e4921fcdcb0ece67dc17b5bd0";

const manifest = {
    id: "org.mcu.improved.search.stable",
    version: "3.2.1",
    name: "MCU Ultimate Watchlist",
    description: "Stable MCU list with Year-Aware TMDB Search",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [
        { 
            type: "movie", 
            id: "mcu_master_list", 
            name: "MCU Ultimate",
            extra: [{ name: "genre", options: ["Chronological", "Release Order", "Upcoming"], isRequired: false }]
        }
    ]
};

const builder = new addonBuilder(manifest);

function extractYear(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/\d{4}/);
    return match ? match[0] : null;
}

async function getTmdbData(title, isSeries, year) {
    try {
        const type = isSeries ? 'tv' : 'movie';
        let searchUrl = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}`;

        if (year) {
            const yearParam = isSeries ? "first_air_date_year" : "primary_release_year";
            searchUrl += `&${yearParam}=${year}`;
        }

        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();
        
        if (searchData.results && searchData.results.length > 0) {
            const item = searchData.results.sort((a, b) => b.popularity - a.popularity)[0];
            const extRes = await fetch(`https://api.themoviedb.org/3/${type}/${item.id}/external_ids?api_key=${TMDB_KEY}`);
            const extData = await extRes.json();
            
            return {
                imdbId: extData.imdb_id,
                poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null
            };
        }
    } catch (e) { 
        console.error(`TMDB Search Error for ${title}:`, e.message); 
    }
    return { imdbId: null, poster: null };
}

builder.defineCatalogHandler(async ({ extra }) => {
    const genre = (extra && extra.genre) ? extra.genre : "Chronological";
    const sheetUrl = GENRE_MAP[genre];
    
    try {
        const res = await fetch(sheetUrl);
        const text = await res.text();
        
        if (!text.includes("google.visualization.Query.setResponse")) {
            throw new Error("Invalid Google Sheets response");
        }

        const json = JSON.parse(text.substring(47).slice(0, -2));
        const rows = (genre === "Release Order") ? json.table.rows.slice(1) : json.table.rows;

        const metas = await Promise.all(rows.map(async (row, index) => {
            try {
                const title = row.c && row.c[1] ? row.c[1].v?.toString().trim() : null;
                const rawDate = row.c && row.c[2] ? (row.c[2].f || row.c[2].v?.toString()) : null;
                
                if (!title) return null;

                const year = extractYear(rawDate);
                const epMatch = title.match(/Season\s+(\d+)\s+Episode\s+(\d+)/i);
                const isSeries = !!epMatch;
                
                // For TMDB search: strip the Season/Episode info to find the show poster
                const showName = isSeries ? title.split(/Season \d+/i)[0].trim() : title;

                const tmdb = await getTmdbData(showName, isSeries, year);
                const baseId = tmdb.imdbId || `tt_local_${index}`;
                
                let id = baseId;
                let displayName = `#${index + 1} ${title}`;

                if (isSeries) {
                    const seasonNum = epMatch[1];
                    const episodeNum = epMatch[2];
                    
                    // Specific requested format: #1 E:1 Eyes of Wakanda Season 1 Episode 1...
                    displayName = `#${index + 1} E:${episodeNum} ${title}`;
                    
                    // Append S:E to ID for Stremio routing
                    id += `:${seasonNum}:${episodeNum}`;
                }

                return {
                    id: id,
                    type: isSeries ? "series" : "movie",
                    name: displayName,
                    poster: tmdb.poster || "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg",
                    description: `MCU ${genre} • ${year || 'Release date unknown'}`
                };
            } catch (err) {
                return null;
            }
        }));

        return { metas: metas.filter(Boolean) };
    } catch (error) {
        console.error("Addon Handler Error:", error.message);
        return { metas: [] };
    }
});

const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
        if (req.url.endsWith('manifest.json')) return res.status(200).json(addonInterface.manifest);
        
        if (req.url.includes('/catalog/')) {
            const urlParts = req.url.split('?');
            const queryParams = new URLSearchParams(urlParts[1] || "");
            const genre = queryParams.get('genre');

            const resp = await addonInterface.get('catalog', 'movie', 'mcu_master_list', { genre });
            return res.status(200).json(resp);
        }
        res.status(404).json({ error: "Not Found" });
    } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
    }
};
