// public/js/radar.js — Radar tab logic
import { layers, markers, prevCoords, clearAll, flyTo, trainIcon, bearing } from './map.js';

let socket = null;
let mainTrain = '';

export function init(io) {
  socket = io;
  const form    = document.getElementById('radarForm');
  const scanBtn = document.getElementById('scanBtn');
  const stopBtn = document.getElementById('stopBtn');
  const liveBar = document.getElementById('liveStatus');

  // Set today's date
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
    showStatus('radarStatus', 'Scanning live network...', 'info');
    document.getElementById('radarResults').innerHTML = '';

    // Stop any existing tracking
    socket.emit('stop_tracking');

    const fd = Object.fromEntries(new FormData(form));
    mainTrain = fd.train_number;

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

      // Auto-start live tracking — always emit, socket will queue if not yet connected
      if (data.trains_to_track && data.trains_to_track.length > 0) {
        console.log('[radar] starting live tracking for', data.trains_to_track.length, 'trains');
        socket.emit('start_tracking', {
          trains_to_track: data.trains_to_track,
          ref_station_code: data.ref_station_code,
          spatial_range_km: data.spatial_range_km,
          main_train: mainTrain,
        });
        // Show live UI immediately
        liveBar.style.display = 'flex';
        liveBar.textContent = 'LIVE  starting...';
        stopBtn.style.display = 'flex';
        stopBtn.disabled = false;
        // Keep scan disabled while tracking
      } else {
        scanBtn.disabled = false;
      }
    } catch (err) {
      showStatus('radarStatus', err.message, 'error');
      scanBtn.disabled = false;
    }
  });

  stopBtn.addEventListener('click', () => {
    socket.emit('stop_tracking');
    stopBtn.style.display = 'none';
    liveBar.style.display = 'none';
    scanBtn.disabled = false;
  });

  socket.on('tracking_status', (d) => {
    console.log('[radar] tracking_status:', d);
    if (d.status === 'started') {
      liveBar.style.display = 'flex';
      stopBtn.style.display = 'flex';
      scanBtn.disabled = true;
    } else if (d.status === 'stopped') {
      stopBtn.style.display = 'none';
      liveBar.style.display = 'none';
      scanBtn.disabled = false;
    } else if (d.status === 'error') {
      showStatus('radarStatus', d.message, 'error');
    }
  });

  socket.on('location_update', (data) => {
    liveBar.textContent = 'LIVE  ' + new Date().toLocaleTimeString();

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
        const distCell = row.querySelector('.dist');
        if (stnCell) stnCell.textContent = t.current_station || '';
        if (distCell) distCell.textContent = t.distance_km != null ? t.distance_km + ' km' : '';
      }
    }
  });
}

function renderResults(data) {
  const bounds = L.latLngBounds([]);
  const container = document.getElementById('radarResults');

  if (data.center) {
    L.circleMarker(data.center, {
      radius: 8, fillColor: '#e63946', color: '#fff', weight: 2, fillOpacity: .9,
    }).addTo(layers.ref).bindPopup('<b>' + data.center_label + '</b>');
    bounds.extend(data.center);
  }

  let html = '<table><thead><tr><th>Train</th><th>Name</th><th>Station</th><th>Dist</th></tr></thead><tbody>';
  for (const t of data.trains || []) {
    const cls = t.is_reference ? ' class="ref"' : '';
    html += '<tr id="r-' + t.train_number + '"' + cls + '>' +
      '<td>' + t.train_number + '</td>' +
      '<td>' + t.train_name + '</td>' +
      '<td class="stn">' + (t.current_station || '') + '</td>' +
      '<td class="dist">' + (t.distance_km != null ? t.distance_km + ' km' : '') + '</td>' +
    '</tr>';

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
  return '<b>' + t.train_number + '</b> ' + t.train_name +
    '<br>' + (t.current_station || '') +
    (t.distance_km != null ? ' &bull; ' + t.distance_km + ' km' : '');
}

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'status-msg ' + type;
}
