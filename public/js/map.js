// public/js/map.js — Leaflet map abstraction
const map = L.map('map', { zoomControl: false }).setView([22.5, 78.9], 5);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://carto.com/">CARTO</a> &bull; &copy; <a href="https://osm.org/">OSM</a>'
}).addTo(map);

L.control.zoom({ position: 'topright' }).addTo(map);

export const layers = {
  trains: L.layerGroup().addTo(map),
  ref:    L.layerGroup().addTo(map),
  reach:  L.layerGroup().addTo(map),
};

export const markers = {};        // trainNumber → marker
export const prevCoords = {};     // trainNumber → [lat,lng]

export function clearAll() {
  layers.trains.clearLayers();
  layers.ref.clearLayers();
  layers.reach.clearLayers();
  Object.keys(markers).forEach(k => delete markers[k]);
  Object.keys(prevCoords).forEach(k => delete prevCoords[k]);
}

export function flyTo(bounds) {
  if (bounds.isValid()) map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 10, duration: .8 });
}

export function trainIcon(color, heading) {
  const rot = heading != null ? `transform:rotate(${heading}deg);` : '';
  const svg = `<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"
    style="${rot}transition:transform .4s">
    <path d="M12 2L3 20L12 15L21 20Z" fill="${color}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
  </svg>`;
  return L.divIcon({ className: 'train-marker', html: svg, iconSize: [20, 20], iconAnchor: [10, 10] });
}

export function bearing(lat1, lon1, lat2, lon2) {
  const toR = d => d * Math.PI / 180, toD = r => r * 180 / Math.PI;
  const p1 = toR(lat1), p2 = toR(lat2), dl = toR(lon2 - lon1);
  return (toD(Math.atan2(
    Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  )) + 360) % 360;
}

export { map };
