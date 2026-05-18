// server/tracking.js - Socket.IO live tracking via staggered per-train API calls
import { fetchTrainLive } from './railradar.js';
import * as db from './db.js';
import { checkHasPassed, getTrainHeading } from './routes.js';

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
const LIVE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes (must be longer than loop duration + GPS ping interval)

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
      const trainDates = data.train_dates || {};
      let refCoords = data.ref_coords;
      let closestKm = Infinity;

      console.log(`[ws] ${socket.id} tracking ${trains.length} trains (staggered, ${STAGGER_DELAY_MS}ms between calls)`);

      const abortController = new AbortController();

      const runLoop = async () => {
        while (!abortController.signal.aborted) {
          for (const tn of trains) {
            if (abortController.signal.aborted) break;

            try {
              const dateForTrain = trainDates[tn] || journeyDate;
              const live = await fetchTrainLive(tn, dateForTrain);
              if (live.error || !live.location) {
                if (live.error) console.log(`[track] ${tn} date=${dateForTrain} → error: ${live.error}`);
                continue;
              }
              console.log(`[track] Fetched live data for ${tn} (Delay: ${live.delayMinutes || 0}m)`);

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
              let speed = 0;

              if (prevLive) {
                if (prevLive.distanceToReferenceKm != null && dist != null) {
                  const prevDist = prevLive.distanceToReferenceKm;
                  if (dist > prevDist + 0.1) trend = 'increasing';
                  else if (dist < prevDist - 0.1) trend = 'decreasing';
                }

                // Calculate speed (km/h) using actual GPS timestamps from API
                const currentTs = live.lastUpdated ? new Date(live.lastUpdated).getTime() : Date.now();
                const prevTs = prevLive.lastUpdatedTs || prevLive.fetchedAt;
                
                const distMoved = haversine(prevLive.coords, coords);
                const timeElapsedHr = (currentTs - prevTs) / 3600000;
                
                if (timeElapsedHr > 0 && distMoved >= 0.1) {
                  speed = Math.round(distMoved / timeElapsedHr);
                  console.log(`[speed] ${tn}: moved ${distMoved.toFixed(2)}km in ${timeElapsedHr.toFixed(3)}hr -> ${speed} km/h`);
                } else if (prevLive.speed) {
                  speed = prevLive.speed; // carry over recent speed if barely moved or same timestamp
                } else if (timeElapsedHr > 0 || distMoved > 0) {
                  // Log why it didn't calculate speed if it moved or time passed
                  console.log(`[speed] ${tn}: skip calc. distMoved=${distMoved.toFixed(3)}km, timeElapsedHr=${timeElapsedHr.toFixed(3)}hr`);
                }
              }

              // Attach current timestamp so it can be saved in cache
              live._currentTs = live.lastUpdated ? new Date(live.lastUpdated).getTime() : Date.now();

              rememberLive(tn, live, coords, dist, speed);

              let hasPassed = false;
              if (tn !== mainTrain && refCoords) {
                hasPassed = checkHasPassed(mainTrain, tn, refCoords, coords);
                if (hasPassed) {
                  // Stop tracking it in the future
                  const idx = trains.indexOf(tn);
                  if (idx > -1) trains.splice(idx, 1);
                }
              }

              let heading = 0;
              const schedule = db.getTrainSchedule(tn);
              if (schedule) {
                heading = getTrainHeading(schedule, loc.stationCode);
              }

              // --- INTERCEPT PREDICTION LOGIC ---
              let intercept = null;
              if (tn !== mainTrain && refCoords && dist != null && dist <= 15) { // Only check if within 15km
                const mainLive = getRecentLive(mainTrain);
                if (mainLive && trend === 'decreasing') {
                  const mainSpeed = mainLive.speed || 0;
                  let mainHeading = 0;
                  const mainSchedule = db.getTrainSchedule(mainTrain);
                  if (mainSchedule && mainLive.stationCode) {
                    mainHeading = getTrainHeading(mainSchedule, mainLive.stationCode);
                  }
                  
                  let headingDiff = Math.abs(mainHeading - heading);
                  if (headingDiff > 180) headingDiff = 360 - headingDiff;
                  const isOpposite = headingDiff > 90;
                  
                  let relativeSpeed = isOpposite ? (mainSpeed + speed) : Math.abs(speed - mainSpeed);
                  
                  if (relativeSpeed > 10) {
                    const timeHours = dist / relativeSpeed;
                    const timeMins = timeHours * 60;
                    
                    if (timeMins > 0 && timeMins <= 5) { // Predict up to 5 mins ahead
                      if (isOpposite) {
                        intercept = { type: 'crossing', minutes: Math.ceil(timeMins), target_name: live.trainName || tn };
                      } else {
                        // Overtake logic: 'decreasing' trend + same direction means one is catching up
                        let isStationOvertake = false;
                        const slowerSpeed = Math.min(mainSpeed, speed);
                        const slowerStationCode = mainSpeed < speed ? mainLive.stationCode : loc.stationCode;
                        const slowerCoords = mainSpeed < speed ? refCoords : coords;
                        
                        if (slowerSpeed < 10 && slowerStationCode) {
                           const stnCoords = db.getStationCoords(slowerStationCode);
                           if (stnCoords && haversine(slowerCoords, stnCoords) <= 3) { 
                             isStationOvertake = true;
                             // Ensure the faster train doesn't also stop at this station
                             const fasterTrainCode = mainSpeed < speed ? tn : mainTrain;
                             const fasterSchedule = db.getTrainSchedule(fasterTrainCode);
                             if (fasterSchedule && fasterSchedule.some(s => s.stnCode === slowerStationCode)) {
                               isStationOvertake = false;
                             }
                           }
                        }
                        
                        if (relativeSpeed > 30 || isStationOvertake) {
                           intercept = { type: 'overtake', minutes: Math.ceil(timeMins), target_name: live.trainName || tn };
                        }
                      }
                    }
                  }
                }
              }

              socket.emit('location_update', {
                trains: [{
                  train_number: tn,
                  train_name: live.trainNumber || tn,
                  coords,
                  distance_km: dist != null ? Math.round(dist * 10) / 10 : null,
                  trend,
                  speed,
                  is_reference: tn === mainTrain,
                  current_station: loc.stationCode || '',
                  status: loc.status || '',
                  delay_min: live.delayMinutes,
                  has_passed: hasPassed,
                  heading: heading,
                  intercept: intercept
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

function rememberLive(trainNumber, live, coords, distanceToReferenceKm, speed = 0) {
  const loc = live.location || {};
  liveCache.set(String(trainNumber), {
    fetchedAt: Date.now(),
    lastUpdatedTs: live._currentTs || Date.now(),
    trainNumber: String(trainNumber),
    coords,
    distanceToReferenceKm,
    speed,
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
