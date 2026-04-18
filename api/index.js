const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const SHEET_URL = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json&sheet=Chronological%20Order";

const manifest = {
    id: "org.mcu.vercel.list",
    version: "1.0.0",
    name: "MCU Vercel List",
    description: "Truly free MCU list from Google Sheets",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "mcu_chrono", name: "MCU: Chronological" }]
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ id }) => {
    if (id === "mcu_chrono") {
        const res = await fetch(SHEET_URL);
        const text = await res.text();
        const json = JSON.parse(text.substring(47).slice(0, -2));

        const metas = json.table.rows.map((r, i) => {
            const title = r.c[1]?.v?.toString().trim();
            if (!title) return null;
            return {
                id: `tt_search_${encodeURIComponent(title)}`,
                type: "movie",
                name: title,
                poster: "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg"
            };
        }).filter(Boolean);

        return { metas };
    }
    return { metas: [] };
});

// This is the special Vercel part
const addonInterface = builder.getInterface();
module.exports = (req, res) => {
    if (req.url.endsWith('manifest.json')) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(addonInterface.manifest);
    } else if (req.url.includes('/catalog/')) {
        const parts = req.url.split('/');
        const type = parts[parts.length - 3];
        const id = parts[parts.length - 2].split('.')[0];
        
        addonInterface.get('catalog', type, id).then(resp => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.send(resp);
        });
    } else {
        res.status(404).send('Not Found');
    }
};
