const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const SHEET_URL = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json&sheet=Chronological%20Order";
const TMDB_KEY = "aca5177e4921fcdcb0ece67dc17b5bd0";

const manifest = {
    id: "org.mcu.final.fixed",
    version: "1.3.0",
    name: "MCU Playable List",
    description: "Fixed list that actually plays movies",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "mcu_chrono", name: "MCU: Chronological" }]
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
            return extData.imdb_id; // Returns the real "tt1234567"
        }
    } catch (e) { console.error(e); }
    return null;
}

builder.defineCatalogHandler(async ({ id }) => {
    if (id === "mcu_chrono") {
        const res = await fetch(SHEET_URL);
        const text = await res.text();
        const json = JSON.parse(text.substring(47).slice(0, -2));

        const metas = await Promise.all(json.table.rows.slice(0, 40).map(async (r) => {
            const title = r.c[1]?.v?.toString().trim();
            if (!title) return null;

            const isSeries = /Season \d+.*Episode \d+/i.test(title);
            const searchTitle = isSeries ? title.split(/Season \d+/i)[0].trim() : title;
            
            // Get the real ID so it actually plays
            const realId = await getRealId(searchTitle, isSeries);

            return {
                id: realId || `tt_search_${encodeURIComponent(searchTitle)}`,
                type: isSeries ? "series" : "movie",
                name: title,
                poster: "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg"
            };
        }));

        return { metas: metas.filter(Boolean) };
    }
    return { metas: [] };
});

const addonInterface = builder.getInterface();
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.endsWith('manifest.json')) return res.json(addonInterface.manifest);
    if (req.url.includes('/catalog/')) {
        const match = req.url.match(/\/catalog\/([^/]+)\/([^/.]+)/);
        if (match) {
            const resp = await addonInterface.get('catalog', match[1], match[2]);
            return res.json(resp);
        }
    }
    res.status(404).send('Not Found');
};
