const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

// Configuration
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json&sheet=Chronological%20Order";
const TMDB_KEY = "aca5177e4921fcdcb0ece67dc17b5bd0";

const manifest = {
    id: "org.mcu.playable.chrono",
    version: "1.5.0",
    name: "MCU Playable List",
    description: "Auto-syncing MCU list with playable IMDb links",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [{ 
        type: "movie", 
        id: "mcu_chrono", 
        name: "MCU: Chronological" 
    }]
};

const builder = new addonBuilder(manifest);

// Helper to get real IMDb ID from TMDB
async function getRealId(title, isSeries) {
    try {
        const type = isSeries ? 'tv' : 'movie';
        const searchRes = await fetch(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}`);
        const searchData = await searchRes.json();
        
        if (searchData.results && searchData.results.length > 0) {
            const tmdbId = searchData.results[0].id;
            const extRes = await fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${TMDB_KEY}`);
            const extData = await extRes.json();
            return extData.imdb_id;
        }
    } catch (e) { console.error("TMDB Error:", e); }
    return null;
}

builder.defineCatalogHandler(async ({ id }) => {
    if (id === "mcu_chrono") {
        try {
            const res = await fetch(SHEET_URL);
            const text = await res.text();
            const json = JSON.parse(text.substring(47).slice(0, -2));

            const metas = await Promise.all(json.table.rows.map(async (r) => {
                const title = r.c[1]?.v?.toString().trim();
                if (!title) return null;

                // Regex to find Season and Episode numbers
                const epMatch = title.match(/Season\s+(\d+)\s+Episode\s+(\d+)/i);
                const isSeries = !!epMatch;
                const searchTitle = isSeries ? title.split(/Season \d+/i)[0].trim() : title;
                
                const realId = await getRealId(searchTitle, isSeries);

                // For TV Shows, use the format ID:Season:Episode
                let finalId = realId || `tt_search_${encodeURIComponent(searchTitle)}`;
                if (isSeries && realId) {
                    finalId = `${realId}:${parseInt(epMatch[1])}:${parseInt(epMatch[2])}`;
                }

                return {
                    id: finalId,
                    type: isSeries ? "series" : "movie",
                    name: title,
                    poster: "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg",
                    description: isSeries ? `TV Show: ${searchTitle}` : `Movie: ${title}`
                };
            }));

            return { metas: metas.filter(Boolean) };
        } catch (error) {
            return { metas: [] };
        }
    }
    return { metas: [] };
});

const addonInterface = builder.getInterface();

// Vercel Serverless Function Export
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    const url = req.url;

    if (url.endsWith('manifest.json')) {
        return res.json(addonInterface.manifest);
    } 
    
    if (url.includes('/catalog/')) {
        const match = url.match(/\/catalog\/([^/]+)\/([^/.]+)/);
        if (match) {
            const resp = await addonInterface.get('catalog', match[1], match[2]);
            return res.json(resp);
        }
    }

    res.status(404).send('Not Found');
};
