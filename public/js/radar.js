// public/js/radar.js — Radar tab + crossing/overtake events
import { map, layers, markers, prevCoords, clearAll, flyTo, trainIcon, bearing } from './map.js';

let socket = null;
let mainTrain = '';
let journeyDate = '';
let eventsTimer = null;
let trackedTrains = [];
let journeyData = { route: [], pois: [] };
let journeyVisible = true;

export function init(io) {
  socket = io;
  const form    = document.getElementById('radarForm');
  const scanBtn = document.getElementById('scanBtn');
  const stopBtn = document.getElementById('stopBtn');
  const liveBar = document.getElementById('liveStatus');
  const journeyToggle = document.getElementById('journeyToggle');

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
    resetJourneyOverlay();
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
      renderJourneyOverlay(data);
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
          train_dates: data.train_dates || {},
          ref_coords: data.center,
        });
        stopBtn.style.display = 'flex';
        stopBtn.disabled = false;
      }

      // Run initial POI check using reference train position
      if (data.center && window._poiCheck) {
        window._poiCheck(data.center[0], data.center[1], 0);
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

  journeyToggle.addEventListener('click', () => {
    journeyVisible = !journeyVisible;
    drawJourneyLayer();
    updateJourneyToggle();
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
      const row = document.getElementById('r-' + t.train_number);
      const isOpposite = (t.direction === 'opposite') || (row && row.classList.contains('opp'));

      let color = '#0077b6'; // Default blue
      if (t.is_reference) color = '#e63946'; // Red for reference
      else if (isOpposite) color = '#f4a261'; // Orange for opposite

      mk.setLatLng(c);
      mk.setIcon(trainIcon(color, t.heading));
      mk.setTooltipContent(tooltip(t)).setPopupContent(tooltip(t));
      prevCoords[t.train_number] = c;

      if (row) {
        const stnCell = row.querySelector('.stn');
        if (stnCell) stnCell.textContent = t.current_station || '';
        
        const distCell = row.querySelector('.dist');
        if (distCell && t.distance_km != null) {
          let arrow = '';
          if (t.trend === 'increasing') arrow = ' ↑';
          else if (t.trend === 'decreasing') arrow = ' ↓';
          distCell.textContent = t.distance_km + ' km' + arrow;
          row.dataset.dist = t.distance_km;
        }

        const spdCell = row.querySelector('.spd');
        if (spdCell && t.speed != null) {
          spdCell.textContent = t.speed + ' km/h';
        }

        // Dynamically hide/show based on live distance
        if (t.distance_km != null && !t.is_reference) {
          if (t.distance_km > window.currentUiRadius) {
            row.style.display = 'none';
            if (map.hasLayer(mk)) mk.removeFrom(map);
          } else {
            row.style.display = '';
            if (!map.hasLayer(mk)) mk.addTo(layers.trains);
          }
        }
        
        // Dynamically remove if confirmed passed
        if (t.has_passed) {
          row.remove();
          if (map.hasLayer(mk)) mk.removeFrom(map);
          delete markers[t.train_number];
        }
      }

      // Feed reference train position to POI geofence engine
      if (t.is_reference && window._poiCheck) {
        window._poiCheck(c[0], c[1], t.speed || 0);
      }
    }

    // Re-sort table by distance
    const tbody = document.querySelector('#radarResults tbody');
    if (tbody) {
      const rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort((a, b) => {
        if (a.classList.contains('ref')) return -1;
        if (b.classList.contains('ref')) return 1;
        const distA = parseFloat(a.dataset.dist) || Infinity;
        const distB = parseFloat(b.dataset.dist) || Infinity;
        return distA - distB;
      });
      rows.forEach(r => tbody.appendChild(r));
    }
  });
}

function resetJourneyOverlay() {
  journeyData = { route: [], pois: [] };
  journeyVisible = true;
  layers.journey.clearLayers();
  const overlay = document.getElementById('journeyOverlay');
  if (overlay) overlay.style.display = 'none';
  updateJourneyToggle();
}

function renderJourneyOverlay(data) {
  journeyData = {
    route: Array.isArray(data.journey_route) ? data.journey_route : [],
    pois: Array.isArray(data.journey_pois) ? data.journey_pois : [],
  };

  const overlay = document.getElementById('journeyOverlay');
  const summary = document.getElementById('journeySummary');
  if (!journeyData.route.length) {
    resetJourneyOverlay();
    return;
  }

  const routeCount = journeyData.route.length;
  const poiCount = journeyData.pois.length;
  summary.textContent = `${routeCount} stops, ${poiCount} things on the way`;
  overlay.style.display = 'flex';
  journeyVisible = true;
  updateJourneyToggle();
  drawJourneyLayer();
}

function updateJourneyToggle() {
  const btn = document.getElementById('journeyToggle');
  if (!btn) return;
  btn.textContent = journeyVisible ? 'Hide' : 'Show';
  btn.classList.toggle('muted', !journeyVisible);
}

function drawJourneyLayer() {
  layers.journey.clearLayers();
  if (!journeyVisible || !journeyData.route.length) return;

  const coords = journeyData.route.map(s => s.coords).filter(Boolean);
  if (coords.length > 1) {
    L.polyline(coords, {
      color: '#2a9d8f',
      weight: 4,
      opacity: 0.72,
      dashArray: '10 8',
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(layers.journey).bindTooltip('Remaining route');
  }

  for (let i = 0; i < journeyData.route.length; i++) {
    const station = journeyData.route[i];
    if (!station.coords) continue;
    const isMajorDot = i === 0 || i === journeyData.route.length - 1 || i % 5 === 0;
    L.circleMarker(station.coords, {
      radius: isMajorDot ? 4 : 2,
      fillColor: i === 0 ? '#e63946' : '#2a9d8f',
      color: '#fff',
      weight: isMajorDot ? 1 : 0.5,
      fillOpacity: isMajorDot ? 0.9 : 0.45,
      opacity: 0.7,
    }).addTo(layers.journey).bindTooltip(station.code, { direction: 'top' });
  }

  for (const poi of journeyData.pois) {
    if (!poi.coords) continue;
    const marker = L.marker(poi.coords, { icon: poiIcon(poi) })
      .bindTooltip(`<b>${escapeHtml(poi.name)}</b><br>${escapeHtml(poi.category || poi.type || 'POI')}`, { direction: 'top' })
      .bindPopup(poiPopup(poi));
    marker.addTo(layers.journey);
  }
}

function poiIcon(poi) {
  const color = poiColor(poi.category || poi.type);
  const letter = (poi.category || poi.type || '?').slice(0, 1).toUpperCase();
  return L.divIcon({
    className: 'poi-route-marker',
    html: `<span style="background:${color}">${letter}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

function poiColor(kind = '') {
  const k = String(kind).toLowerCase();
  if (k.includes('river') || k.includes('bridge')) return '#0077b6';
  if (k.includes('wildlife')) return '#2a9d8f';
  if (k.includes('historical') || k.includes('battle') || k.includes('fort')) return '#e76f51';
  return '#6c757d';
}

function poiPopup(poi) {
  const meta = [
    poi.year ? escapeHtml(poi.year) : '',
    poi.nearest_station ? `Near ${escapeHtml(poi.nearest_station)}` : '',
    poi.route_distance_km != null ? `${poi.route_distance_km} km from route` : '',
  ].filter(Boolean).join(' • ');

  return `<div class="poi-popup">
    <strong>${escapeHtml(poi.name)}</strong>
    <span>${escapeHtml(poi.category || poi.type || 'POI')}</span>
    ${meta ? `<small>${meta}</small>` : ''}
    ${poi.story ? `<p>${escapeHtml(poi.story)}</p>` : ''}
  </div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[ch]));
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

  window.currentUiRadius = data.ui_radius || Infinity;

  let html = '<table><thead><tr><th>Train</th><th>Name</th><th>Station</th><th>Distance</th><th>Speed</th></tr></thead><tbody>';
  for (const t of data.trains || []) {
    const cls = t.is_reference ? ' class="ref"' : '';
    const distStr = t.distance_km != null ? t.distance_km + ' km' : '';
    const spdStr = t.speed != null ? t.speed + ' km/h' : '-';
    const distVal = t.distance_km != null ? t.distance_km : Infinity;
    
    const isVisible = t.is_reference || distVal <= window.currentUiRadius;
    const styleAttr = isVisible ? '' : 'style="display: none;"';
    
    const classNames = [];
    if (t.is_reference) classNames.push('ref');
    if (t.direction === 'opposite') classNames.push('opp');
    else if (t.direction === 'same') classNames.push('same');
    
    const clsAttr = classNames.length ? ` class="${classNames.join(' ')}"` : '';

    html += `<tr id="r-${t.train_number}"${clsAttr} data-dist="${distVal}" ${styleAttr}>
      <td>${t.train_number}</td>
      <td>${t.train_name}</td>
      <td class="stn">${t.current_station || ''}</td>
      <td class="dist">${distStr}</td>
      <td class="spd">${spdStr}</td>
    </tr>`;

    if (t.coords) {
      let color = '#0077b6';
      if (t.is_reference) color = '#e63946';
      else if (t.direction === 'opposite') color = '#f4a261';
      
      const mk = L.marker(t.coords, { icon: trainIcon(color, t.heading) })
        .bindTooltip(tooltip(t), { direction: 'top' })
        .bindPopup(tooltip(t));
      
      if (isVisible) {
        mk.addTo(layers.trains);
        bounds.extend(t.coords);
      }
      
      markers[t.train_number] = mk;
      prevCoords[t.train_number] = t.coords;
    }
  }
  html += '</tbody></table>';
  container.innerHTML = html;
  flyTo(bounds);

  // Add click listener for rows
  const tbody = container.querySelector('tbody');
  if (tbody) {
    tbody.addEventListener('click', e => {
      const tr = e.target.closest('tr');
      if (!tr || !tr.id) return;
      const tn = tr.id.replace('r-', '');
      const mk = markers[tn];
      if (mk) {
        map.flyTo(mk.getLatLng(), 11, { animate: true, duration: 1 });
        setTimeout(() => mk.openPopup(), 1000);
      }
    });
  }
}

function tooltip(t) {
  let extra = '';
  if (t.distance_km != null && !t.is_reference) {
    let arrow = '';
    if (t.trend === 'increasing') arrow = ' ↑';
    else if (t.trend === 'decreasing') arrow = ' ↓';
    extra += `<br>Dist: ${t.distance_km} km${arrow}`;
  }
  if (t.speed != null) extra += ` • Spd: ${t.speed} km/h`;

  return '<b>' + t.train_number + '</b> ' + t.train_name
    + '<br>' + (t.current_station || '')
    + (t.delay_min != null ? ' • ' + t.delay_min + ' min late' : '')
    + extra;
}

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'status-msg ' + type;
}
