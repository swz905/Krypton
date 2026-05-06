#!/usr/bin/env node
// scripts/populate_rivers.js — Fetch river crossings from Overpass + Wikipedia
// Run: node scripts/populate_rivers.js

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'ir.db');
const OUT_DIR = join(__dirname, '..', 'public', 'data');
const PROXIMITY_KM = 25;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(60000), ...opts });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
      return resp;
    } catch (err) {
      console.warn(`   ⚠ Attempt ${i + 1}/${retries}: ${err.message}`);
      if (i < retries - 1) await sleep(5000 * (i + 1));
      else throw err;
    }
  }
}

async function main() {
  console.log('═══ Krypton River Data Pipeline ═══\n');

  // Load stations
  console.log('[1] Loading stations...');
  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(DB_PATH));
  const rows = db.exec("SELECT code, lat, lng FROM Stn WHERE lat IS NOT NULL AND lng IS NOT NULL");
  const stations = rows.length ? rows[0].values.map(r => ({ lat: r[1], lng: r[2] })) : [];
  db.close();
  console.log(`   → ${stations.length} stations`);

  // Build spatial grid
  const grid = {};
  for (const s of stations) {
    const key = `${Math.floor(s.lat / 0.5)},${Math.floor(s.lng / 0.5)}`;
    if (!grid[key]) grid[key] = [];
    grid[key].push(s);
  }

  function nearRailway(lat, lng) {
    const cx = Math.floor(lat / 0.5), cy = Math.floor(lng / 0.5);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid[`${cx + dx},${cy + dy}`];
        if (cell) for (const s of cell)
          if (haversine(lat, lng, s.lat, s.lng) <= PROXIMITY_KM) return true;
      }
    return false;
  }

  // Query Wikidata for major rivers in India with coordinates
  console.log('[2] Querying Wikidata for Indian rivers...');
  const sparql = `
    SELECT DISTINCT ?river ?riverLabel ?coord ?riverDescription WHERE {
      ?river wdt:P31/wdt:P279* wd:Q4022 .
      ?river wdt:P17 wd:Q668 .
      ?river wdt:P625 ?coord .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 500
  `;

  let rivers = [];
  try {
    const resp = await fetchWithRetry(
      `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}`,
      { headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': 'KryptonPOIBot/1.0' } }
    );
    const json = await resp.json();
    const bindings = json?.results?.bindings || [];

    for (const b of bindings) {
      const m = b.coord?.value?.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
      if (!m) continue;
      const name = b.riverLabel?.value || '';
      if (/^Q\d+$/.test(name)) continue;

      rivers.push({
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40),
        name, lat: parseFloat(m[2]), lng: parseFloat(m[1]),
        type: 'river', icon: '🌊', radius_km: 4,
        wikidata_desc: b.riverDescription?.value || '',
        _wiki_title: name,
      });
    }
    console.log(`   → ${rivers.length} rivers from Wikidata`);
  } catch (err) {
    console.error(`   ✗ Failed: ${err.message}`);
  }

  // Also query for major bridges
  console.log('[3] Querying Wikidata for Indian railway bridges...');
  const bridgeSparql = `
    SELECT DISTINCT ?bridge ?bridgeLabel ?coord ?bridgeDescription WHERE {
      ?bridge wdt:P31/wdt:P279* wd:Q12280 .
      ?bridge wdt:P17 wd:Q668 .
      ?bridge wdt:P625 ?coord .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 500
  `;

  try {
    await sleep(2000);
    const resp = await fetchWithRetry(
      `https://query.wikidata.org/sparql?query=${encodeURIComponent(bridgeSparql)}`,
      { headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': 'KryptonPOIBot/1.0' } }
    );
    const json = await resp.json();
    const bindings = json?.results?.bindings || [];

    for (const b of bindings) {
      const m = b.coord?.value?.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
      if (!m) continue;
      const name = b.bridgeLabel?.value || '';
      if (/^Q\d+$/.test(name)) continue;

      rivers.push({
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40),
        name, lat: parseFloat(m[2]), lng: parseFloat(m[1]),
        type: 'bridge', icon: '🌉', radius_km: 3,
        wikidata_desc: b.bridgeDescription?.value || '',
        _wiki_title: name,
      });
    }
    console.log(`   → ${bindings.length} bridges from Wikidata`);
  } catch (err) {
    console.error(`   ✗ Failed: ${err.message}`);
  }

  // Dedup
  const seen = new Set();
  rivers = rivers.filter(p => {
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`   → ${rivers.length} unique after dedup`);

  // Filter by railway proximity
  console.log('[4] Filtering by railway proximity...');
  rivers = rivers.filter(r => nearRailway(r.lat, r.lng));
  console.log(`   → ${rivers.length} near railways`);

  // Wikipedia enrichment with slower rate
  console.log('[5] Enriching with Wikipedia stories...');
  const batchSize = 10; // smaller batches
  const storyMap = {};

  for (let i = 0; i < rivers.length; i += batchSize) {
    const batch = rivers.slice(i, i + batchSize).filter(p => p._wiki_title);
    if (!batch.length) continue;

    const titles = batch.map(p => p._wiki_title).join('|');
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exsentences=2&explaintext=true&redirects=1&titles=${encodeURIComponent(titles)}&format=json`;

    try {
      const resp = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'KryptonPOIBot/1.0 (train journey companion)' },
      });
      const json = await resp.json();
      for (const page of Object.values(json?.query?.pages || {})) {
        if (page.extract && page.extract.length > 20) {
          storyMap[page.title] = page.extract.replace(/\n/g, ' ').trim();
        }
      }
    } catch (err) {
      console.warn(`   ⚠ Batch failed: ${err.message}`);
    }

    await sleep(1500); // 1.5s between batches
    process.stdout.write(`   → ${Math.min(i + batchSize, rivers.length)}/${rivers.length}\r`);
  }
  console.log();

  let enriched = 0;
  for (const r of rivers) {
    const story = storyMap[r._wiki_title];
    if (story) { r.story = story; enriched++; }
    else if (r.wikidata_desc && r.wikidata_desc.length > 10) r.story = r.wikidata_desc;
    else r.story = `You are crossing the ${r.name}. Look out the window!`;
  }
  console.log(`   → ${enriched}/${rivers.length} enriched`);

  // Write output
  const clean = rivers.map(({ _wiki_title, wikidata_desc, ...rest }) => rest);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'poi_rivers.json'), JSON.stringify(clean, null, 2));
  console.log(`\n═══ DONE: ${clean.length} river/bridge POIs written ═══`);
}

main().catch(console.error);
