// server/tracking.js - Socket.IO live tracking via staggered per-train API calls
import { fetchTrainLive } from './railradar.js';

function haversine([lat1, lon1], [lat2, lon2]) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const STAGGER_DELAY_MS = 2000;
const FAR_CYCLE_PAUSE_MS = 10000;
const NEAR_CYCLE_PAUSE_MS = 5000;
const IMMINENT_CYCLE_PAUSE_MS = 2000;
const LIVE_CACHE_TTL_MS = 2 * 60 * 1000;

const clients = new Map();
const liveCache = new Map();

export function setupTracking(io) {
  io.on('connection', (socket) => {
    console.log(`[ws] ${socket.id} connected`);

    socket.on('start_tracking', (data) => {
      stopClient(socket.id);

      const mainTrain = String(data.main_train || '');
      const trains = Array.from(new Set([mainTrain, ...(data.trains_to_track || []).map(String)].filter(Boolean)));
      const journeyDate = data.journey_date || new Date().toISOString().slice(0, 10);
      let refCoords = data.ref_coords;
      let closestKm = Infinity;

      console.log(`[ws] ${socket.id} tracking ${trains.length} trains (staggered, ${STAGGER_DELAY_MS}ms between calls)`);

      const abortController = new AbortController();

      const runLoop = async () => {
        while (!abortController.signal.aborted) {
          for (const tn of trains) {
            if (abortController.signal.aborted) break;

            try {
              const live = await fetchTrainLive(tn, journeyDate);
              if (live.error || !live.location) continue;

              const loc = live.location;
              const coords = [loc.latitude, loc.longitude];
              let dist = null;

              if (tn === mainTrain) {
                refCoords = coords;
              } else if (refCoords) {
                dist = haversine(refCoords, coords);
                if (Number.isFinite(dist)) closestKm = Math.min(closestKm, dist);
              }

              const prevLive = getRecentLive(tn);
              let trend = 'stable';
              if (prevLive && prevLive.distanceToReferenceKm != null && dist != null) {
                const prevDist = prevLive.distanceToReferenceKm;
                if (dist > prevDist + 0.1) trend = 'increasing';
                else if (dist < prevDist - 0.1) trend = 'decreasing';
              }

              rememberLive(tn, live, coords, dist);

              socket.emit('location_update', {
                trains: [{
                  train_number: tn,
                  train_name: live.trainNumber || tn,
                  coords,
                  distance_km: dist != null ? Math.round(dist * 10) / 10 : null,
                  trend,
                  is_reference: tn === mainTrain,
                  current_station: loc.stationCode || '',
                  status: loc.status || '',
                  delay_min: live.delayMinutes,
                }],
                updated_at: new Date().toISOString(),
                closest_km: Number.isFinite(closestKm) ? Math.round(closestKm * 10) / 10 : null,
              });
            } catch (err) {
              // Individual train fetch failed; keep the loop alive for the rest.
            }

            await sleep(STAGGER_DELAY_MS, abortController.signal);
          }

          await sleep(cyclePauseFor(closestKm), abortController.signal);
          closestKm = Infinity;
        }
      };

      runLoop().catch(() => {});

      clients.set(socket.id, { abortController });
      socket.emit('tracking_status', { status: 'started', count: trains.length });
    });

    socket.on('stop_tracking', () => {
      stopClient(socket.id);
      socket.emit('tracking_status', { status: 'stopped' });
    });

    socket.on('disconnect', () => {
      stopClient(socket.id);
      console.log(`[ws] ${socket.id} disconnected`);
    });
  });
}

export function getRecentLive(trainNumber) {
  const cached = liveCache.get(String(trainNumber));
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > LIVE_CACHE_TTL_MS) {
    liveCache.delete(String(trainNumber));
    return null;
  }
  return cached;
}

function rememberLive(trainNumber, live, coords, distanceToReferenceKm) {
  const loc = live.location || {};
  liveCache.set(String(trainNumber), {
    fetchedAt: Date.now(),
    trainNumber: String(trainNumber),
    coords,
    distanceToReferenceKm,
    stationCode: loc.stationCode || '',
    status: loc.status || '',
    distanceFromOriginKm: loc.distanceFromOriginKm ?? null,
    delayMinutes: live.delayMinutes ?? null,
    lastUpdated: live.lastUpdated || null,
  });
}

function cyclePauseFor(closestKm) {
  if (closestKm <= 15) return IMMINENT_CYCLE_PAUSE_MS;
  if (closestKm <= 50) return NEAR_CYCLE_PAUSE_MS;
  return FAR_CYCLE_PAUSE_MS;
}

function stopClient(id) {
  const c = clients.get(id);
  if (c) {
    c.abortController.abort();
    clients.delete(id);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
