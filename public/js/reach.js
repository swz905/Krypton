// public/js/reach.js — Reachability tab logic
import { layers, clearAll, flyTo } from './map.js';

export function init() {
  const form = document.getElementById('reachForm');
  const btn  = document.getElementById('reachBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    clearAll();
    showStatus('reachStatus', 'Computing reachability frontier...', 'info');
    document.getElementById('reachResults').innerHTML = '';

    const fd = Object.fromEntries(new FormData(form));

    try {
      const resp = await fetch('/api/reach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fd),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      showStatus('reachStatus', data.message, 'success');
      renderReach(data);
    } catch (err) {
      showStatus('reachStatus', err.message, 'error');
    }
    btn.disabled = false;
  });
}

function renderReach(data) {
  const bounds = L.latLngBounds([]);
  const oc = data.origin_coords;
  if (!oc) return;

  // Origin marker
  L.circleMarker(oc, {
    radius: 10, fillColor: '#0077b6', color: '#fff', weight: 2, fillOpacity: 1,
  }).addTo(layers.reach).bindPopup(`<b>${data.origin_name}</b><br>Origin`);
  bounds.extend(oc);

  const stations = data.frontier_stations || [];
  if (!stations.length) return;

  // Polygon hull
  const polyCoords = stations.map(s => s.coords).filter(Boolean);
  if (polyCoords.length > 2) {
    L.polygon(polyCoords, {
      color: '#0077b6', weight: 1.5, opacity: .5,
      fillColor: '#00b4d8', fillOpacity: .04,
      dashArray: '6 4',
    }).addTo(layers.reach);
  }

  // Spider lines + dots + table
  let html = `<table><thead><tr><th>Station</th><th>Train</th><th>Time</th><th>Dist</th></tr></thead><tbody>`;
  for (const s of stations) {
    if (!s.coords) continue;
    L.polyline([oc, s.coords], { color: '#00b4d8', weight: 1, opacity: .3 }).addTo(layers.reach);
    L.circleMarker(s.coords, { radius: 4, fillColor: '#e63946', color: '#fff', weight: .5, fillOpacity: .9 })
      .addTo(layers.reach)
      .bindTooltip(`<b>${s.name}</b> (${s.code})<br>${s.train_number} ${s.train_name}<br>${s.travel_time_str} • ${Math.round(s.geo_distance_km)} km`, { direction: 'top' });
    bounds.extend(s.coords);

    html += `<tr>
      <td>${s.name} (${s.code})</td>
      <td>${s.train_number}</td>
      <td>${s.travel_time_str}</td>
      <td class="dist">${Math.round(s.geo_distance_km)} km</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  document.getElementById('reachResults').innerHTML = html;
  flyTo(bounds);
}

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'status-msg ' + type;
}
