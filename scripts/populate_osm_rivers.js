#!/usr/bin/env node
// scripts/populate_osm_rivers.js — Fetches highly accurate railway bridges using OpenStreetMap

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';
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

async function main() {
  console.log('═══ OpenStreetMap Bridges Pipeline ═══\n');

  console.log('[1] Loading stations...');
  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(DB_PATH));
  const rows = db.exec("SELECT code, lat, lng FROM Stn WHERE lat IS NOT NULL AND lng IS NOT NULL");
  const stations = rows.length ? rows[0].values.map(r => ({ lat: r[1], lng: r[2] })) : [];
  db.close();

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

  console.log('[2] Querying Overpass API for railway bridges...');
  const query = `
    [out:json][timeout:180];
    area["ISO3166-1"="IN"]->.india;
    way["bridge"="yes"]["railway"~"rail|narrow_gauge"](area.india);
    out center tags;
  `;

  // We fixed the headers! OpenStreetMap Overpass requires a good User-Agent and Form-UrlEncoded content
  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'KryptonTrainTracker/1.0'
    },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!resp.ok) throw new Error(`Overpass API failed: HTTP ${resp.status}`);
  const json = await resp.json();
  const elements = json?.elements || [];
  
  let bridges = [];
  for (const el of elements) {
    const lat = el.center?.lat || el.lat;
    const lng = el.center?.lon || el.lon;
    if (!lat || !lng) continue;

    const name = el.tags?.name || el.tags?.['bridge:name'] || '';
    
    // Ignore unnamed bridges (OSM marks every tiny 5-meter ditch as a bridge)
    if (!name) continue;

    // Check if too close to an existing bridge (group them)
    const tooClose = bridges.some(b => haversine(lat, lng, b.lat, b.lng) < 3);
    if (tooClose) continue;

    bridges.push({
      id: `osm_bridge_${el.id}`,
      name: name,
      lat, lng,
      type: 'bridge',
      icon: '🌉',
      radius_km: 3,
      story: `You are crossing ${name}.`
    });
  }

  console.log(`   → ${bridges.length} unique bridges found`);

  bridges = bridges.filter(b => nearRailway(b.lat, b.lng));
  console.log(`   → ${bridges.length} near railway stations`);

  // Merge with existing rivers from Wikidata so we don't lose the big ones
  console.log('[3] Merging with existing Wikidata rivers...');
  const existingPath = join(OUT_DIR, 'poi_rivers.json');
  let existing = [];
  try { existing = JSON.parse(readFileSync(existingPath, 'utf8')); } catch {}
  
  for (const b of bridges) {
    // Only add if not super close to an existing Wikidata river
    if (!existing.some(e => haversine(e.lat, e.lng, b.lat, b.lng) < 5)) {
      existing.push(b);
    }
  }

  writeFileSync(existingPath, JSON.stringify(existing, null, 2));
  console.log(`\n═══ DONE: Wrote ${existing.length} total crossings to poi_rivers.json ═══`);
}
main().catch(console.error);
