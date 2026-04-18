const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const SHEET_URL = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json&sheet=Chronological%20Order";
const TMDB_KEY = "aca5177e4921fcdcb0ece67dc17b5bd0";

const manifest = {
    id: "org.mcu.advanced.list",
    version: "1.2.0",
    name: "MCU Advanced List",
    description: "MCU List with TV/Movie detection and TMDB Posters",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [{ 
        type: "movie", 
        id: "mcu_chrono", 
        name: "MCU: Chronological",
        extra: [{ name: "search", isRequired: false }]
    }]
};

// Helper: Identify if entry is a TV show (matches your HTML logic)
const isTV = (title) => /Season \d+.*Episode \d+/i.test(title);
const getShowName = (title) => title.split(/Season \d+/i)[0].trim();

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ id }) => {
    if (id === "mcu_chrono") {
        try {
            const res = await fetch(SHEET_URL);
            const text = await res.text();
            const json = JSON.parse(text.substring(47).slice(0, -2));

            const metas = await Promise.all(json.table.rows.map(async (r) => {
                const title = r.c[1]?.v?.toString().trim();
                if (!title) return null;

                const isSeries = isTV(title);
                const searchTitle = isSeries ? getShowName(title) : title;
                const type = isSeries ? "series" : "movie";

                // We use a "search" ID so Stremio finds the streams automatically
                return {
                    id: `tt_search_${encodeURIComponent(searchTitle)}`,
                    type: type,
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

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = req.url;
    if (url.endsWith('manifest.json')) return res.json(addonInterface.manifest);
    if (url.includes('/catalog/')) {
        const match = url.match(/\/catalog\/([^/]+)\/([^/.]+)/);
        if (match) {
            const resp = await addonInterface.get('catalog', match[1], match[2]);
            return res.json(resp);
        }
    }
    res.status(404).send('Not Found');
};
