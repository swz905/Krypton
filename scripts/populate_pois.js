#!/usr/bin/env node
// scripts/populate_pois.js — One-time pipeline to populate POI data
// Run: node scripts/populate_pois.js
//
// Pipeline:
//   1. Load station coordinates from our SQLite DB (railway proximity filter)
//   2. Query Wikidata SPARQL for historical sites, monuments, forts, etc.
//   3. Query Overpass API for railway bridges over rivers + tunnels
//   4. Query Wikidata for wildlife sanctuaries / national parks
//   5. Filter: keep only POIs within 20km of any railway station
//   6. Fetch Wikipedia 2-sentence extract for each POI (story text)
//   7. Write final JSON files to public/data/

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'ir.db');
const OUT_DIR = join(__dirname, '..', 'public', 'data');
const PROXIMITY_KM = 25; // keep POIs within 25km of any station

// ─── Haversine ────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Step 1: Load station grid ────────────────────────
async function loadStations() {
  console.log('[1/7] Loading station coordinates from DB...');
  const SQL = await initSqlJs();
  const buf = readFileSync(DB_PATH);
  const db = new SQL.Database(buf);
  const rows = db.exec("SELECT code, lat, lng FROM Stn WHERE lat IS NOT NULL AND lng IS NOT NULL");
  const stations = [];
  if (rows.length) {
    for (const r of rows[0].values) stations.push({ code: r[0], lat: r[1], lng: r[2] });
  }
  db.close();
  console.log(`   → ${stations.length} stations loaded`);
  return stations;
}

// Build a coarse spatial grid for fast proximity filtering
function buildGrid(stations, cellDeg = 0.5) {
  const grid = {};
  for (const s of stations) {
    const key = `${Math.floor(s.lat / cellDeg)},${Math.floor(s.lng / cellDeg)}`;
    if (!grid[key]) grid[key] = [];
    grid[key].push(s);
  }
  return { grid, cellDeg };
}

function isNearRailway(lat, lng, spatial) {
  const { grid, cellDeg } = spatial;
  const cx = Math.floor(lat / cellDeg), cy = Math.floor(lng / cellDeg);
  // Check 3x3 neighborhood
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cell = grid[`${cx + dx},${cy + dy}`];
      if (!cell) continue;
      for (const s of cell) {
        if (haversine(lat, lng, s.lat, s.lng) <= PROXIMITY_KM) return true;
      }
    }
  }
  return false;
}

// ─── HTTP helper with retries ─────────────────────────
async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000), ...opts });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp;
    } catch (err) {
      console.warn(`   ⚠ Attempt ${i + 1}/${retries} failed: ${err.message}`);
      if (i < retries - 1) await sleep(3000 * (i + 1));
      else throw err;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Step 2: Wikidata SPARQL for historical sites ─────
async function fetchHistoricalSites() {
  console.log('[2/7] Querying Wikidata for Indian historical sites...');

  const categories = [
    { type: 'battlefield', qid: 'Q178561', icon: '⚔️' },
    { type: 'fort', qid: 'Q57821', icon: '🏰' },
    { type: 'monument', qid: 'Q4989906', icon: '🏛️' },
    { type: 'ancient_city', qid: 'Q515', icon: '🏛️' },       // city — we filter to old ones
    { type: 'pilgrimage', qid: 'Q15893266', icon: '🛕' },     // religious site
    { type: 'monument', qid: 'Q839954', icon: '🏛️' },        // archaeological site
    { type: 'fort', qid: 'Q3947', icon: '🏰' },                // castle/fort
    { type: 'monument', qid: 'Q34442', icon: '🛕' },           // Hindu temple
    { type: 'monument', qid: 'Q44539', icon: '🕌' },           // mosque (historical)
    { type: 'pilgrimage', qid: 'Q16560', icon: '☸️' },         // Buddhist temple
  ];

  const allResults = [];

  for (const cat of categories) {
    const sparql = `
      SELECT DISTINCT ?place ?placeLabel ?coord ?placeDescription WHERE {
        ?place wdt:P31/wdt:P279* wd:${cat.qid} .
        ?place wdt:P17 wd:Q668 .
        ?place wdt:P625 ?coord .
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
      LIMIT 500
    `;

    try {
      const resp = await fetchWithRetry(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}`,
        { headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': 'KryptonPOIBot/1.0' } }
      );
      const json = await resp.json();
      const bindings = json?.results?.bindings || [];

      for (const b of bindings) {
        const coordStr = b.coord?.value; // "Point(lng lat)"
        if (!coordStr) continue;
        const m = coordStr.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
        if (!m) continue;

        const lng = parseFloat(m[1]);
        const lat = parseFloat(m[2]);
        const name = b.placeLabel?.value || '';
        const desc = b.placeDescription?.value || '';

        // Skip if name looks like a QID (unresolved)
        if (/^Q\d+$/.test(name)) continue;

        allResults.push({
          id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40),
          name,
          lat, lng,
          type: cat.type,
          icon: cat.icon,
          radius_km: cat.type === 'battlefield' ? 12 : 6,
          wikidata_desc: desc,
          _wiki_title: name, // for Wikipedia lookup later
        });
      }

      console.log(`   → ${cat.type} (${cat.qid}): ${bindings.length} results`);
      await sleep(1500); // respect rate limits
    } catch (err) {
      console.error(`   ✗ Failed for ${cat.type}: ${err.message}`);
    }
  }

  // Deduplicate by name
  const seen = new Set();
  const deduped = allResults.filter(p => {
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`   → ${deduped.length} unique historical sites after dedup`);
  return deduped;
}

// ─── Step 3: Overpass API for river crossings ─────────
async function fetchRiverCrossings() {
  console.log('[3/7] Querying Overpass API for railway river crossings...');

  // This query finds bridges where a railway crosses a waterway in India
  const query = `
    [out:json][timeout:120];
    area["ISO3166-1"="IN"]->.india;
    (
      way["bridge"="yes"]["railway"~"rail|narrow_gauge"](area.india);
    );
    out center tags;
  `;

  try {
    const resp = await fetchWithRetry(
      'https://overpass-api.de/api/interpreter',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      }
    );
    const json = await resp.json();
    const elements = json?.elements || [];

    // Group nearby bridges (within 5km) to avoid duplicate alerts for the same river
    const bridges = [];
    for (const el of elements) {
      const lat = el.center?.lat || el.lat;
      const lng = el.center?.lon || el.lon;
      if (!lat || !lng) continue;

      const name = el.tags?.name || el.tags?.['bridge:name'] || '';

      // Check if too close to existing bridge
      const tooClose = bridges.some(b => haversine(lat, lng, b.lat, b.lng) < 5);
      if (tooClose) continue;

      bridges.push({
        id: `bridge_${el.id}`,
        name: name || `Railway Bridge`,
        lat, lng,
        type: name ? 'bridge' : 'river',
        icon: '🌉',
        radius_km: 3,
        _wiki_title: name || null,
        _osm_id: el.id,
      });
    }

    console.log(`   → ${elements.length} raw bridges → ${bridges.length} after clustering`);
    return bridges;
  } catch (err) {
    console.error(`   ✗ Overpass query failed: ${err.message}`);
    return [];
  }
}

// ─── Step 4: Wikidata for wildlife areas ──────────────
async function fetchWildlifeAreas() {
  console.log('[4/7] Querying Wikidata for wildlife areas...');

  const categories = [
    { type: 'tiger_reserve', qid: 'Q18614948', icon: '🐯' },  // tiger reserve
    { type: 'wildlife', qid: 'Q46169', icon: '🦁' },           // national park
    { type: 'wildlife', qid: 'Q1456603', icon: '🐘' },         // wildlife sanctuary
    { type: 'bird_sanctuary', qid: 'Q473972', icon: '🦅' },    // bird sanctuary
  ];

  const allResults = [];

  for (const cat of categories) {
    const sparql = `
      SELECT DISTINCT ?place ?placeLabel ?coord ?placeDescription WHERE {
        ?place wdt:P31/wdt:P279* wd:${cat.qid} .
        ?place wdt:P17 wd:Q668 .
        ?place wdt:P625 ?coord .
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
      LIMIT 300
    `;

    try {
      const resp = await fetchWithRetry(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}`,
        { headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': 'KryptonPOIBot/1.0' } }
      );
      const json = await resp.json();
      const bindings = json?.results?.bindings || [];

      for (const b of bindings) {
        const coordStr = b.coord?.value;
        if (!coordStr) continue;
        const m = coordStr.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
        if (!m) continue;

        const lng = parseFloat(m[1]);
        const lat = parseFloat(m[2]);
        const name = b.placeLabel?.value || '';
        if (/^Q\d+$/.test(name)) continue;

        allResults.push({
          id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40),
          name, lat, lng,
          type: cat.type,
          icon: cat.icon,
          radius_km: 15,
          wikidata_desc: b.placeDescription?.value || '',
          _wiki_title: name,
        });
      }

      console.log(`   → ${cat.type} (${cat.qid}): ${bindings.length} results`);
      await sleep(1500);
    } catch (err) {
      console.error(`   ✗ Failed for ${cat.type}: ${err.message}`);
    }
  }

  const seen = new Set();
  const deduped = allResults.filter(p => {
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`   → ${deduped.length} unique wildlife areas after dedup`);
  return deduped;
}

// ─── Step 5: Filter by railway proximity ──────────────
function filterByRailway(pois, spatial, label) {
  console.log(`[5/7] Filtering ${label} by railway proximity (${PROXIMITY_KM}km)...`);
  const filtered = pois.filter(p => isNearRailway(p.lat, p.lng, spatial));
  console.log(`   → ${pois.length} → ${filtered.length} near railways`);
  return filtered;
}

// ─── Step 6: Fetch Wikipedia stories ──────────────────
async function enrichWithWikipedia(pois) {
  console.log(`[6/7] Fetching Wikipedia stories for ${pois.length} POIs...`);

  // Batch by 20 titles at a time
  const batchSize = 20;
  const storyMap = {};

  for (let i = 0; i < pois.length; i += batchSize) {
    const batch = pois.slice(i, i + batchSize).filter(p => p._wiki_title);
    if (!batch.length) continue;

    const titles = batch.map(p => p._wiki_title).join('|');
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exsentences=2&explaintext=true&redirects=1&titles=${encodeURIComponent(titles)}&format=json`;

    try {
      const resp = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'KryptonPOIBot/1.0 (train journey companion)' },
      });
      const json = await resp.json();
      const pages = json?.query?.pages || {};

      for (const page of Object.values(pages)) {
        if (page.extract && page.extract.length > 20) {
          storyMap[page.title] = page.extract.replace(/\n/g, ' ').trim();
        }
      }
    } catch (err) {
      console.warn(`   ⚠ Wikipedia batch ${i / batchSize + 1} failed: ${err.message}`);
    }

    await sleep(500); // be nice to Wikipedia
    process.stdout.write(`   → ${Math.min(i + batchSize, pois.length)}/${pois.length}\r`);
  }
  console.log();

  // Apply stories to POIs
  let enriched = 0;
  for (const p of pois) {
    const story = storyMap[p._wiki_title];
    if (story) {
      p.story = story;
      enriched++;
    } else if (p.wikidata_desc && p.wikidata_desc.length > 10) {
      p.story = p.wikidata_desc;
    } else {
      p.story = `A notable ${p.type.replace(/_/g, ' ')} located in India.`;
    }
  }

  console.log(`   → ${enriched}/${pois.length} enriched with Wikipedia stories`);
  return pois;
}

// ─── Step 7: Clean and write JSON ─────────────────────
function writeOutput(pois, filename) {
  // Remove internal fields
  const clean = pois.map(p => {
    const { _wiki_title, _osm_id, wikidata_desc, ...rest } = p;
    return rest;
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, filename);
  writeFileSync(path, JSON.stringify(clean, null, 2));
  console.log(`   → Wrote ${clean.length} POIs to ${filename}`);
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Krypton POI Data Pipeline               ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  // Step 1
  const stations = await loadStations();
  const spatial = buildGrid(stations);

  // Step 2
  const historical = await fetchHistoricalSites();

  // Step 3
  const rivers = await fetchRiverCrossings();

  // Step 4
  const wildlife = await fetchWildlifeAreas();

  // Step 5: Filter all by railway proximity
  const histFiltered = filterByRailway(historical, spatial, 'historical');
  const riverFiltered = filterByRailway(rivers, spatial, 'rivers');
  const wildFiltered = filterByRailway(wildlife, spatial, 'wildlife');

  // Step 6: Enrich with Wikipedia
  await enrichWithWikipedia(histFiltered);
  await enrichWithWikipedia(wildFiltered);
  // Rivers from Overpass usually don't have Wikipedia articles, use generic stories
  for (const r of riverFiltered) {
    if (!r.story) r.story = r.name ? `You are crossing ${r.name} — look out the window!` : 'Railway bridge crossing ahead.';
    r.icon = '🌊';
    r.type = r.name ? 'river' : 'bridge';
  }

  // Step 7: Write output
  console.log('[7/7] Writing output files...');
  writeOutput(histFiltered, 'poi_historical.json');
  writeOutput(riverFiltered, 'poi_rivers.json');
  writeOutput(wildFiltered, 'poi_wildlife.json');

  console.log();
  console.log('═══ DONE ════════════════════════════════════');
  console.log(`  Historical: ${histFiltered.length} sites`);
  console.log(`  Rivers:     ${riverFiltered.length} crossings`);
  console.log(`  Wildlife:   ${wildFiltered.length} areas`);
  console.log(`  Total:      ${histFiltered.length + riverFiltered.length + wildFiltered.length} POIs`);
}

main().catch(console.error);
