// server/routes.js — HTTP API routes
import { Router } from 'express';
import cfg from './config.js';
import * as db from './db.js';
import { refreshSnapshot, getCachedSnapshot } from './railradar.js';

const router = Router();

// Haversine distance in km
function haversine([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET /api/stations — for autocomplete
router.get('/api/stations', (req, res) => {
  res.json(db.getStationsForAutocomplete());
});

// POST /api/scan — main radar scan (find + auto-track data)
router.post('/api/scan', async (req, res) => {
  try {
    const { train_number, journey_date, ref_station, radius } = req.body;
    if (!train_number) return res.status(400).json({ error: 'Missing train number.' });

    let spatialRange = parseInt(radius) || cfg.spatialRange.default;
    spatialRange = Math.max(cfg.spatialRange.min, Math.min(spatialRange, cfg.spatialRange.max));

    const snap = await refreshSnapshot(true);
    if (snap.error) return res.status(502).json({ error: `Live snapshot failed: ${snap.error}` });

    // Find the main train in the snapshot
    const mainRow = snap.index[String(train_number)];
    let center = mainRow ? [mainRow._lat, mainRow._lng] : null;
    let centerLabel = `train ${train_number}`;

    // Fallback to reference station
    let refCode = null;
    if (!center && ref_station) {
      refCode = db.resolveStationCode(ref_station);
      if (refCode) {
        center = db.getStationCoords(refCode);
        centerLabel = refCode;
      }
    }
    if (!center) {
      return res.status(404).json({ error: 'Could not locate train. Provide a reference station.' });
    }

    // Filter snapshot by radius
    const results = [];
    for (const row of snap.rows) {
      const coords = [row._lat, row._lng];
      const dist = haversine(center, coords);
      const isRef = row._tn === String(train_number);
      if (dist > spatialRange && !isRef) continue;

      results.push({
        train_number:  row._tn,
        train_name:    row._name || 'N/A',
        coords:        coords,
        distance_km:   Math.round(dist * 10) / 10,
        is_reference:  isRef,
        current_station: row.current_station_name || row.current_station || '',
      });
    }

    results.sort((a, b) => a.distance_km - b.distance_km);

    res.json({
      message: `Found ${results.length} live trains within ${spatialRange} km of ${centerLabel}.`,
      trains: results,
      center,
      center_label: centerLabel,
      ref_station_code: refCode || train_number,
      spatial_range_km: spatialRange,
      snapshot_age_s: Math.round(Date.now() / 1000 - snap.fetchedAt),
      trains_to_track: results.map(t => t.train_number),
    });
  } catch (err) {
    console.error('[scan]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/reach — reachability analysis
router.post('/api/reach', (req, res) => {
  try {
    const { origin_station, max_hours } = req.body;
    if (!origin_station) return res.status(400).json({ error: 'Missing origin station.' });

    const code = db.resolveStationCode(origin_station);
    if (!code) return res.status(404).json({ error: `Station not found: ${origin_station}` });

    const originCoords = db.getStationCoords(code);
    if (!originCoords) return res.status(404).json({ error: `No coordinates for ${code}` });

    const maxMin = (parseInt(max_hours) || 24) * 60;
    const originName = db.getStationNames([code])[code] || code;

    // Get today's day bit
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const todayBit = db.DAY_BITS[dayNames[new Date().getDay()]];

    // BFS: find all stations reachable within maxMin
    const visited = new Map();  // stnCode → {time, trainNumber, trainName}
    visited.set(code, { time: 0, train: null, trainName: null });

    const queue = [{ stn: code, elapsed: 0 }];
    while (queue.length) {
      const { stn, elapsed } = queue.shift();

      const schedule = db.getTrainSchedule(stn);  // This doesn't work for BFS—need trains FROM this station
      // Use departure-based approach
      const departures = db.getTrainsDepartingFrom(stn, todayBit);

      for (const dep of departures) {
        const trainSch = db.getTrainSchedule(dep.trainNumber);
        // Find current station in schedule
        const stIdx = trainSch.findIndex(s => s.stnCode === stn);
        if (stIdx < 0) continue;
        const depTime = trainSch[stIdx].depAbs;
        if (depTime == null) continue;

        // Walk forward through schedule
        for (let i = stIdx + 1; i < trainSch.length; i++) {
          const stop = trainSch[i];
          if (stop.arrAbs == null) continue;
          const travelMin = stop.arrAbs - depTime;
          const totalElapsed = elapsed + Math.max(0, travelMin);
          if (totalElapsed > maxMin) break;
          if (!visited.has(stop.stnCode) || visited.get(stop.stnCode).time > totalElapsed) {
            visited.set(stop.stnCode, {
              time: totalElapsed,
              train: dep.trainNumber,
              trainName: dep.trainName,
            });
            // Only continue BFS from major stops (to avoid explosion)
            if (i < stIdx + 5) {
              queue.push({ stn: stop.stnCode, elapsed: totalElapsed });
            }
          }
        }
      }
    }

    // Build frontier (farthest reachable stations)
    const stations = [];
    for (const [stnCode, info] of visited) {
      if (stnCode === code) continue;
      const coords = db.getStationCoords(stnCode);
      if (!coords) continue;
      const name = db.getStationNames([stnCode])[stnCode] || stnCode;
      const hours = Math.floor(info.time / 60);
      const mins  = info.time % 60;
      stations.push({
        code: stnCode,
        name,
        coords,
        travel_time_min: info.time,
        travel_time_str: `${hours}h ${mins}m`,
        train_number: info.train,
        train_name: info.trainName || '',
        geo_distance_km: haversine(originCoords, coords),
      });
    }
    stations.sort((a, b) => b.geo_distance_km - a.geo_distance_km);

    res.json({
      message: `${stations.length} stations reachable within ${max_hours || 24}h from ${originName}.`,
      origin_code: code,
      origin_name: originName,
      origin_coords: originCoords,
      frontier_stations: stations.slice(0, 200),
    });
  } catch (err) {
    console.error('[reach]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
