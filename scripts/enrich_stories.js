#!/usr/bin/env node
// scripts/enrich_stories.js — Resumes Wikipedia enrichment for POIs with weak/missing stories

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'data');

const files = ['poi_historical.json', 'poi_wildlife.json', 'poi_rivers.json'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { 
        headers: { 'User-Agent': 'KryptonBot/1.0 (train-tracker-app)' },
        signal: AbortSignal.timeout(10000)
      });
      if (resp.status === 429) throw new Error('HTTP 429 Too Many Requests');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      if (i < retries - 1) {
        await sleep(3000 * (i+1)); // Backoff longer to avoid rate limits
      } else {
        throw err;
      }
    }
  }
}

// Identify stories that are just generic Wikidata descriptions
function isWeakStory(story) {
  if (!story) return true;
  if (story.length < 50) return true;
  const lower = story.toLowerCase();
  if (lower.includes('notable battlefield') || lower.includes('national park in') || 
      lower.includes('fort in ') || lower.includes('building in ') || 
      lower.includes('historic site in') || lower.includes('crossing the')) {
    return true;
  }
  return false;
}

async function main() {
  console.log('═══ Resuming Wikipedia Enrichment ═══\\n');

  for (const file of files) {
    const path = join(OUT_DIR, file);
    let data;
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }

    const toEnrich = data.filter(p => isWeakStory(p.story) && p.name && !p.name.includes('Railway Bridge'));
    if (toEnrich.length === 0) {
      console.log(`✅ ${file}: All stories look good!`);
      continue;
    }
    
    console.log(`📄 ${file}: ${toEnrich.length}/${data.length} need enrichment`);

    let enrichedCount = 0;
    const batchSize = 5; // Very small batch to avoid Wikipedia 429 errors

    for (let i = 0; i < toEnrich.length; i += batchSize) {
      const batch = toEnrich.slice(i, i + batchSize);
      const titles = batch.map(p => p.name).join('|');
      const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exsentences=2&explaintext=true&redirects=1&titles=${encodeURIComponent(titles)}&format=json`;

      try {
        const json = await fetchWithRetry(url);
        const pages = json?.query?.pages || {};
        
        for (const p of batch) {
          // Find matching page by title
          const page = Object.values(pages).find(pg => pg.title?.toLowerCase() === p.name.toLowerCase() || pg.title?.toLowerCase().includes(p.name.toLowerCase()));
          if (page && page.extract && page.extract.length > 30) {
            p.story = page.extract.replace(/\\n/g, ' ').trim();
            enrichedCount++;
          }
        }
      } catch (err) {
        // Ignore failures, we save progress anyway
      }

      process.stdout.write(`   → Processed ${Math.min(i + batchSize, toEnrich.length)}/${toEnrich.length} | Found ${enrichedCount} new stories\\r`);
      writeFileSync(path, JSON.stringify(data, null, 2)); // Save progressively!
      await sleep(2000); // Wait 2s between batches to avoid 429
    }
    
    console.log(`\\n   ✅ Enriched ${enrichedCount} new stories in ${file}\\n`);
  }
}

main().catch(console.error);
