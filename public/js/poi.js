// public/js/poi.js — POI Geofence Engine + Achievements
// Runs entirely client-side using phone GPS or server-provided coords

const POI_ALERT_COOLDOWN_MS = 10 * 60 * 1000; // Don't re-alert same POI within 10 min

let allPOIs = [];
let alertedPOIs = new Set();     // IDs we've already alerted this session
let poiLoaded = false;
let poiAlertCallback = null;     // Set by the UI layer
let achievementCallback = null;  // Set by the UI layer

// ── Achievements stored in localStorage ───────────────
const ACHIEVEMENT_KEY = 'krypton_achievements';

const ACHIEVEMENT_DEFS = {
  river_collector:   { name: '🌊 River Collector',   desc: 'Cross 5 different rivers',      threshold: 5,  category: 'river' },
  river_master:      { name: '🌊 River Master',      desc: 'Cross 10 different rivers',     threshold: 10, category: 'river' },
  history_buff:      { name: '⚔️ History Buff',       desc: 'Pass through 5 historical sites', threshold: 5,  category: 'historical' },
  history_scholar:   { name: '📚 History Scholar',    desc: 'Pass through 15 historical sites', threshold: 15, category: 'historical' },
  wildlife_watcher:  { name: '🐯 Wildlife Watcher',   desc: 'Enter 3 wildlife zones',        threshold: 3,  category: 'wildlife' },
  safari_king:       { name: '🦁 Safari King',        desc: 'Enter 8 wildlife zones',        threshold: 8,  category: 'wildlife' },
  crossing_counter:  { name: '🚂 Crossing Counter',   desc: 'Witness 10 train crossings',    threshold: 10, category: 'crossing' },
  crossing_king:     { name: '👑 Crossing King',      desc: 'Witness 25 train crossings',    threshold: 25, category: 'crossing' },
  explorer:          { name: '🗺️ Explorer',           desc: 'Trigger 20 POI alerts total',   threshold: 20, category: 'total' },
  legend:            { name: '🏆 Legend',             desc: 'Trigger 50 POI alerts total',   threshold: 50, category: 'total' },
};

function loadAchievements() {
  try {
    return JSON.parse(localStorage.getItem(ACHIEVEMENT_KEY)) || { counts: {}, unlocked: [] };
  } catch { return { counts: {}, unlocked: [] }; }
}

function saveAchievements(data) {
  localStorage.setItem(ACHIEVEMENT_KEY, JSON.stringify(data));
}

function recordPOIVisit(poi) {
  const data = loadAchievements();
  if (!data.counts) data.counts = {};
  if (!data.unlocked) data.unlocked = [];

  // Increment category count
  const cat = poi.type === 'river' || poi.type === 'bridge' ? 'river'
    : poi.type === 'tiger_reserve' || poi.type === 'elephant_corridor' || poi.type === 'wildlife' || poi.type === 'bird_sanctuary' ? 'wildlife'
    : 'historical';

  data.counts[cat] = (data.counts[cat] || 0) + 1;
  data.counts.total = (data.counts.total || 0) + 1;

  // Check for newly unlocked achievements
  for (const [id, def] of Object.entries(ACHIEVEMENT_DEFS)) {
    if (data.unlocked.includes(id)) continue;
    const countKey = def.category;
    if ((data.counts[countKey] || 0) >= def.threshold) {
      data.unlocked.push(id);
      if (achievementCallback) achievementCallback(def);
    }
  }

  saveAchievements(data);
}

export function recordCrossing() {
  const data = loadAchievements();
  if (!data.counts) data.counts = {};
  if (!data.unlocked) data.unlocked = [];
  data.counts.crossing = (data.counts.crossing || 0) + 1;
  data.counts.total = (data.counts.total || 0) + 1;

  for (const [id, def] of Object.entries(ACHIEVEMENT_DEFS)) {
    if (data.unlocked.includes(id)) continue;
    if (def.category === 'crossing' && (data.counts.crossing || 0) >= def.threshold) {
      data.unlocked.push(id);
      if (achievementCallback) achievementCallback(def);
    }
  }
  saveAchievements(data);
}

// ── Haversine ─────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Load all POI datasets ─────────────────────────────
export async function loadPOIs() {
  if (poiLoaded) return;
  try {
    const [rivers, historical, wildlife] = await Promise.all([
      fetch('/data/poi_rivers.json').then(r => r.json()),
      fetch('/data/poi_historical.json').then(r => r.json()),
      fetch('/data/poi_wildlife.json').then(r => r.json()),
    ]);
    allPOIs = [...rivers, ...historical, ...wildlife];
    poiLoaded = true;
    console.log(`[poi] Loaded ${allPOIs.length} points of interest`);
  } catch (err) {
    console.error('[poi] Failed to load POI data:', err);
  }
}

// ── Set alert callback (called by radar.js) ───────────
export function onPOIAlert(cb) { poiAlertCallback = cb; }
export function onAchievement(cb) { achievementCallback = cb; }

// ── Check position against all geofences ──────────────
export function checkPosition(lat, lng, speedKmh) {
  if (!poiLoaded || !allPOIs.length) return;

  for (const poi of allPOIs) {
    if (alertedPOIs.has(poi.id)) continue;

    const dist = haversine(lat, lng, poi.lat, poi.lng);

    if (dist <= poi.radius_km) {
      // We are INSIDE the geofence
      alertedPOIs.add(poi.id);
      recordPOIVisit(poi);

      if (poiAlertCallback) {
        poiAlertCallback({
          ...poi,
          distance_km: Math.round(dist * 10) / 10,
          eta_min: speedKmh > 5 ? Math.round((dist / speedKmh) * 60) : null,
        });
      }

      // Allow re-alerting after cooldown
      setTimeout(() => alertedPOIs.delete(poi.id), POI_ALERT_COOLDOWN_MS);
    }
  }
}

// ── Get achievement stats for UI ──────────────────────
export function getAchievementStats() {
  const data = loadAchievements();
  const results = [];
  for (const [id, def] of Object.entries(ACHIEVEMENT_DEFS)) {
    const countKey = def.category;
    const current = data.counts?.[countKey] || 0;
    results.push({
      id,
      ...def,
      current,
      unlocked: data.unlocked?.includes(id) || false,
      progress: Math.min(100, Math.round((current / def.threshold) * 100)),
    });
  }
  return results;
}

// ── Reset (for testing) ──────────────────────────────
export function resetSession() {
  alertedPOIs.clear();
}
