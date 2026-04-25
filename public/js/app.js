// public/js/app.js — Entry point, tab switching, station autocomplete
import * as radar from './radar.js';
import * as reach from './reach.js';

const socket = io();

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

// Init modules
radar.init(socket);
reach.init();
loadStations();
