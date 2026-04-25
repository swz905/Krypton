// server/railradar.js — RailRadar API client with in-memory cache
import cfg from './config.js';

const cache = {
  fetchedAt: 0,
  rows: [],
  index: {},    // trainNumber → row
  error: null,
};

export async function refreshSnapshot(force = false) {
  const now = Date.now() / 1000;
  if (!force && now - cache.fetchedAt < cfg.railradar.pollSeconds) return cache;
  if (!cfg.railradar.apiKey) {
    cache.error = 'RAILRADAR_API_KEY missing.';
    return cache;
  }

  const url = new URL(cfg.railradar.endpoint, cfg.railradar.baseUrl);
  url.searchParams.set('apiKey', cfg.railradar.apiKey);

  try {
    const resp = await fetch(url.toString(), {
      headers: {
        'User-Agent':  'Mozilla/5.0 (compatible; Krypton/2.0)',
        'Accept':      'application/json',
        'Origin':      'https://railradar.in',
        'Referer':     'https://railradar.in/',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (resp.status === 401) throw new Error('RailRadar API key rejected (401).');
    if (!resp.ok) throw new Error(`RailRadar returned ${resp.status}`);

    const payload = await resp.json();  // V8 handles deep JSON fine, no recursion issues

    let rows = [];
    if (payload?.data && Array.isArray(payload.data)) rows = payload.data;
    else if (Array.isArray(payload)) rows = payload;

    const index = {};
    const valid = [];
    for (const row of rows) {
      const tn = row.train_number ?? row.trainNumber;
      const lat = row.current_lat ?? row.latitude ?? row.lat;
      const lng = row.current_lng ?? row.longitude ?? row.lng;
      if (!tn || lat == null || lng == null) continue;
      // Normalize
      row._tn  = String(tn);
      row._lat = Number(lat);
      row._lng = Number(lng);
      row._name = row.train_name ?? row.trainName ?? '';
      valid.push(row);
      index[row._tn] = row;
    }

    cache.fetchedAt = now;
    cache.rows      = valid;
    cache.index     = index;
    cache.error     = null;
    console.log(`[railradar] Snapshot: ${valid.length} trains (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.error(`[railradar] Fetch failed: ${err.message}`);
    cache.error = err.message;
  }
  return cache;
}

export function getCachedSnapshot() {
  return cache;
}

// Background poller
let pollerStarted = false;
export function startPoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  const poll = async () => {
    await refreshSnapshot(true);
    setTimeout(poll, cfg.railradar.pollSeconds * 1000);
  };
  poll();
}
