// server/routes.js — HTTP API routes
import { Router } from 'express';
import cfg from './config.js';
import * as db from './db.js';
import { refreshSnapshot, getCachedSnapshot, fetchTrainLive } from './railradar.js';

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

// ─────────────────────────────────────────────────────
// POST /api/scan — Find trains sharing future stations
// ─────────────────────────────────────────────────────
router.post('/api/scan', async (req, res) => {
  try {
    const { train_number, journey_date } = req.body;
    if (!train_number) return res.status(400).json({ error: 'Missing train number.' });

    // 1. Get REAL live position of the reference train
    const jDate = journey_date || new Date().toISOString().slice(0, 10);
    const live = await fetchTrainLive(String(train_number), jDate);
    if (live.error) return res.status(404).json({ error: `Live data failed: ${live.error}` });

    const loc = live.location;
    if (!loc) return res.status(404).json({ error: 'No location data for this train.' });

    const refCoords = [loc.latitude, loc.longitude];
    const refStation = loc.stationCode;

    // 2. Get ref train's full schedule & find current position in it
    const refSchedule = db.getTrainSchedule(String(train_number));
    if (!refSchedule.length) return res.status(404).json({ error: `No schedule for ${train_number}.` });

    let currentIdx = refSchedule.findIndex(s => s.stnCode === refStation);
    if (currentIdx < 0) {
      // Fallback: match by km
      const refKm = loc.distanceFromOriginKm;
      if (refKm != null) {
        let bestDiff = Infinity;
        refSchedule.forEach((s, i) => {
          const diff = Math.abs((s.km || 0) - refKm);
          if (diff < bestDiff) { bestDiff = diff; currentIdx = i; }
        });
      }
    }
    if (currentIdx < 0) currentIdx = 0;

    // 3. Future stations (everything ahead)
    const futureStops = refSchedule.slice(currentIdx);
    const futureStationCodes = futureStops.map(s => s.stnCode);
    if (!futureStationCodes.length) {
      return res.json({ message: 'Train near destination.', trains: [], events: [] });
    }

    // 4. From bulk map, find all RUNNING trains that pass through those future stations
    const snap = await refreshSnapshot();
    if (snap.error) return res.status(502).json({ error: snap.error });

    const candidates = db.getTrainsAtStations(futureStationCodes, String(train_number));
    const runningTrains = new Set(snap.rows.map(r => r._tn));

    // Unique running trains where the common station is still AHEAD of them
    const relevantTrainNums = new Set();
    for (const c of candidates) {
      if (!runningTrains.has(c.trainNumber)) continue;
      const row = snap.index[c.trainNumber];
      if (!row) continue;
      // Check: has this train already passed the common station?
      // row.curr_distance = how far the train has traveled from its origin (km)
      // c.km = the common station's km in this train's schedule
      const trainKm = row.curr_distance;
      if (trainKm != null && c.km != null && trainKm > c.km + 5) continue; // already passed (+5km tolerance)
      relevantTrainNums.add(c.trainNumber);
    }

    // 5. Build results — only the relevant trains
    const results = [];

    // Add the reference train itself (with real GPS)
    const refStnName = db.getStationNames([refStation])[refStation] || refStation;
    results.push({
      train_number: String(train_number),
      train_name: snap.index[String(train_number)]?._name || 'Your Train',
      coords: refCoords,
      distance_km: 0,
      is_reference: true,
      current_station: refStnName,
      delay_min: live.delayMinutes,
      status: loc.status,
    });

    for (const tn of relevantTrainNums) {
      const row = snap.index[tn];
      if (!row) continue;
      const coords = [row._lat, row._lng];
      const dist = haversine(refCoords, coords);
      results.push({
        train_number: tn,
        train_name: row._name || 'N/A',
        coords,
        distance_km: Math.round(dist * 10) / 10,
        is_reference: false,
        current_station: row.current_station_name || row.current_station || '',
      });
    }

    results.sort((a, b) => a.distance_km - b.distance_km);

    // 6. Compute events inline (same logic as /api/events)
    const events = computeEvents(String(train_number), refSchedule, currentIdx, snap, live);

    res.json({
      message: `${results.length - 1} trains share future stations with ${train_number}. ${events.length} events detected.`,
      trains: results,
      events,
      center: refCoords,
      center_label: `${train_number} (${refStnName})`,
      ref_live: {
        station: refStation,
        station_name: refStnName,
        status: loc.status,
        delay_min: live.delayMinutes,
        coords: refCoords,
        last_updated: live.lastUpdated,
      },
      trains_to_track: [...relevantTrainNums],
    });
  } catch (err) {
    console.error('[scan]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────────────
// POST /api/events — Refresh events for a tracked train
// ─────────────────────────────────────────────────────
router.post('/api/events', async (req, res) => {
  try {
    const { train_number, journey_date } = req.body;
    if (!train_number) return res.status(400).json({ error: 'Missing train number.' });

    const jDate = journey_date || new Date().toISOString().slice(0, 10);
    const live = await fetchTrainLive(String(train_number), jDate);
    if (live.error) return res.status(404).json({ error: live.error });

    const refSchedule = db.getTrainSchedule(String(train_number));
    if (!refSchedule.length) return res.status(404).json({ error: 'No schedule.' });

    const loc = live.location;
    let currentIdx = refSchedule.findIndex(s => s.stnCode === loc?.stationCode);
    if (currentIdx < 0) {
      const refKm = loc?.distanceFromOriginKm;
      if (refKm != null) {
        let bestDiff = Infinity;
        refSchedule.forEach((s, i) => {
          const diff = Math.abs((s.km || 0) - refKm);
          if (diff < bestDiff) { bestDiff = diff; currentIdx = i; }
        });
      }
    }
    if (currentIdx < 0) currentIdx = 0;

    const snap = await refreshSnapshot();
    if (snap.error) return res.status(502).json({ error: snap.error });

    const events = computeEvents(String(train_number), refSchedule, currentIdx, snap, live);

    res.json({
      message: `${events.length} events detected.`,
      train_number: String(train_number),
      current_station: loc?.stationCode,
      delay_min: live.delayMinutes,
      events,
    });
  } catch (err) {
    console.error('[events]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────────────
// Event detection engine (shared by scan + events)
// ─────────────────────────────────────────────────────
function computeEvents(trainNumber, refSchedule, currentIdx, snap, live) {
  const futureStops = refSchedule.slice(currentIdx + 1);
  if (!futureStops.length) return [];

  const futureStationCodes = futureStops.map(s => s.stnCode);

  // Ref train timing
  const refDepAbs = refSchedule[0].depAbs || 0;
  const refRow = snap.index[trainNumber];
  const refMinsRunning = refRow?.mins_since_dep || 0;
  const refCurrentAbs = refDepAbs + refMinsRunning;
  const refDirUp = (refSchedule[refSchedule.length - 1].km || 0) > (refSchedule[0].km || 0);

  // Ref ETA at each future station (minutes from now)
  const refETA = {};
  for (const s of futureStops) {
    if (s.arrAbs != null) refETA[s.stnCode] = s.arrAbs - refCurrentAbs;
  }

  // Find candidate trains
  const candidates = db.getTrainsAtStations(futureStationCodes, trainNumber);
  const runningTrains = new Set(snap.rows.map(r => r._tn));

  const trainStops = {};
  for (const c of candidates) {
    if (!runningTrains.has(c.trainNumber)) continue;
    if (!trainStops[c.trainNumber]) trainStops[c.trainNumber] = [];
    trainStops[c.trainNumber].push(c);
  }

  const events = [];
  const EVENT_WINDOW = 15;
  const MAX_LOOKAHEAD = 4 * 60;
  const otherCache = {};

  for (const [otherTn, stops] of Object.entries(trainStops)) {
    const otherRow = snap.index[otherTn];
    if (!otherRow) continue;

    if (!(otherTn in otherCache)) {
      const otherSch = db.getTrainSchedule(otherTn);
      const otherDepAbs = otherSch.length ? (otherSch[0].depAbs || 0) : 0;
      otherCache[otherTn] = {
        currentAbs: otherDepAbs + (otherRow.mins_since_dep || 0),
        dirUp: otherSch.length >= 2
          ? (otherSch[otherSch.length - 1].km || 0) > (otherSch[0].km || 0)
          : true,
      };
    }
    const { currentAbs: otherCurrentAbs, dirUp: otherDirUp } = otherCache[otherTn];
    const sameDirection = refDirUp === otherDirUp;

    for (const stop of stops) {
      const refEtaMin = refETA[stop.stnCode];
      if (refEtaMin == null || stop.arrAbs == null) continue;

      const otherEtaMin = stop.arrAbs - otherCurrentAbs;

      if (refEtaMin < -5 || refEtaMin > MAX_LOOKAHEAD) continue;
      if (otherEtaMin < -30) continue;

      const gap = otherEtaMin - refEtaMin;
      if (Math.abs(gap) > EVENT_WINDOW) continue;

      const stnCoords = db.getStationCoords(stop.stnCode);
      const stnName = db.getStationNames([stop.stnCode])[stop.stnCode] || stop.stnCode;

      let eventType = 'CROSS';
      if (sameDirection) {
        eventType = gap > 0 ? 'OVERTAKE' : 'OVERTAKEN';
      }

      events.push({
        type: eventType,
        other_train: otherTn,
        other_name: otherRow._name || 'N/A',
        station_code: stop.stnCode,
        station_name: stnName,
        station_coords: stnCoords,
        gap_min: Math.round(gap),
        mins_until: Math.max(0, Math.round(refEtaMin)),
        same_direction: sameDirection,
      });
    }
  }

  // Deduplicate: best event per train
  const best = {};
  for (const e of events) {
    if (!best[e.other_train] || e.mins_until < best[e.other_train].mins_until) {
      best[e.other_train] = e;
    }
  }
  const deduped = Object.values(best);
  deduped.sort((a, b) => a.mins_until - b.mins_until);

  for (const e of deduped) {
    if (e.mins_until <= 5) e.urgency = 'imminent';
    else if (e.mins_until <= 15) e.urgency = 'soon';
    else if (e.mins_until <= 60) e.urgency = 'watch';
    else e.urgency = 'far';
  }

  return deduped;
}

// ─────────────────────────────────────────────────────
// POST /api/reach — reachability analysis
// ─────────────────────────────────────────────────────
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

    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const todayBit = db.DAY_BITS[dayNames[new Date().getDay()]];

    const visited = new Map();
    visited.set(code, { time: 0, train: null, trainName: null });

    const queue = [{ stn: code, elapsed: 0 }];
    while (queue.length) {
      const { stn, elapsed } = queue.shift();
      const departures = db.getTrainsDepartingFrom(stn, todayBit);

      for (const dep of departures) {
        const trainSch = db.getTrainSchedule(dep.trainNumber);
        const stIdx = trainSch.findIndex(s => s.stnCode === stn);
        if (stIdx < 0) continue;
        const depTime = trainSch[stIdx].depAbs;
        if (depTime == null) continue;

        for (let i = stIdx + 1; i < trainSch.length; i++) {
          const stop = trainSch[i];
          if (stop.arrAbs == null) continue;
          const travelMin = stop.arrAbs - depTime;
          const totalElapsed = elapsed + Math.max(0, travelMin);
          if (totalElapsed > maxMin) break;
          if (!visited.has(stop.stnCode) || visited.get(stop.stnCode).time > totalElapsed) {
            visited.set(stop.stnCode, { time: totalElapsed, train: dep.trainNumber, trainName: dep.trainName });
            if (i < stIdx + 5) queue.push({ stn: stop.stnCode, elapsed: totalElapsed });
          }
        }
      }
    }

    const stations = [];
    for (const [stnCode, info] of visited) {
      if (stnCode === code) continue;
      const coords = db.getStationCoords(stnCode);
      if (!coords) continue;
      const name = db.getStationNames([stnCode])[stnCode] || stnCode;
      const hours = Math.floor(info.time / 60);
      const mins  = info.time % 60;
      stations.push({
        code: stnCode, name, coords,
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
      origin_code: code, origin_name: originName, origin_coords: originCoords,
      frontier_stations: stations.slice(0, 200),
    });
  } catch (err) {
    console.error('[reach]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
