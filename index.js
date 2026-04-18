const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

// Your Google Sheet URL
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json&sheet=Chronological%20Order";

const manifest = {
    id: "org.mcu.chronological.list",
    version: "1.0.0",
    name: "MCU Chronological (Auto)",
    description: "Syncs directly from your MCU Google Sheet",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [
        {
            type: "movie",
            id: "mcu_chrono",
            name: "MCU: Chronological"
        }
    ]
};

const builder = new addonBuilder(manifest);

// Logic to fetch and format your Sheet data
async function getMoviesFromSheet() {
    try {
        const res = await fetch(SHEET_URL);
        const text = await res.text();
        const json = JSON.parse(text.substring(47).slice(0, -2));

        return json.table.rows.map((r) => {
            const title = r.c[1]?.v?.toString().trim();
            if (!title) return null;

            return {
                // We use 'name' as the ID so Stremio attempts to search for it
                id: `tt_search_${encodeURIComponent(title)}`, 
                type: "movie",
                name: title,
                poster: "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg", 
                description: "MCU Movie from your custom list"
            };
        }).filter(Boolean);
    } catch (e) {
        console.error("Error fetching sheet:", e);
        return [];
    }
}

// Handler for Stremio
builder.defineCatalogHandler(async ({ type, id }) => {
    if (id === "mcu_chrono") {
        const metas = await getMoviesFromSheet();
        return { metas: metas };
    }
    return { metas: [] };
});

// Start server
const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: port });
