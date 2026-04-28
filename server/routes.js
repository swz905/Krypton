// server/routes.js — HTTP API routes
import { Router } from 'express';
import cfg from './config.js';
import * as db from './db.js';
import { refreshSnapshot, getCachedSnapshot, fetchTrainLive } from './railradar.js';
import { getRecentLive } from './tracking.js';

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
    const { train_number, journey_date, radius } = req.body;
    const uiRadius = parseInt(radius) || 250;
    const searchRadius = Math.max(500, Math.min(uiRadius, 3000));
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

    // Unique running trains where the common station is still AHEAD of them AND within radius
    // Group candidates by train number first
    const candidatesByTrain = new Map();
    for (const c of candidates) {
      if (!runningTrains.has(c.trainNumber)) continue;
      if (!snap.index[c.trainNumber]) continue;
      if (!candidatesByTrain.has(c.trainNumber)) candidatesByTrain.set(c.trainNumber, []);
      candidatesByTrain.get(c.trainNumber).push(c);
    }

    console.log(`\n[scan] --- Filtering candidates for ref train ${train_number} (Search Radius: ${searchRadius}km) ---`);
    const relevantTrainNums = new Set();
    for (const [tn, entries] of candidatesByTrain) {
      const row = snap.index[tn];
      const coords = [row._lat, row._lng];
      const otherSchedule = db.getTrainSchedule(tn);

      // Skip if this train has already passed ALL common stations
      const hasUnpassed = entries.some(c => !hasPassedStop(otherSchedule, coords, c.stnCode));
      if (!hasUnpassed) {
        console.log(`[scan] ❌ Rejected ${tn} (${row._name || 'Unknown'}) - Has already passed all common stations.`);
        continue;
      }

      // Radius check
      const dist = haversine(refCoords, coords);
      if (dist > searchRadius) {
        console.log(`[scan] ❌ Rejected ${tn} (${row._name || 'Unknown'}) - Distance ${Math.round(dist)}km exceeds radius ${searchRadius}km.`);
        continue;
      }

      // Filter out: opposite direction AND behind reference train
      if (isOppositeAndBehind(refSchedule, currentIdx, otherSchedule, refCoords, coords)) {
        console.log(`[scan] ❌ Rejected ${tn} (${row._name || 'Unknown'}) - Moving in opposite direction AND is geographically behind.`);
        continue;
      }

      console.log(`[scan] ✅ Accepted ${tn} (${row._name || 'Unknown'}) - Distance: ${Math.round(dist)}km`);
      relevantTrainNums.add(tn);
    }
    console.log(`[scan] --- Filtering complete: ${relevantTrainNums.size} trains accepted ---\n`);

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

    // Build per-train journey dates from snapshot's current_day
    const trainDates = {};
    const todayMs = Date.now();

    for (const tn of relevantTrainNums) {
      const row = snap.index[tn];
      if (!row) continue;
      const coords = [row._lat, row._lng];
      const dist = haversine(refCoords, coords);
      if (dist > searchRadius) continue; // radius filter

      // Compute the correct departure date for this train instance in IST
      const currentDay = row.current_day ?? row.currentDay ?? 1;
      const daysOffset = -(currentDay - 1);
      
      const d = new Date();
      d.setUTCHours(d.getUTCHours() + 5);
      d.setUTCMinutes(d.getUTCMinutes() + 30);
      d.setUTCDate(d.getUTCDate() + daysOffset);
      
      trainDates[tn] = d.toISOString().slice(0, 10);

      results.push({
        train_number: tn,
        train_name: row._name || 'N/A',
        coords,
        distance_km: Math.round(dist * 10) / 10,
        is_reference: false,
        current_station: row.current_station_name || row.current_station || '',
      });
    }

    // Reference train uses user-supplied date
    trainDates[String(train_number)] = jDate;

    results.sort((a, b) => a.distance_km - b.distance_km);

    // Only track trains that passed the radius filter
    const trackedNums = results.filter(r => !r.is_reference).map(r => r.train_number);

    res.json({
      message: `${trackedNums.length} trains found within ${searchRadius} km of ${train_number}.`,
      trains: results,
      events: [],

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
      trains_to_track: [String(train_number), ...trackedNums],
      journey_date: jDate,
      train_dates: trainDates,
      ui_radius: uiRadius,
      radius_km: searchRadius,
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
    const { train_number, journey_date, trains_to_track } = req.body;
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

    const allowedTrainNums = Array.isArray(trains_to_track)
      ? trains_to_track.map(String).filter(tn => tn !== String(train_number))
      : null;
    const events = computeEvents(String(train_number), refSchedule, currentIdx, snap, live, {
      allowedTrainNums,
    });

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
function getStopAbs(stop) {
  return stop?.arrAbs ?? stop?.depAbs ?? null;
}

function getCurrentDistanceKm({ live, recent, row }) {
  const liveKm = live?.location?.distanceFromOriginKm;
  if (liveKm != null && Number.isFinite(Number(liveKm))) return Number(liveKm);
  const recentKm = recent?.distanceFromOriginKm;
  if (recentKm != null && Number.isFinite(Number(recentKm))) return Number(recentKm);
  const rowKm = row?._distanceKm ?? row?.curr_distance ?? row?.current_distance ?? row?.distanceFromOriginKm;
  if (rowKm != null && Number.isFinite(Number(rowKm))) return Number(rowKm);
  return null;
}

function getCurrentStationCode({ live, recent, row }) {
  return live?.location?.stationCode
    || recent?.stationCode
    || row?.current_station
    || row?.current_station_code
    || null;
}

function estimateProgressAbs(schedule, state) {
  const distanceKm = getCurrentDistanceKm(state);
  if (distanceKm != null) {
    const exact = schedule.find(s => s.km != null && Math.abs(Number(s.km) - distanceKm) <= 1);
    if (exact) return getStopAbs(exact) ?? 0;

    for (let i = 0; i < schedule.length - 1; i++) {
      const a = schedule[i], b = schedule[i + 1];
      if (a.km == null || b.km == null || a.km === b.km) continue;
      const minKm = Math.min(a.km, b.km), maxKm = Math.max(a.km, b.km);
      if (distanceKm < minKm || distanceKm > maxKm) continue;

      const aAbs = a.depAbs ?? a.arrAbs;
      const bAbs = b.arrAbs ?? b.depAbs;
      if (aAbs == null || bAbs == null) continue;

      const ratio = Math.abs((distanceKm - a.km) / (b.km - a.km));
      return aAbs + ratio * (bAbs - aAbs);
    }

    let nearest = schedule[0];
    let bestDiff = Infinity;
    for (const stop of schedule) {
      if (stop.km == null) continue;
      const diff = Math.abs(stop.km - distanceKm);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearest = stop;
      }
    }
    return getStopAbs(nearest) ?? 0;
  }

  const mins = state.row?._minsSinceDep ?? state.row?.mins_since_dep;
  if (mins != null && Number.isFinite(Number(mins))) {
    return (schedule[0]?.depAbs ?? getStopAbs(schedule[0]) ?? 0) + Number(mins);
  }

  const stationCode = getCurrentStationCode(state);
  const stationIdx = stationCode ? schedule.findIndex(s => s.stnCode === stationCode) : -1;
  if (stationIdx >= 0) return getStopAbs(schedule[stationIdx]) ?? 0;
  if (state.currentIdx != null && state.currentIdx >= 0) return getStopAbs(schedule[state.currentIdx]) ?? 0;
  return schedule[0]?.depAbs ?? getStopAbs(schedule[0]) ?? 0;
}

function classifyCommonDirection(commonStops, refSchedule, otherSchedule) {
  if (commonStops.length >= 2) {
    let score = 0;
    for (let i = 1; i < commonStops.length; i++) {
      const delta = commonStops[i].otherIdx - commonStops[i - 1].otherIdx;
      if (delta > 0) score++;
      if (delta < 0) score--;
    }
    if (score !== 0) return score > 0;
  }

  // Fallback: if we can't determine direction from common stops, assume same direction
  return true;
}

function hasPassedStop(schedule, currentCoords, stopCode) {
  if (!currentCoords || !stopCode || !schedule.length) return false;
  
  // Find the index of the target stop
  const targetIdx = schedule.findIndex(s => s.stnCode === stopCode);
  if (targetIdx < 0) return false;

  // Approximate current position by finding the geographically closest station in its schedule
  let currentIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < schedule.length; i++) {
    const sCoords = db.getStationCoords(schedule[i].stnCode);
    if (sCoords) {
      const d = haversine(currentCoords, sCoords);
      if (d < minDist) {
        minDist = d;
        currentIdx = i;
      }
    }
  }

  // If the closest station is AFTER the target stop, it has likely already passed it.
  // Add a small buffer (e.g., 2 stations) to prevent false positives when trains are between stations.
  return currentIdx > targetIdx + 2;
}

// Returns true if the other train is traveling in the opposite direction
// AND is geographically behind the reference train (i.e. moving away).
function isOppositeAndBehind(refSchedule, refCurrentIdx, otherSchedule, refCoords, otherCoords) {
  // 1. Determine direction by comparing common station order
  const refIdxMap = new Map(refSchedule.map((s, i) => [s.stnCode, i]));
  const commonPairs = []; // { refIdx, otherIdx }
  for (let oi = 0; oi < otherSchedule.length; oi++) {
    const ri = refIdxMap.get(otherSchedule[oi].stnCode);
    if (ri != null) commonPairs.push({ refIdx: ri, otherIdx: oi });
  }

  if (commonPairs.length < 2) return false; // can't determine direction

  // Score: if common stations appear in the same order in both schedules → same direction
  // If reversed → opposite direction
  let score = 0;
  for (let i = 1; i < commonPairs.length; i++) {
    const refDelta = commonPairs[i].refIdx - commonPairs[i - 1].refIdx;
    const otherDelta = commonPairs[i].otherIdx - commonPairs[i - 1].otherIdx;
    // Same sign = same direction, opposite sign = opposite direction
    if ((refDelta > 0 && otherDelta > 0) || (refDelta < 0 && otherDelta < 0)) score++;
    else score--;
  }

  const isOpposite = score < 0;
  if (!isOpposite) return false; // same direction — keep it

  // 2. Determine if the other train is BEHIND the reference train
  // Compute ref train's heading: vector from current position toward the next future station
  const futureStops = refSchedule.slice(refCurrentIdx + 1);
  let headingTarget = null;
  for (const s of futureStops) {
    const c = db.getStationCoords(s.stnCode);
    if (c) { headingTarget = c; break; }
  }
  if (!headingTarget) return false;

  // Direction vector (ref → future station)
  const dirLat = headingTarget[0] - refCoords[0];
  const dirLng = headingTarget[1] - refCoords[1];

  // Vector from ref → other train
  const toOtherLat = otherCoords[0] - refCoords[0];
  const toOtherLng = otherCoords[1] - refCoords[1];

  // Dot product: positive = other train is AHEAD, negative = BEHIND
  const dot = dirLat * toOtherLat + dirLng * toOtherLng;

  return dot < 0; // opposite direction AND behind → filter out
}

function computeEvents(trainNumber, refSchedule, currentIdx, snap, live, options = {}) {
  const futureStops = refSchedule.slice(currentIdx + 1);
  if (!futureStops.length) return [];

  const futureStationCodes = futureStops.map(s => s.stnCode);
  const allowedTrainNums = options.allowedTrainNums ? new Set(options.allowedTrainNums.map(String)) : null;

  // Ref train timing
  const refRow = snap.index[trainNumber];
  const refCurrentAbs = estimateProgressAbs(refSchedule, {
    live,
    recent: getRecentLive(trainNumber),
    row: refRow,
    currentIdx,
  });

  // Ref ETA at each future station
  const refETA = {};
  for (const s of futureStops) {
    if (s.arrAbs != null) refETA[s.stnCode] = s.arrAbs - refCurrentAbs;
  }

  // Find candidate trains at future stations
  const candidates = db.getTrainsAtStations(futureStationCodes, trainNumber);
  const runningTrains = new Set(snap.rows.map(r => r._tn));

  // Group by train: only their stops at our future stations
  const trainStops = {};
  for (const c of candidates) {
    if (allowedTrainNums && !allowedTrainNums.has(c.trainNumber)) continue;
    if (!runningTrains.has(c.trainNumber)) continue;
    if (!trainStops[c.trainNumber]) trainStops[c.trainNumber] = [];
    trainStops[c.trainNumber].push(c);
  }

  const events = [];
  const MAX_LOOKAHEAD = 4 * 60;
  const CROSS_WINDOW = 15; // ±15 min for crossings

  for (const [otherTn, stops] of Object.entries(trainStops)) {
    const otherRow = snap.index[otherTn];
    if (!otherRow) continue;

    const otherSch = db.getTrainSchedule(otherTn);
    if (!otherSch.length) continue;
    const otherCurrentAbs = estimateProgressAbs(otherSch, {
      recent: getRecentLive(otherTn),
      row: otherRow,
    });
    const otherIndex = new Map(otherSch.map((s, i) => [s.stnCode, i]));
    const commonInRefOrder = futureStops
      .filter(s => otherIndex.has(s.stnCode))
      .map(s => ({ refStop: s, otherStop: otherSch[otherIndex.get(s.stnCode)], otherIdx: otherIndex.get(s.stnCode) }));
    const sameDirection = classifyCommonDirection(commonInRefOrder, refSchedule, otherSch);

    if (!sameDirection) {
      // ── CROSSING: opposite direction, same station within ±15 min ──
      for (const stop of stops) {
        const refEtaMin = refETA[stop.stnCode];
        if (refEtaMin == null || stop.arrAbs == null) continue;
        const otherEtaMin = stop.arrAbs - otherCurrentAbs;

        if (refEtaMin < -5 || refEtaMin > MAX_LOOKAHEAD) continue;
        if (otherEtaMin < -30) continue;

        const gap = Math.abs(otherEtaMin - refEtaMin);
        if (gap > CROSS_WINDOW) continue;

        const stnName = db.getStationNames([stop.stnCode])[stop.stnCode] || stop.stnCode;
        events.push({
          type: 'CROSS',
          other_train: otherTn,
          other_name: otherRow._name || 'N/A',
          station_code: stop.stnCode,
          station_name: stnName,
          station_coords: db.getStationCoords(stop.stnCode),
          mins_until: Math.max(0, Math.round(refEtaMin)),
          same_direction: false,
        });
      }
    } else {
      // ── OVERTAKE: same direction, ORDER REVERSAL between two common stations ──
      // Get the other train's common future stops, sorted by km in ref's route order
      // We need stops that are common AND in the future for BOTH trains

      // Other train's current km
      const otherKm = getCurrentDistanceKm({ recent: getRecentLive(otherTn), row: otherRow });

      // Build ordered list of common stations with ETAs for both trains
      // Use ref's route order (futureStops) to maintain sequence
      const commonStops = [];
      const otherStopMap = {};
      for (const s of stops) {
        otherStopMap[s.stnCode] = s;
      }

      for (const fs of futureStops) {
        const os = otherStopMap[fs.stnCode];
        if (!os || os.arrAbs == null || fs.arrAbs == null) continue;

        const refEta = fs.arrAbs - refCurrentAbs;
        const otherEta = os.arrAbs - otherCurrentAbs;

        // Both must be in the future
        if (refEta < -5 || otherEta < -30) continue;
        if (refEta > MAX_LOOKAHEAD) continue;

        // Other train must not have passed this station
        const coords = [otherRow._lat, otherRow._lng];
        if (hasPassedStop(otherSch, coords, os.stnCode)) continue;

        commonStops.push({
          stnCode: fs.stnCode,
          refEta,
          otherEta,
          diff: refEta - otherEta, // negative = ref arrives first, positive = other arrives first
        });
      }

      // Check consecutive pairs for order reversal
      // PLUS: at the reversal station, both trains must be there around the same
      // time (|diff| ≤ 30 min) — otherwise they're hours apart and never
      // actually "passing" each other on the tracks.
      const OVERTAKE_PROXIMITY = 30; // minutes
      for (let i = 0; i < commonStops.length - 1; i++) {
        const a = commonStops[i];
        const b = commonStops[i + 1];

        // Sign flip in diff → order reversal between stations A and B
        // At the reversal station (B), trains must be close in time
        if (a.diff < 0 && b.diff > 0 && Math.abs(b.diff) <= OVERTAKE_PROXIMITY) {
          // Ref was first at A, other is first at B → ref gets OVERTAKEN between A and B
          const stnName = db.getStationNames([b.stnCode])[b.stnCode] || b.stnCode;
          events.push({
            type: 'OVERTAKEN',
            other_train: otherTn,
            other_name: otherRow._name || 'N/A',
            station_code: b.stnCode,
            station_name: stnName,
            station_coords: db.getStationCoords(b.stnCode),
            mins_until: Math.max(0, Math.round(b.refEta)),
            same_direction: true,
          });
          break;
        } else if (a.diff > 0 && b.diff < 0 && Math.abs(b.diff) <= OVERTAKE_PROXIMITY) {
          // Other was first at A, ref is first at B → ref OVERTAKES
          const stnName = db.getStationNames([b.stnCode])[b.stnCode] || b.stnCode;
          events.push({
            type: 'OVERTAKE',
            other_train: otherTn,
            other_name: otherRow._name || 'N/A',
            station_code: b.stnCode,
            station_name: stnName,
            station_coords: db.getStationCoords(b.stnCode),
            mins_until: Math.max(0, Math.round(b.refEta)),
            same_direction: true,
          });
          break;
        }
      }
    }
  }

  // Sort by time, deduplicate per train (keep soonest)
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
