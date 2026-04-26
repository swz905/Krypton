// public/js/radar.js — Radar tab + crossing/overtake events
import { layers, markers, prevCoords, clearAll, flyTo, trainIcon, bearing } from './map.js';

let socket = null;
let mainTrain = '';
let journeyDate = '';
let eventsTimer = null;

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
    clearEvents();
    showStatus('radarStatus', 'Fetching live data...', 'info');
    document.getElementById('radarResults').innerHTML = '';

    socket.emit('stop_tracking');
    stopEventsPolling();

    const fd = Object.fromEntries(new FormData(form));
    mainTrain = fd.train_number;
    journeyDate = fd.journey_date || new Date().toISOString().slice(0, 10);

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
      renderEvents(data.events || []);

      // Show live status
      if (data.ref_live) {
        const rl = data.ref_live;
        const delayStr = rl.delay_min != null ? ` • ${rl.delay_min} min late` : '';
        liveBar.textContent = `LIVE  ${rl.station_name} (${rl.status})${delayStr}`;
        liveBar.style.display = 'flex';
      }

      // Auto-start tracking relevant trains via per-train live API
      if (data.trains_to_track && data.trains_to_track.length > 0) {
        socket.emit('start_tracking', {
          trains_to_track: data.trains_to_track,
          main_train: mainTrain,
          journey_date: data.journey_date,
          ref_coords: data.center,
        });
        stopBtn.style.display = 'flex';
        stopBtn.disabled = false;
      }

      // Start event polling (refreshes every 30s)
      startEventsPolling();
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
    stopEventsPolling();
    clearEvents();
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
      }
    }
  });
}

// ── Events ──────────────────────────────────────────

async function fetchEvents() {
  if (!mainTrain) return;
  try {
    const resp = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ train_number: mainTrain, journey_date: journeyDate }),
    });
    const data = await resp.json();
    if (data.error) return;
    renderEvents(data.events || []);

    // Update live bar with delay info
    if (data.delay_min != null) {
      const liveBar = document.getElementById('liveStatus');
      liveBar.textContent = `LIVE  ${data.current_station || ''} • ${data.delay_min} min late • ${new Date().toLocaleTimeString()}`;
    }
  } catch (err) {
    console.error('[events] fetch failed:', err);
  }
}

function startEventsPolling() {
  stopEventsPolling();
  eventsTimer = setInterval(fetchEvents, 30000);
}

function stopEventsPolling() {
  if (eventsTimer) { clearInterval(eventsTimer); eventsTimer = null; }
}

function clearEvents() {
  document.getElementById('eventsBanner').style.display = 'none';
  document.getElementById('eventsPanel').style.display = 'none';
  document.getElementById('eventsList').innerHTML = '';
}

function renderEvents(events) {
  const banner = document.getElementById('eventsBanner');
  const panel  = document.getElementById('eventsPanel');
  const list   = document.getElementById('eventsList');

  const imminent = events.filter(e => e.urgency === 'imminent' || e.urgency === 'soon');

  if (imminent.length > 0) {
    const first = imminent[0];
    const label = first.type === 'CROSS' ? '✕ CROSSING' : first.type === 'OVERTAKE' ? '↗ OVERTAKE' : '↙ OVERTAKEN';
    banner.textContent = `${label} in ~${first.mins_until} min — ${first.other_train} ${first.other_name} at ${first.station_name}`;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }

  if (events.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  let html = '';
  for (const e of events.slice(0, 20)) {
    const timeStr = e.mins_until < 60
      ? e.mins_until + ' min'
      : Math.floor(e.mins_until / 60) + 'h ' + (e.mins_until % 60) + 'm';

    html += `<div class="event-card ${e.urgency}">
      <span class="event-tag ${e.type}">${e.type}</span>
      <span class="event-time">${timeStr}</span>
      <span class="event-detail"><strong>${e.other_train}</strong> ${e.other_name} at ${e.station_name}</span>
    </div>`;
  }
  list.innerHTML = html;
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

  let html = '<table><thead><tr><th>Train</th><th>Name</th><th>Station</th></tr></thead><tbody>';
  for (const t of data.trains || []) {
    const cls = t.is_reference ? ' class="ref"' : '';
    html += `<tr id="r-${t.train_number}"${cls}>
      <td>${t.train_number}</td>
      <td>${t.train_name}</td>
      <td class="stn">${t.current_station || ''}</td>
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
