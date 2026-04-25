// ============================================================
// MAP INITIALIZATION
// ============================================================
const map = L.map('map', { zoomControl: false }).setView([20.5937, 78.9629], 5);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>'
}).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);

// ============================================================
// LAYER GROUPS
// ============================================================
const referenceMarkerLayer = L.layerGroup().addTo(map);
const trainMarkersLayer    = L.layerGroup().addTo(map);
const reachSpiderLayer     = L.layerGroup().addTo(map);
const journeysLayer        = L.layerGroup().addTo(map);

let trainMarkers        = {};
let frontendStationCoordsMap = {};
let trainPreviousCoords = {};

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function getTrainIcon(color, heading) {
    const rotate = heading !== null ? `transform:rotate(${heading}deg);` : '';
    const dot    = heading === null ? `<circle cx="12" cy="12" r="3.5" fill="rgba(0,0,0,0.6)"/>` : '';
    const svg = `<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"
        style="${rotate}transition:transform .4s ease-out;">
        <path d="M12 2L3 20L12 15L21 20Z" fill="${color}" stroke="#000" stroke-width=".8" stroke-linejoin="round"/>
        ${dot}</svg>`;
    return L.divIcon({
        className: 'train-marker', html: svg,
        iconSize: [22, 22], iconAnchor: [11, 11], tooltipAnchor: [11, -4]
    });
}

function markerColor(isRef, isPrecise) {
    return isRef ? '#ff3366' : isPrecise ? '#00e5ff' : '#ffaa00';
}

function interpolateCoords(c1, c2, f) {
    if (!c1 || !c2 || f == null || f < 0 || f > 1) return null;
    const lat = c1[0] + f * (c2[0] - c1[0]);
    const lon = c1[1] + f * (c2[1] - c1[1]);
    return (isNaN(lat) || isNaN(lon)) ? null : [lat, lon];
}

function bearing(lat1, lon1, lat2, lon2) {
    const toR = d => d * Math.PI / 180, toD = r => r * 180 / Math.PI;
    const p1 = toR(lat1), p2 = toR(lat2), dl = toR(lon2 - lon1);
    return (toD(Math.atan2(
        Math.sin(dl) * Math.cos(p2),
        Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
    )) + 360) % 360;
}

function showStatus(id, msg, type, dur) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.className = 'statusBox ' + type;
    el.style.display = 'block';
    clearTimeout(el._t);
    if (dur) el._t = setTimeout(() => { el.style.display = 'none'; }, dur);
}

function resolveCoords(train) {
    if (train.location_type === 'at_station' && train.coords_at) return { coords: train.coords_at, approx: false };
    if (train.location_type === 'between_stations' && train.coords_between1 && train.coords_between2 && train.location_fraction != null) {
        const c = interpolateCoords(train.coords_between1, train.coords_between2, train.location_fraction);
        return c ? { coords: c, approx: !train.location_precise } : { coords: train.coords_between1, approx: true };
    }
    return { coords: train.coords_at || train.coords_between1 || train.coords_between2 || null, approx: true };
}

// ============================================================
// STATION AUTOCOMPLETE (DATALIST)
// ============================================================
function loadStationData() {
    fetch('/get_rail_stations')
        .then(r => r.ok ? r.json() : Promise.reject('Network error'))
        .then(geo => {
            frontendStationCoordsMap = {};
            const dl = document.getElementById('station_list');
            dl.innerHTML = '';
            const seen = new Set();
            (geo.features || []).forEach(f => {
                if (!f.geometry || f.geometry.type !== 'Point' || !f.properties) return;
                const p = f.properties;
                const code = (p.code || p.STN_CODE || p.station_code || '').toString().trim().toUpperCase();
                const name = p.name || p.NAME || '';
                const ll = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
                if (code) frontendStationCoordsMap[code] = ll;
                if (name) frontendStationCoordsMap[name.toUpperCase()] = ll;
                if (code && !seen.has(code)) {
                    const o = document.createElement('option');
                    o.value = code;
                    if (name) o.label = `${name} (${code})`;
                    dl.appendChild(o);
                    seen.add(code);
                }
            });
            showStatus('status', 'Network ready.', 'info', 2000);
        })
        .catch(e => { console.error(e); showStatus('status', 'Failed to load stations.', 'error'); });
}
loadStationData();

// ============================================================
// TAB SWITCHING
// ============================================================
window.switchTab = function(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    if (socket.connected) socket.emit('stop_tracking');
    trainMarkersLayer.clearLayers();
    referenceMarkerLayer.clearLayers();
    reachSpiderLayer.clearLayers();
    journeysLayer.clearLayers();
    trainMarkers = {};
    const tbl = document.getElementById('locationTable');
    if (tbl) tbl.style.display = 'none';
    const liveEl = document.getElementById('liveTimeDisplay');
    if (liveEl) liveEl.style.display = 'none';
    const startBtn = document.getElementById('startTrackingBtn');
    if (startBtn) startBtn.style.display = 'none';
    const stopB = document.getElementById('stopBtn');
    if (stopB) stopB.style.display = 'none';

    if (tab === 'radar') {
        document.getElementById('radarTab').classList.add('active');
        document.getElementById('locationForm').classList.add('active');
    } else if (tab === 'reach') {
        document.getElementById('reachTab').classList.add('active');
        document.getElementById('reachForm').classList.add('active');
    } else if (tab === 'journeys') {
        document.getElementById('journeysTab').classList.add('active');
        document.getElementById('journeysPanel').classList.add('active');
    }
};

// ============================================================
// SLIDER
// ============================================================
window.updateSliderLabel = function(v) {
    document.getElementById('hours_val').textContent = v;
};
updateSliderLabel(24);
const journeyDateInput = document.getElementById('journey_date');
if (journeyDateInput && !journeyDateInput.value) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    journeyDateInput.value = `${yyyy}-${mm}-${dd}`;
}

// ============================================================
// SOCKET.IO
// ============================================================
const socket = io();
socket.on('connect', () => showStatus('status', 'Connected.', 'success', 2000));
socket.on('disconnect', () => {
    showStatus('status', 'Disconnected from server.', 'error');
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('startTrackingBtn').style.display = 'none';
    document.getElementById('submitBtn').disabled = false;
});

// ============================================================
// RADAR TAB — LIVE ONLY
// ============================================================
let currentTrackingTrains = [];
let currentRefStationCode = null;
let currentSpatialRangeKm = null;

document.getElementById('locationForm').addEventListener('submit', function(e) {
    e.preventDefault();
    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    showStatus('status', 'Querying live rail network...', 'info');
    trainMarkersLayer.clearLayers();
    referenceMarkerLayer.clearLayers();
    reachSpiderLayer.clearLayers();
    trainMarkers = {};
    trainPreviousCoords = {};
    document.getElementById('locationTbody').innerHTML = '';
    document.getElementById('locationTable').style.display = 'none';
    document.getElementById('startTrackingBtn').style.display = 'none';
    document.getElementById('stopBtn').style.display = 'none';

    const fd = new FormData(this);
    window._mainTrain = fd.get('main_train');
    if (socket.connected) socket.emit('stop_tracking');

    fetch('/find_location_at_ref_time', { method: 'POST', body: fd })
        .then(r => r.json())
        .then(data => {
            if (data.error) throw new Error(data.error);
            showStatus('status', data.message || 'Scan complete.', data.trains && data.trains.length ? 'success' : 'info');
            const bounds = L.latLngBounds([]);

            // Reference station marker
            const rc = data.ref_station_coords || (data.ref_station_code ? frontendStationCoordsMap[data.ref_station_code.toUpperCase()] : null);
            if (rc) {
                L.circleMarker(rc, { radius: 10, fillColor: '#fff', color: '#333', weight: 2, fillOpacity: .9 })
                    .addTo(referenceMarkerLayer).bindPopup(`<b>Ref: ${data.ref_station_code}</b>`);
                bounds.extend(rc);
            }

            currentTrackingTrains = data.trains_to_track || [];
            currentRefStationCode = data.ref_station_code || null;
            currentSpatialRangeKm = data.spatial_range_km || null;

            if (data.trains && data.trains.length) {
                const tbl = document.getElementById('locationTable');
                const tbody = document.getElementById('locationTbody');
                tbl.style.display = 'table';
                data.trains.forEach(t => {
                    const { coords, approx } = resolveCoords(t);
                    const isRef = t.is_reference_train === true;
                    // Table row
                    const row = tbody.insertRow();
                    row.id = 'train-row-' + t.train_number;
                    if (isRef) row.classList.add('reference-train-row');
                    row.insertCell().textContent = t.train_number;
                    row.insertCell().textContent = t.train_name || 'N/A';
                    row.insertCell().textContent = t.location_description || '';
                    // Map marker
                    if (coords) {
                        const mk = L.marker(coords, { icon: getTrainIcon(markerColor(isRef, !approx), null) })
                            .addTo(trainMarkersLayer)
                            .bindTooltip(`<b>${t.train_number}</b> ${t.train_name || ''}<br>${t.location_description || ''}`, { direction: 'top' });
                        trainMarkers[t.train_number] = mk;
                        trainPreviousCoords[t.train_number] = coords;
                        bounds.extend(coords);
                    }
                });
                if (bounds.isValid()) map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 10 });
                if (currentTrackingTrains.length) {
                    document.getElementById('startTrackingBtn').style.display = 'flex';
                    document.getElementById('startTrackingBtn').disabled = false;
                }
            }
            btn.disabled = false;
        })
        .catch(err => { showStatus('status', err.message, 'error'); btn.disabled = false; });
});

document.getElementById('startTrackingBtn').addEventListener('click', () => {
    if (!socket.connected || !currentTrackingTrains.length) return;
    socket.emit('start_tracking', {
        trains_to_track: currentTrackingTrains,
        tracking_mode: 'live',
        ref_station_code: currentRefStationCode,
        spatial_range_km: currentSpatialRangeKm
    });
    document.getElementById('startTrackingBtn').disabled = true;
    showStatus('trackingStatus', 'Starting live tracking...', 'info');
});

document.getElementById('stopBtn').addEventListener('click', () => {
    if (socket.connected) socket.emit('stop_tracking');
    document.getElementById('stopBtn').disabled = true;
});

socket.on('tracking_status', d => {
    if (d.status === 'started') {
        showStatus('trackingStatus', d.message, 'success');
        document.getElementById('startTrackingBtn').style.display = 'none';
        document.getElementById('stopBtn').style.display = 'flex';
        document.getElementById('stopBtn').disabled = false;
        document.getElementById('submitBtn').disabled = true;
        document.getElementById('liveTimeDisplay').style.display = 'block';
    } else if (d.status === 'stopped') {
        showStatus('trackingStatus', 'Live tracking stopped.', 'info');
        document.getElementById('stopBtn').style.display = 'none';
        document.getElementById('startTrackingBtn').style.display = 'flex';
        document.getElementById('startTrackingBtn').disabled = false;
        document.getElementById('submitBtn').disabled = false;
        document.getElementById('liveTimeDisplay').style.display = 'none';
    } else {
        showStatus('trackingStatus', d.message, 'error');
    }
});

socket.on('location_update', data => {
    const now = new Date();
    document.getElementById('liveTimeDisplay').innerHTML = `<span style="opacity:.6">LIVE</span> ${now.toLocaleTimeString()}`;

    (data.trains || []).forEach(t => {
        const mk = trainMarkers[t.train_number];
        const { coords } = resolveCoords(t);
        if (mk && coords) {
            const prev = trainPreviousCoords[t.train_number];
            let head = null;
            if (prev && (Math.abs(prev[0]-coords[0]) > 1e-5 || Math.abs(prev[1]-coords[1]) > 1e-5))
                head = bearing(prev[0], prev[1], coords[0], coords[1]);
            mk.setLatLng(coords);
            mk.setIcon(getTrainIcon(markerColor(t.train_number === window._mainTrain, t.location_precise), head));
            mk.setTooltipContent(`<b>${t.train_number}</b> ${t.train_name||''}<br>${t.location_description||''}`);
            trainPreviousCoords[t.train_number] = coords;
        }
        const row = document.getElementById('train-row-' + t.train_number);
        if (row && row.cells[2]) row.cells[2].textContent = t.location_description || '';
    });
});

// ============================================================
// REACHABILITY (FRONTIER SPIDERWEB) TAB LOGIC
// ============================================================
document.getElementById('reachForm').addEventListener('submit', function(e) {
    e.preventDefault();
    const btn = document.getElementById('reachBtn');
    btn.disabled = true;
    showStatus('status', 'Calculating frontier...', 'info');
    reachSpiderLayer.clearLayers();
    trainMarkersLayer.clearLayers();
    referenceMarkerLayer.clearLayers();
    document.getElementById('reachResultsBody').innerHTML = '';
    document.getElementById('reachResultsTable').style.display = 'none';

    const fd = new FormData(this);
    const hours = document.getElementById('max_hours').value;
    fd.set('max_hours', hours);

    fetch('/calculate_reach', { method: 'POST', body: fd })
        .then(r => r.json())
        .then(data => {
            if (data.error) throw new Error(data.error);
            showStatus('status', data.message, 'success');
            const bounds = L.latLngBounds([]);
            const oc = data.origin_coords;

            if (!oc) { btn.disabled = false; return; }

            // Origin marker
            L.circleMarker(oc, {
                radius: 12, fillColor: '#00e5ff', color: '#fff', weight: 2,
                fillOpacity: 1, className: 'origin-pulse'
            }).addTo(reachSpiderLayer).bindPopup(`<b>${data.origin_name}</b><br>Origin`);
            bounds.extend(oc);

            const frontier = data.frontier_stations || [];
            if (frontier.length === 0) {
                showStatus('status', 'No reachable stations found.', 'info');
                btn.disabled = false;
                return;
            }

            // Frontier polygon
            const polygonCoords = frontier.map(s => s.coords);
            if (polygonCoords.length > 2) {
                L.polygon(polygonCoords, {
                    color: '#00e5ff', weight: 1.5, opacity: 0.6,
                    fillColor: '#00e5ff', fillOpacity: 0.06,
                    dashArray: '6 4'
                }).addTo(reachSpiderLayer);
            }

            // Spiderweb lines + markers
            const tbody = document.getElementById('reachResultsBody');
            const tbl   = document.getElementById('reachResultsTable');
            tbl.style.display = 'table';

            frontier.forEach(stn => {
                if (!stn.coords) return;
                L.polyline([oc, stn.coords], {
                    color: '#00e5ff', weight: 1.2, opacity: 0.35
                }).addTo(reachSpiderLayer);

                L.circleMarker(stn.coords, {
                    radius: 5, fillColor: '#ff3366', color: '#000',
                    weight: 0.5, fillOpacity: 0.9
                }).addTo(reachSpiderLayer)
                  .bindTooltip(
                      `<b>${stn.name}</b> (${stn.code})<br>` +
                      `<span style="opacity:.7">via</span> ${stn.train_name} (${stn.train_number})<br>` +
                      `<span style="opacity:.7">travel</span> ${stn.travel_time_str} &bull; ${Math.round(stn.geo_distance_km)} km`,
                      { direction: 'top' }
                  );
                bounds.extend(stn.coords);

                const row = tbody.insertRow();
                row.insertCell().textContent = stn.name;
                row.insertCell().textContent = stn.code;
                row.insertCell().textContent = stn.train_number;
                row.insertCell().textContent = stn.travel_time_str;
                row.insertCell().textContent = Math.round(stn.geo_distance_km) + ' km';
            });

            if (bounds.isValid()) map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 8 });
            btn.disabled = false;
        })
        .catch(err => { showStatus('status', err.message, 'error'); btn.disabled = false; });
});

// ============================================================
// MY JOURNEYS TAB LOGIC
// ============================================================
const JOURNEY_COLORS = [
    '#ff3366', '#00e5ff', '#ffaa00', '#00e676', '#bb86fc',
    '#ff6d00', '#18ffff', '#ff4081', '#76ff03', '#ea80fc'
];

window.loadJourneys = function() {
    const btn = document.getElementById('loadJourneysBtn');
    btn.disabled = true;
    showStatus('status', 'Loading routes from schedule...', 'info');
    journeysLayer.clearLayers();
    document.getElementById('journeysTbody').innerHTML = '';
    document.getElementById('journeysTable').style.display = 'none';

    fetch('/get_journeys')
        .then(r => r.json())
        .then(data => {
            if (data.error) throw new Error(data.error);

            const journeys = data.journeys || [];
            if (journeys.length === 0) {
                showStatus('status', 'No journeys found. Add trips or sync Gmail.', 'info');
                btn.disabled = false;
                return;
            }

            const bounds = L.latLngBounds([]);
            const tbody = document.getElementById('journeysTbody');
            const tbl = document.getElementById('journeysTable');
            tbl.style.display = 'table';

            const stationSet = new Set();

            journeys.forEach((j, i) => {
                const color = JOURNEY_COLORS[i % JOURNEY_COLORS.length];
                const routeCoords = j.route_coords;
                const oc = j.origin_coords;
                const dc = j.destination_coords;

                const lineCoords = routeCoords || (oc && dc ? [oc, dc] : null);

                if (lineCoords && lineCoords.length >= 2) {
                    L.polyline(lineCoords, {
                        color: color, weight: 2.5, opacity: 0.55
                    }).addTo(journeysLayer)
                      .bindTooltip(
                          `<b>${j.origin} &rarr; ${j.destination}</b><br>` +
                          `Train ${j.train_number} ${j.train_name || ''}<br>` +
                          (j.route_km ? `<span style="opacity:.7">${Math.round(j.route_km)} km &bull; ${j.travel_time_str || ''}</span><br>` : '') +
                          `<span style="opacity:.5">${j.journey_date || 'N/A'}</span>`,
                          { sticky: true }
                      );
                    lineCoords.forEach(c => bounds.extend(c));
                }

                stationSet.add(j.origin);
                stationSet.add(j.destination);

                const row = tbody.insertRow();
                row.innerHTML = `
                    <td>${j.journey_date || 'N/A'}</td>
                    <td><span style="color:${color};font-weight:600">${j.origin}</span> &rarr; ${j.destination}</td>
                    <td>${j.train_number}</td>
                    <td>${j.route_km ? Math.round(j.route_km) : '-'}</td>
                `;
            });

            const totalH = Math.floor((data.total_minutes || 0) / 60);
            const totalKm = data.total_km || 0;

            const statsEl = document.getElementById('journeyStats');
            statsEl.innerHTML = `
                <div class="stat-grid">
                    <div class="stat-card">
                        <div class="stat-number">${journeys.length}</div>
                        <div class="stat-label">Trips</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${stationSet.size}</div>
                        <div class="stat-label">Stations</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${totalKm.toLocaleString()}</div>
                        <div class="stat-label">Total KM</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${totalH}h</div>
                        <div class="stat-label">On Trains</div>
                    </div>
                </div>
            `;

            showStatus('status', `${journeys.length} journeys, ${totalKm.toLocaleString()} km total.`, 'success');
            if (bounds.isValid()) map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 7 });
            btn.disabled = false;
        })
        .catch(err => { showStatus('status', err.message, 'error'); btn.disabled = false; });
};

// ============================================================
// MANUAL TRIP ENTRY
// ============================================================
window.addTrip = function(e) {
    e.preventDefault();
    const btn = document.getElementById('addTripBtn');
    btn.disabled = true;
    showStatus('status', 'Adding trip...', 'info');

    const fd = new FormData(document.getElementById('addTripForm'));

    fetch('/add_journey', { method: 'POST', body: fd })
        .then(r => r.json())
        .then(data => {
            if (data.error) throw new Error(data.error);
            showStatus('status', data.message, 'success', 3000);
            document.getElementById('addTripForm').reset();
            btn.disabled = false;
            loadJourneys();
        })
        .catch(err => { showStatus('status', err.message, 'error'); btn.disabled = false; });
};
