// server/tracking.js — Socket.IO live tracking via per-train API (staggered)
import cfg from './config.js';
import { fetchTrainLive } from './railradar.js';

function haversine([lat1, lon1], [lat2, lon2]) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const STAGGER_DELAY_MS = 2000; // 2 seconds between each per-train API call
const CYCLE_PAUSE_MS = 10000;  // 10 second pause between full cycles

const clients = new Map(); // socketId → { abortController, trains, mainTrain, journeyDate, refCoords }

export function setupTracking(io) {
  io.on('connection', (socket) => {
    console.log(`[ws] ${socket.id} connected`);

    socket.on('start_tracking', (data) => {
      stopClient(socket.id);

      const trains = data.trains_to_track || [];
      const mainTrain = data.main_train;
      const journeyDate = data.journey_date || new Date().toISOString().slice(0, 10);
      const refCoords = data.ref_coords; // [lat, lng] of ref train

      console.log(`[ws] ${socket.id} tracking ${trains.length} trains (staggered, ${STAGGER_DELAY_MS}ms between calls)`);

      const abortController = new AbortController();

      // Start the staggered polling loop
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
              if (refCoords) dist = haversine(refCoords, coords);

              socket.emit('location_update', {
                trains: [{
                  train_number: tn,
                  train_name: live.trainNumber || tn,
                  coords,
                  distance_km: dist != null ? Math.round(dist * 10) / 10 : null,
                  is_reference: tn === mainTrain,
                  current_station: loc.stationCode || '',
                  status: loc.status || '',
                  delay_min: live.delayMinutes,
                }],
                updated_at: new Date().toISOString(),
              });
            } catch (err) {
              // Individual train fetch failed, skip
            }

            // Stagger: wait between calls to avoid spamming
            await sleep(STAGGER_DELAY_MS, abortController.signal);
          }

          // Pause between full cycles
          await sleep(CYCLE_PAUSE_MS, abortController.signal);
        }
      };

      runLoop().catch(() => {}); // Silently stop on abort

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
