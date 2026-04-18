const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const SHEET_URL = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json&sheet=Chronological%20Order";
const TMDB_KEY = "aca5177e4921fcdcb0ece67dc17b5bd0";

const manifest = {
    id: "org.mcu.numbered.list",
    version: "1.7.0",
    name: "MCU Numbered List",
    description: "Numbered MCU list with real posters and playable streams",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [{ 
        type: "movie", 
        id: "mcu_chrono", 
        name: "MCU: Chronological" 
    }]
};

const builder = new addonBuilder(manifest);

async function getTmdbData(title, isSeries) {
    try {
        const type = isSeries ? 'tv' : 'movie';
        const searchRes = await fetch(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}`);
        const searchData = await searchRes.json();
        
        if (searchData.results && searchData.results.length > 0) {
            const item = searchData.results[0];
            const tmdbId = item.id;
            const posterPath = item.poster_path;
            
            const extRes = await fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${TMDB_KEY}`);
            const extData = await extRes.json();
            
            return {
                imdbId: extData.imdb_id,
                poster: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null
            };
        }
    } catch (e) { console.error("TMDB Error:", e); }
    return { imdbId: null, poster: null };
}

builder.defineCatalogHandler(async ({ id }) => {
    if (id === "mcu_chrono") {
        try {
            const res = await fetch(SHEET_URL);
            const text = await res.text();
            const json = JSON.parse(text.substring(47).slice(0, -2));

            // Use the index (i) to add numbers
            const metas = await Promise.all(json.table.rows.map(async (r, i) => {
                const title = r.c[1]?.v?.toString().trim();
                if (!title) return null;

                const epMatch = title.match(/Season\s+(\d+)\s+Episode\s+(\d+)/i);
                const isSeries = !!epMatch;
                const searchTitle = isSeries ? title.split(/Season \d+/i)[0].trim() : title;
                
                const tmdb = await getTmdbData(searchTitle, isSeries);

                let finalId = tmdb.imdbId || `tt_search_${encodeURIComponent(searchTitle)}`;
                if (isSeries && tmdb.imdbId) {
                    finalId = `${tmdb.imdbId}:${parseInt(epMatch[1])}:${parseInt(epMatch[2])}`;
                }

                // Added # and index to the name property
                return {
                    id: finalId,
                    type: isSeries ? "series" : "movie",
                    name: `#${i + 1} ${title}`, 
                    poster: tmdb.poster || "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg",
                    description: isSeries ? `Part ${i + 1}: ${searchTitle}` : `Part ${i + 1}: ${title}`
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
