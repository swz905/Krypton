// public/js/app.js — Entry point, tab switching, station autocomplete, POI + Achievements
import * as radar from './radar.js';
import * as reach from './reach.js';
import { loadPOIs, onPOIAlert, onAchievement, checkPosition, getAchievementStats } from './poi.js';

const socket = io();

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  });
}

// Tab switching
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
  });
});

// Load station autocomplete
async function loadStations() {
  try {
    const resp = await fetch('/api/stations');
    const stations = await resp.json();
    const dl = document.getElementById('stationList');
    for (const s of stations) {
      const opt = document.createElement('option');
      opt.value = s.code;
      opt.label = `${s.name} (${s.code})`;
      dl.appendChild(opt);
    }
    console.log(`[app] Loaded ${stations.length} stations for autocomplete.`);
  } catch (err) {
    console.error('[app] Station load failed:', err);
  }
}

// ─── POI Alert UI ─────────────────────────────────────
let poiDismissTimer = null;

function showPOIAlert(poi) {
  const el = document.getElementById('poiAlert');
  document.getElementById('poiIcon').textContent = poi.icon;

  const badge = document.getElementById('poiTypeBadge');
  badge.textContent = poi.type.replace(/_/g, ' ');
  badge.className = 'poi-type-badge ' + poi.type;

  document.getElementById('poiName').textContent = poi.name;
  document.getElementById('poiStory').textContent = poi.story;
  document.getElementById('poiYear').textContent = poi.year ? `📅 ${poi.year}` : '';
  document.getElementById('poiDist').textContent = `📍 ${poi.distance_km} km away`;

  el.style.display = '';

  // Play a chime if available
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {}

  clearTimeout(poiDismissTimer);
  poiDismissTimer = setTimeout(() => { el.style.display = 'none'; }, 15000);
}

document.getElementById('poiDismiss')?.addEventListener('click', () => {
  document.getElementById('poiAlert').style.display = 'none';
  clearTimeout(poiDismissTimer);
});

// ─── Achievement Toast ────────────────────────────────
function showAchievementToast(def) {
  const el = document.getElementById('achieveToast');
  document.getElementById('achieveName').textContent = def.name;
  document.getElementById('achieveDesc').textContent = def.desc;
  el.style.display = '';

  try {
    navigator.vibrate?.([100, 50, 100, 50, 200]);
  } catch {}

  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ─── Achievement Modal ────────────────────────────────
function renderAchievements() {
  const list = document.getElementById('achieveList');
  const stats = getAchievementStats();
  list.innerHTML = stats.map(a => `
    <div class="achieve-item ${a.unlocked ? '' : 'locked'}">
      <div class="a-icon">${a.unlocked ? '✅' : '🔒'}</div>
      <div class="a-info">
        <span class="a-name">${a.name}</span>
        <span class="a-desc">${a.desc} (${a.current}/${a.threshold})</span>
        <div class="a-bar"><div class="a-bar-fill" style="width:${a.progress}%"></div></div>
      </div>
    </div>
  `).join('');
}

document.getElementById('achieveBtn')?.addEventListener('click', () => {
  renderAchievements();
  document.getElementById('achieveModal').style.display = '';
});

document.getElementById('achieveClose')?.addEventListener('click', () => {
  document.getElementById('achieveModal').style.display = 'none';
});

document.getElementById('achieveModal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});

// ─── POI Engine: feed it coordinates from location_update ───
onPOIAlert(showPOIAlert);
onAchievement(showAchievementToast);

// ─── GPS Mode Toggle ─────────────────────────────────
let gpsWatchId = null;
let lastGpsCoords = null;
let lastGpsSpeed = 0;
window.gpsMode = false;

const gpsToggle = document.getElementById('gpsToggle');
const gpsStatusEl = document.getElementById('gpsStatus');

gpsToggle?.addEventListener('change', () => {
  if (gpsToggle.checked) {
    // Start watching phone GPS
    if (!navigator.geolocation) {
      gpsStatusEl.textContent = '(not supported)';
      gpsToggle.checked = false;
      return;
    }

    gpsStatusEl.textContent = '(acquiring...)';
    window.gpsMode = true;

    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        lastGpsCoords = [pos.coords.latitude, pos.coords.longitude];
        lastGpsSpeed = pos.coords.speed != null ? Math.round(pos.coords.speed * 3.6) : 0; // m/s → km/h
        gpsStatusEl.textContent = `(${lastGpsSpeed} km/h)`;

        // Feed phone GPS to POI engine
        checkPosition(lastGpsCoords[0], lastGpsCoords[1], lastGpsSpeed);
      },
      (err) => {
        console.error('[gps] Error:', err.message);
        gpsStatusEl.textContent = `(error: ${err.message})`;
        window.gpsMode = false;
        gpsToggle.checked = false;
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000,
      }
    );
    console.log('[gps] Phone GPS mode ON');
  } else {
    // Stop watching
    if (gpsWatchId != null) {
      navigator.geolocation.clearWatch(gpsWatchId);
      gpsWatchId = null;
    }
    window.gpsMode = false;
    lastGpsCoords = null;
    gpsStatusEl.textContent = '';
    console.log('[gps] Phone GPS mode OFF — using API location');
  }
});

// Expose checkPosition so radar.js can call it (only when NOT in GPS mode)
window._poiCheck = (lat, lng, speed) => {
  // If GPS mode is on, the phone GPS feeds POI directly — skip API coords
  if (window.gpsMode) return;
  checkPosition(lat, lng, speed);
};

// Init modules
radar.init(socket);
reach.init();
loadStations();
loadPOIs();
