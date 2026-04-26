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
// POST /api/events — crossing & overtake prediction
router.post('/api/events', async (req, res) => {
  try {
    const { train_number } = req.body;
    if (!train_number) return res.status(400).json({ error: 'Missing train number.' });

    const snap = await refreshSnapshot();
    if (snap.error) return res.status(502).json({ error: snap.error });

    const refRow = snap.index[String(train_number)];
    if (!refRow) return res.status(404).json({ error: `Train ${train_number} not found in live snapshot.` });

    // 1. Get reference train's full schedule
    const refSchedule = db.getTrainSchedule(String(train_number));
    if (!refSchedule.length) return res.status(404).json({ error: `No schedule found for ${train_number}.` });

    // 2. Find current position via RailRadar current_station
    const currentStn = refRow.current_station || '';
    let currentIdx = refSchedule.findIndex(s => s.stnCode === currentStn);
    if (currentIdx < 0) {
      const refKm = refRow.curr_distance;
      if (refKm != null) {
        let bestDiff = Infinity;
        refSchedule.forEach((s, i) => {
          const diff = Math.abs((s.km || 0) - refKm);
          if (diff < bestDiff) { bestDiff = diff; currentIdx = i; }
        });
      }
    }
    if (currentIdx < 0) currentIdx = 0;

    // 3. Future stations
    const futureStops = refSchedule.slice(currentIdx + 1);
    if (!futureStops.length) return res.json({ events: [], message: 'Train near destination.' });

    const futureStationCodes = futureStops.map(s => s.stnCode);

    // Reference train's current abs position & ETA at each future station
    const refDepAbs = refSchedule[0].depAbs || 0;
    const refCurrentAbs = refDepAbs + (refRow.mins_since_dep || 0);
    const refDirUp = (refSchedule[refSchedule.length - 1].km || 0) > (refSchedule[0].km || 0);

    // refETA[stnCode] = minutes from NOW until ref arrives at that station
    const refETA = {};
    for (const s of futureStops) {
      if (s.arrAbs != null) refETA[s.stnCode] = s.arrAbs - refCurrentAbs;
    }

    // 4. Find candidate trains at future stations (only running ones)
    const candidates = db.getTrainsAtStations(futureStationCodes, String(train_number));
    const runningTrains = new Set(snap.rows.map(r => r._tn));

    // Group by train
    const trainStops = {};
    for (const c of candidates) {
      if (!runningTrains.has(c.trainNumber)) continue;
      if (!trainStops[c.trainNumber]) trainStops[c.trainNumber] = [];
      trainStops[c.trainNumber].push(c);
    }

    // 5. Detect events using ETA comparison
    const events = [];
    const EVENT_WINDOW = 15;  // ±15 minutes
    const MAX_LOOKAHEAD = 4 * 60; // 4 hours

    // Cache other trains' currentAbs to avoid re-computing
    const otherCurrentAbsCache = {};

    for (const [otherTn, stops] of Object.entries(trainStops)) {
      const otherRow = snap.index[otherTn];
      if (!otherRow) continue;

      // Compute other train's currentAbs (its depAbs + mins_since_dep)
      if (!(otherTn in otherCurrentAbsCache)) {
        const otherSch = db.getTrainSchedule(otherTn);
        const otherDepAbs = otherSch.length ? (otherSch[0].depAbs || 0) : 0;
        otherCurrentAbsCache[otherTn] = {
          currentAbs: otherDepAbs + (otherRow.mins_since_dep || 0),
          dirUp: otherSch.length >= 2
            ? (otherSch[otherSch.length - 1].km || 0) > (otherSch[0].km || 0)
            : true,
        };
      }
      const { currentAbs: otherCurrentAbs, dirUp: otherDirUp } = otherCurrentAbsCache[otherTn];
      const sameDirection = refDirUp === otherDirUp;

      for (const stop of stops) {
        const refEtaMin = refETA[stop.stnCode];
        if (refEtaMin == null || stop.arrAbs == null) continue;

        // Other train's ETA at this station (minutes from NOW)
        const otherEtaMin = stop.arrAbs - otherCurrentAbs;

        // Both ETAs should be in the future and within lookahead
        if (refEtaMin < -5 || refEtaMin > MAX_LOOKAHEAD) continue;
        if (otherEtaMin < -30) continue; // other already passed long ago

        // Gap = how close in time they arrive at the same station
        const gap = otherEtaMin - refEtaMin;
        if (Math.abs(gap) > EVENT_WINDOW) continue;

        const stnCoords = db.getStationCoords(stop.stnCode);
        const stnName = db.getStationNames([stop.stnCode])[stop.stnCode] || stop.stnCode;

        let eventType = 'CROSS';
        if (sameDirection) {
          eventType = gap > 0 ? 'OVERTAKE' : 'OVERTAKEN';
        }

        events.push({
          type:           eventType,
          other_train:    otherTn,
          other_name:     otherRow._name || 'N/A',
          station_code:   stop.stnCode,
          station_name:   stnName,
          station_coords: stnCoords,
          gap_min:        Math.round(gap),
          mins_until:     Math.max(0, Math.round(refEtaMin)),
          same_direction: sameDirection,
        });
      }
    }

    // De-duplicate: keep only closest event per other train
    const bestPerTrain = {};
    for (const e of events) {
      const key = e.other_train;
      if (!bestPerTrain[key] || e.mins_until < bestPerTrain[key].mins_until) {
        bestPerTrain[key] = e;
      }
    }
    const deduped = Object.values(bestPerTrain);
    deduped.sort((a, b) => a.mins_until - b.mins_until);

    for (const e of deduped) {
      if (e.mins_until <= 5)       e.urgency = 'imminent';
      else if (e.mins_until <= 15) e.urgency = 'soon';
      else if (e.mins_until <= 60) e.urgency = 'watch';
      else                         e.urgency = 'far';
    }

    res.json({
      message: `${deduped.length} crossing/overtake events detected.`,
      train_number: String(train_number),
      current_station: currentStn,
      events: deduped,
    });
  } catch (err) {
    console.error('[events]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
