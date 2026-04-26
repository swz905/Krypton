// public/js/radar.js — Radar tab + crossing/overtake events
import { layers, markers, prevCoords, clearAll, flyTo, trainIcon, bearing } from './map.js';

let socket = null;
let mainTrain = '';
let journeyDate = '';
let eventsTimer = null;
let trackedTrains = [];

export function init(io) {
  socket = io;
  const form    = document.getElementById('radarForm');
  const scanBtn = document.getElementById('scanBtn');
  const stopBtn = document.getElementById('stopBtn');
  const liveBar = document.getElementById('liveStatus');

  const dateInput = form.querySelector('[name="journey_date"]');
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    scanBtn.disabled = true;
    stopBtn.style.display = 'none';
    liveBar.style.display = 'none';
    clearAll();
    showStatus('radarStatus', 'Fetching live data...', 'info');
    document.getElementById('radarResults').innerHTML = '';

    socket.emit('stop_tracking');

    const fd = Object.fromEntries(new FormData(form));
    mainTrain = fd.train_number;
    journeyDate = fd.journey_date || new Date().toISOString().slice(0, 10);
    trackedTrains = [];

    try {
      const resp = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fd),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      showStatus('radarStatus', data.message, 'success');
      renderResults(data);
      trackedTrains = data.trains_to_track || [];

      // Show live status
      if (data.ref_live) {
        const rl = data.ref_live;
        const delayStr = rl.delay_min != null ? ` • ${rl.delay_min} min late` : '';
        liveBar.textContent = `LIVE  ${rl.station_name} (${rl.status})${delayStr}`;
        liveBar.style.display = 'flex';
      }

      // Auto-start tracking relevant trains via per-train live API
      if (trackedTrains.length > 0) {
        socket.emit('start_tracking', {
          trains_to_track: trackedTrains,
          main_train: mainTrain,
          journey_date: data.journey_date,
          ref_coords: data.center,
        });
        stopBtn.style.display = 'flex';
        stopBtn.disabled = false;
      }

      scanBtn.disabled = false;

    } catch (err) {
      showStatus('radarStatus', err.message, 'error');
      scanBtn.disabled = false;
    }
  });

  stopBtn.addEventListener('click', () => {
    socket.emit('stop_tracking');
    stopBtn.style.display = 'none';
    liveBar.style.display = 'none';
    trackedTrains = [];
  });

  socket.on('tracking_status', (d) => {
    if (d.status === 'started') {
      stopBtn.style.display = 'flex';
    } else if (d.status === 'stopped') {
      stopBtn.style.display = 'none';
    }
  });

  socket.on('location_update', (data) => {
    for (const t of data.trains || []) {
      const mk = markers[t.train_number];
      if (!mk) continue;

      const c = t.coords;
      const prev = prevCoords[t.train_number];
      let head = null;
      if (prev && (Math.abs(prev[0]-c[0]) > 1e-5 || Math.abs(prev[1]-c[1]) > 1e-5))
        head = bearing(prev[0], prev[1], c[0], c[1]);

      mk.setLatLng(c);
      mk.setIcon(trainIcon(t.is_reference ? '#e63946' : '#0077b6', head));
      mk.setTooltipContent(tooltip(t));
      prevCoords[t.train_number] = c;

      const row = document.getElementById('r-' + t.train_number);
      if (row) {
        const stnCell = row.querySelector('.stn');
        if (stnCell) stnCell.textContent = t.current_station || '';
        
        const distCell = row.querySelector('.dist');
        if (distCell && t.distance_km != null) {
          let arrow = '';
          if (t.trend === 'increasing') arrow = ' ↗';
          else if (t.trend === 'decreasing') arrow = ' ↘';
          distCell.textContent = t.distance_km + ' km' + arrow;
        }
      }
    }
  });
}


// ── Render ──────────────────────────────────────────

function renderResults(data) {
  const bounds = L.latLngBounds([]);
  const container = document.getElementById('radarResults');

  if (data.center) {
    L.circleMarker(data.center, {
      radius: 8, fillColor: '#e63946', color: '#fff', weight: 2, fillOpacity: .9,
    }).addTo(layers.ref).bindPopup('<b>' + data.center_label + '</b>');
    bounds.extend(data.center);
  }

  let html = '<table><thead><tr><th>Train</th><th>Name</th><th>Station</th><th>Distance</th></tr></thead><tbody>';
  for (const t of data.trains || []) {
    const cls = t.is_reference ? ' class="ref"' : '';
    const distStr = t.distance_km != null ? t.distance_km + ' km' : '';
    html += `<tr id="r-${t.train_number}"${cls}>
      <td>${t.train_number}</td>
      <td>${t.train_name}</td>
      <td class="stn">${t.current_station || ''}</td>
      <td class="dist">${distStr}</td>
    </tr>`;

    if (t.coords) {
      const color = t.is_reference ? '#e63946' : '#0077b6';
      const mk = L.marker(t.coords, { icon: trainIcon(color, null) })
        .addTo(layers.trains)
        .bindTooltip(tooltip(t), { direction: 'top' });
      markers[t.train_number] = mk;
      prevCoords[t.train_number] = t.coords;
      bounds.extend(t.coords);
    }
  }
  html += '</tbody></table>';
  container.innerHTML = html;
  flyTo(bounds);
}

function tooltip(t) {
  return '<b>' + t.train_number + '</b> ' + t.train_name
    + '<br>' + (t.current_station || '')
    + (t.delay_min != null ? ' • ' + t.delay_min + ' min late' : '');
}

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'status-msg ' + type;
}
