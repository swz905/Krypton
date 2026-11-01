// server/railradar.js — RailRadar API client with in-memory cache
import cfg from './config.js';
import { ProxyAgent, fetch as undiFetch } from 'undici';

// --- Proxy dispatcher (routes outbound API calls through residential proxy) ---
const proxyDispatcher = cfg.proxyUrl ? new ProxyAgent(cfg.proxyUrl) : null;
if (proxyDispatcher) {
  // Mask credentials in log output
  const masked = cfg.proxyUrl.replace(/\/\/[^@]+@/, '//*****@');
  console.log(`[railradar] Proxy enabled: ${masked}`);
} else {
  console.log('[railradar] No proxy configured — fetching directly.');
}

/**
 * Proxy-aware fetch wrapper.
 * Uses undici's own fetch + ProxyAgent when proxy is configured,
 * falls back to Node's global fetch when not.
 */
function proxyFetch(url, opts = {}) {
  if (proxyDispatcher) {
    return undiFetch(url, { ...opts, dispatcher: proxyDispatcher });
  }
  return fetch(url, opts);
}

const cache = {
  fetchedAt: 0,
  rows: [],
  index: {},    // trainNumber → row
  error: null,
};

function firstNumber(row, keys) {
  for (const key of keys) {
    const val = row?.[key];
    if (val == null || val === '') continue;
    const num = Number(val);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

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
    const resp = await proxyFetch(url.toString(), {
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
    for (const raw of rows) {
      let row = raw;
      if (Array.isArray(raw)) {
        row = {
          train_number: raw[0],
          latitude: raw[3],
          longitude: raw[4],
          heading: raw[5],
          delayMinutes: raw[6],
          isLive: raw[7] === 1,
          current_day: raw[8],
          last_station: raw[9],
          current_distance: raw[10],
          next_station: raw[11],
        };
      }
      const tn = row.train_number ?? row.trainNumber;
      const lat = row.current_lat ?? row.latitude ?? row.lat;
      const lng = row.current_lng ?? row.longitude ?? row.lng;
      if (!tn || lat == null || lng == null) continue;
      // Normalize
      row._tn  = String(tn);
      row._lat = Number(lat);
      row._lng = Number(lng);
      row._name = row.train_name ?? row.trainName ?? '';
      row.current_day = row.current_day ?? 1;
      row._distanceKm = firstNumber(row, [
        'curr_distance',
        'current_distance',
        'distanceFromOriginKm',
        'distance_from_origin_km',
        'distance_from_origin',
        'distance',
      ]);
      row._minsSinceDep = firstNumber(row, [
        'mins_since_dep',
        'minutesSinceDeparture',
        'minutes_since_departure',
        'minsSinceDeparture',
        'running_minutes',
      ]);
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

// Per-train live data (real GPS + delay)
// Uses the new /app/v1/ endpoint which includes route coordinates
export async function fetchTrainLive(trainNumber, journeyDate) {
  const url = `https://railradar.in/app/v1/trains/${trainNumber}/live?date=${journeyDate}&includeCoordinates=true`;
  try {
    const resp = await proxyFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://railradar.in',
        'Referer': 'https://railradar.in/',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { error: `API returned ${resp.status}` };
    const json = await resp.json();
    if (!json.success || !json.data) return { error: json.message || 'No data' };

    const d = json.data;
    if (!d.isLive) return { error: 'Train not live' };

    // Interpolate current lat/lng from route + segmentProgress
    const loc = d.currentLocation || {};
    const route = d.route || [];
    let latitude = null, longitude = null;
    let distanceFromOriginKm = null;

    if (route.length > 0 && loc.sequence != null) {
      const currStop = route.find(s => s.sequence === loc.sequence);
      const nextStop = route.find(s => s.sequence > loc.sequence && s.lat != null);
      const progress = loc.segmentProgress || 0;

      if (currStop?.lat != null && nextStop?.lat != null && progress > 0) {
        // Interpolate between current and next station
        latitude  = currStop.lat + (nextStop.lat - currStop.lat) * progress;
        longitude = currStop.lng + (nextStop.lng - currStop.lng) * progress;
        if (currStop.distance != null && nextStop.distance != null) {
          distanceFromOriginKm = currStop.distance + (nextStop.distance - currStop.distance) * progress;
        }
      } else if (currStop?.lat != null) {
        // At station or no next station — use current station coords
        latitude  = currStop.lat;
        longitude = currStop.lng;
        distanceFromOriginKm = currStop.distance ?? null;
      }
    }

    if (latitude == null || longitude == null) {
      return { error: 'No coordinates available' };
    }

    let speed = null;
    if (loc.speedKmh != null && loc.speedKmh > 0) {
      speed = Math.round(loc.speedKmh);
    } else if (loc.status === 'at_station' || loc.status === 'arrived') {
      speed = 0;
    } else {
      const currStop = route.find(s => s.sequence === loc.sequence);
      if (currStop?.speedToNextStationKmph != null && currStop.speedToNextStationKmph > 0) {
        speed = Math.round(currStop.speedToNextStationKmph);
      }
    }

    // Return same shape that tracking.js expects
    return {
      trainNumber: d.trainNumber,
      trainName: d.trainName || d.train?.name || '',
      journeyDate: d.startDate,
      lastUpdated: d.lastUpdatedAt,
      location: {
        latitude,
        longitude,
        stationCode: loc.stationCode,
        status: loc.status,
        distanceFromOriginKm,
        speed,
      },
      delayMinutes: d.delayMinutes,
      dataSource: d.trackingMode,
    };
  } catch (err) {
    return { error: err.message };
  }
}


