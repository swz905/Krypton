// server/tracking.js — Socket.IO live tracking
import cfg from './config.js';
import * as db from './db.js';
import { refreshSnapshot } from './railradar.js';

// Haversine
function haversine([lat1, lon1], [lat2, lon2]) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const clients = new Map(); // socketId → { interval, trainNumbers, refCode, range, mainTrain }

export function setupTracking(io) {
  io.on('connection', (socket) => {
    console.log(`[ws] ${socket.id} connected`);

    socket.on('start_tracking', (data) => {
      // Stop existing
      stopClient(socket.id);

      const trains  = new Set(data.trains_to_track || []);
      const refCode = data.ref_station_code;
      const range   = data.spatial_range_km;
      const main    = data.main_train;

      console.log(`[ws] ${socket.id} tracking ${trains.size} trains`);

      const interval = setInterval(async () => {
        try {
          const snap = await refreshSnapshot();
          if (snap.error) {
            socket.emit('tracking_status', { status: 'error', message: snap.error });
            return;
          }

          const refCoords = refCode ? db.getStationCoords(refCode) : null;
          const updated = [];

          for (const row of snap.rows) {
            if (!trains.has(row._tn)) continue;
            const coords = [row._lat, row._lng];
            let dist = null;
            if (refCoords) dist = haversine(refCoords, coords);

            // Skip if out of range (but always keep main train)
            if (range && dist != null && dist > range && row._tn !== main) continue;

            updated.push({
              train_number:    row._tn,
              train_name:      row._name || 'N/A',
              coords,
              distance_km:     dist != null ? Math.round(dist * 10) / 10 : null,
              is_reference:    row._tn === main,
              current_station: row.current_station_name || row.current_station || '',
            });
          }

          socket.emit('location_update', {
            trains:   updated,
            updated_at: new Date().toISOString(),
          });
        } catch (err) {
          console.error(`[ws] ${socket.id} tick error:`, err.message);
        }
      }, cfg.liveUpdateInterval * 1000);

      clients.set(socket.id, { interval, trains, refCode, range, main });
      socket.emit('tracking_status', { status: 'started', message: 'Live tracking started.' });
    });

    socket.on('stop_tracking', () => {
      stopClient(socket.id);
      socket.emit('tracking_status', { status: 'stopped', message: 'Tracking stopped.' });
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
    clearInterval(c.interval);
    clients.delete(id);
  }
}
