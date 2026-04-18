const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const SHEET_BASE = "https://docs.google.com/spreadsheets/d/1Xfe--9Wshbb3ru0JplA2PnEwN7mVawazKmhWJjr_wKs/gviz/tq?tqx=out:json";

// Map Genres to Sheet Tabs
const GENRE_MAP = {
    "Chronological": `${SHEET_BASE}&sheet=Chronological%20Order`,
    "Release Order": `${SHEET_BASE}&sheet=Release%20Order`,
    "Upcoming": `${SHEET_BASE}&sheet=Upcoming`
};

const TMDB_KEY = "aca5177e4921fcdcb0ece67dc17b5bd0";

const manifest = {
    id: "org.mcu.genre.filters",
    version: "3.0.0",
    name: "MCU Ultimate Watchlist",
    description: "MCU lists grouped by Chronological, Release, and Upcoming genres.",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [
        { 
            type: "movie", 
            id: "mcu_master_list", 
            name: "MCU Ultimate",
            // This adds the Genre dropdown in Stremio
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

builder.defineCatalogHandler(async ({ id, extra }) => {
    // Default to Chronological if no genre is selected
    const genre = (extra && extra.genre) ? extra.genre : "Chronological";
    const sheetUrl = GENRE_MAP[genre];
    
    if (!sheetUrl) return { metas: [] };

    try {
        const res = await fetch(sheetUrl);
        const text = await res.text();
        const json = JSON.parse(text.substring(47).slice(0, -2));
        
        // Skip header for Release Order
        const rows = (genre === "Release Order") ? json.table.rows.slice(1) : json.table.rows;

        const groupedItems = [];
        let i = 0;

        while (i < rows.length) {
            const title = rows[i].c[1]?.v?.toString().trim();
            if (!title) { i++; continue; }

            const epMatch = title.match(/Season\s+(\d+)\s+Episode\s+(\d+)/i);
            
            if (epMatch) {
                const showName = title.split(/Season \d+/i)[0].trim();
                const season = epMatch[1];
                const startIndex = i + 1;
                let episodes = [epMatch[2]];
                let lastIdx = i;

                while (lastIdx + 1 < rows.length) {
                    const nextTitle = rows[lastIdx + 1].c[1]?.v?.toString().trim();
                    if (!nextTitle) break;
                    const nextMatch = nextTitle.match(/Season\s+(\d+)\s+Episode\s+(\d+)/i);
                    const nextShowName = nextTitle.split(/Season \d+/i)[0].trim();

                    if (nextMatch && nextShowName === showName && nextMatch[1] === season) {
                        episodes.push(nextMatch[2]);
                        lastIdx++;
                    } else {
                        break;
                    }
                }

                const endIndex = lastIdx + 1;
                const rangeLabel = startIndex === endIndex ? `#${startIndex}` : `#${startIndex}-${endIndex}`;
                const epLabel = episodes.length > 1 ? `Ep ${episodes[0]}-${episodes[episodes.length - 1]}` : `Ep ${episodes[0]}`;

                groupedItems.push({
                    searchTitle: showName,
                    displayName: `${rangeLabel} ${showName} S${season} ${epLabel}`,
                    isSeries: true,
                    playIdSuffix: `:${season}:${episodes[0]}`
                });
                i = lastIdx + 1;
            } else {
                groupedItems.push({
                    searchTitle: title,
                    displayName: `#${i + 1} ${title}`,
                    isSeries: false,
                    playIdSuffix: ""
                });
                i++;
            }
        }

        const metas = await Promise.all(groupedItems.map(async (item) => {
            const tmdb = await getTmdbData(item.searchTitle, item.isSeries);
            const baseId = tmdb.imdbId || `tt_search_${encodeURIComponent(item.searchTitle)}`;
            
            return {
                id: baseId + item.playIdSuffix,
                type: item.isSeries ? "series" : "movie",
                name: item.displayName,
                poster: tmdb.poster || "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg",
                description: `MCU [${genre}]: ${item.displayName}`
            };
        }));

        return { metas: metas.filter(Boolean) };
    } catch (error) {
        return { metas: [] };
    }
});

const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.url.endsWith('manifest.json')) return res.json(addonInterface.manifest);
    
    // Updated routing to handle genre queries (?genre=...)
    if (req.url.includes('/catalog/')) {
        const parts = req.url.split('/');
        const type = parts[2];
        const idFull = parts[3].replace('.json', '');
        
        // Parse the genre from the query string if it exists
        const queryParams = new URLSearchParams(req.url.split('?')[1]);
        const genre = queryParams.get('genre');

        const resp = await addonInterface.get('catalog', type, idFull, { genre });
        return res.json(resp);
    }
    res.status(404).send('Not Found');
};
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
    id: "org.mcu.improved.search",
    version: "3.1.0",
    name: "MCU Ultimate Watchlist",
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

/**
 * HELPER: Extract Year from Sheet Date
 */
function extractYear(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/\d{4}/);
    return match ? match[0] : null;
}

/**
 * TMDB SEARCH: Now accepts 'year' to fix mismatches like "The Defenders"
 */
async function getTmdbData(title, isSeries, year) {
    try {
        const type = isSeries ? 'tv' : 'movie';
        let searchUrl = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}`;

        // Apply Year Filter if available from the spreadsheet
        if (year) {
            const yearParam = isSeries ? "first_air_date_year" : "primary_release_year";
            searchUrl += `&${yearParam}=${year}`;
        }

        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();
        
        if (searchData.results && searchData.results.length > 0) {
            // Pick most popular result in case of multiple matches
            const item = searchData.results.sort((a, b) => b.popularity - a.popularity)[0];
            
            const extRes = await fetch(`https://api.themoviedb.org/3/${type}/${item.id}/external_ids?api_key=${TMDB_KEY}`);
            const extData = await extRes.json();
            
            return {
                imdbId: extData.imdb_id,
                poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null
            };
        }
    } catch (e) { console.error("TMDB Error:", e); }
    return { imdbId: null, poster: null };
}

builder.defineCatalogHandler(async ({ extra }) => {
    const genre = (extra && extra.genre) ? extra.genre : "Chronological";
    const sheetUrl = GENRE_MAP[genre];
    
    try {
        const res = await fetch(sheetUrl);
        const text = await res.text();
        const json = JSON.parse(text.substring(47).slice(0, -2));
        const rows = (genre === "Release Order") ? json.table.rows.slice(1) : json.table.rows;

        const metas = await Promise.all(rows.map(async (row, index) => {
            const title = row.c[1]?.v?.toString().trim();
            const rawDate = row.c[2]?.f || row.c[2]?.v?.toString(); // Get date from Col C
            if (!title) return null;

            const year = extractYear(rawDate);
            const isSeries = /Season \d+.*Episode \d+/i.test(title);
            const showName = isSeries ? title.split(/Season \d+/i)[0].trim() : title;

            // Pass the extracted year to the search
            const tmdb = await getTmdbData(showName, isSeries, year);
            const baseId = tmdb.imdbId || `tt_fake_${index}`;
            
            // Handle Series specific IDs (Season:Episode)
            let id = baseId;
            if (isSeries) {
                const epMatch = title.match(/Season\s+(\d+)\s+Episode\s+(\d+)/i);
                if (epMatch) id += `:${epMatch[1]}:${epMatch[2]}`;
            }

            return {
                id: id,
                type: isSeries ? "series" : "movie",
                name: `#${index + 1} ${title}`,
                poster: tmdb.poster || "https://platform.polygon.com/wp-content/uploads/sites/2/chorus/uploads/chorus_asset/file/16181745/marvel_studios_logo.jpg",
                description: `MCU [${genre}] • Release Year: ${year || 'N/A'}`
            };
        }));

        return { metas: metas.filter(Boolean) };
    } catch (error) {
        return { metas: [] };
    }
});

module.exports = async (req, res) => {
    const addonInterface = builder.getInterface();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('manifest.json')) return res.json(addonInterface.manifest);
    if (req.url.includes('/catalog/')) {
        const queryParams = new URLSearchParams(req.url.split('?')[1]);
        const genre = queryParams.get('genre');
        const resp = await addonInterface.get('catalog', 'movie', 'mcu_master_list', { genre });
        return res.json(resp);
    }
    res.status(404).send('Not Found');
};
