# app.py (Updated to simulate the main reference train as well)
from flask import Flask, request, jsonify, render_template, send_from_directory, session
from flask_socketio import SocketIO, emit, join_room, leave_room, disconnect
import utils # Import your specific utils.py
import logging
import math
import os
import json
import sys
import sqlite3
from geopy.distance import geodesic
import time
import threading
import requests
from datetime import datetime, timezone
from dotenv import load_dotenv
import io
import hashlib

try:
    import ijson
except Exception:
    ijson = None

load_dotenv()

# --- Basic Setup ---
app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('FLASK_SECRET_KEY', 'dev_secret_key_replace_me')
log_level = getattr(logging, os.environ.get('LOG_LEVEL', 'INFO').upper(), logging.INFO)
logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s [%(funcName)s:%(lineno)d] - %(message)s')

# --- Choose Async Mode ---
# eventlet monkey-patching causes RecursionError in Python 3.14+ SSL module.
# Force threading mode for compatibility on 3.14+.
async_mode = None
if sys.version_info >= (3, 14):
    async_mode = 'threading'
    logging.info("Python 3.14+ detected - using threading async_mode (eventlet incompatible).")
else:
    try:
        import eventlet
        async_mode = 'eventlet'
        eventlet.monkey_patch()
        logging.info("Using eventlet async_mode for SocketIO.")
    except ImportError:
        try:
            from gevent import monkey
            monkey.patch_all()
            async_mode = 'gevent'
            logging.info("Using gevent async_mode for SocketIO.")
        except ImportError:
            async_mode = 'threading'
            logging.info("Using threading async_mode for SocketIO.")

socketio = SocketIO(app, async_mode=async_mode, cors_allowed_origins="*")

# --- Constants & Globals ---
DEFAULT_SPATIAL_RANGE_KM = 250
MIN_SPATIAL_RANGE_KM = 10
MAX_SPATIAL_RANGE_KM = 3000
backend_station_coords_map = {}
APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, 'data')
RAIL_LINES_FILE = 'hotosm_ind_railways_lines_geojson.geojson'
RAIL_STATIONS_FILE = "enriched_hotosm_stations_v2.geojson"

client_tracking_state = {}
state_lock = threading.Lock()
LIVE_UPDATE_INTERVAL_SECONDS = max(2, int(os.environ.get("LIVE_UPDATE_INTERVAL_SECONDS", "15")))
RAILRADAR_BASE_URL = os.environ.get("RAILRADAR_BASE_URL", "https://api.railradar.in")
LIVE_SNAPSHOT_ENDPOINT = os.environ.get("LIVE_SNAPSHOT_ENDPOINT", "/api/v1/trains/live-map")
LIVE_SNAPSHOT_POLL_SECONDS = max(20, int(os.environ.get("LIVE_SNAPSHOT_POLL_SECONDS", "60")))
RAILRADAR_API_KEY = os.environ.get("RAILRADAR_API_KEY", "").strip()
live_snapshot_lock = threading.Lock()
live_snapshot_cache = {
    "fetched_at": 0.0,
    "rows": [],
    "index": {},
    "etag": None,
    "hash": None,
    "error": None,
}
live_snapshot_thread = None

# --- Load Station Coordinates from DB (Function unchanged) ---
def load_station_coordinates_from_db():
    global backend_station_coords_map
    db_path = getattr(utils, 'DATABASE_PATH', os.path.join(DATA_DIR, 'ir.db'))
    temp_map = {}
    conn = None
    if not os.path.exists(db_path):
        logging.error(f"CRITICAL: Database file for coordinate loading not found at: {db_path}")
        return
    logging.info(f"Attempting to load station coordinates from database table 'Stn': {db_path}")
    try:
        conn = sqlite3.connect(db_path); conn.row_factory = sqlite3.Row; cursor = conn.cursor()
        query = "SELECT code, lat, lng FROM Stn WHERE lat IS NOT NULL AND lng IS NOT NULL"
        cursor.execute(query); rows = cursor.fetchall()
        logging.info(f"Retrieved {len(rows)} rows with non-null lat/lng from Stn table for coord map.")
        count = 0; skipped_invalid = 0
        for row in rows:
            code, lat, lng = row['code'], row['lat'], row['lng']
            if code and isinstance(code, str) and isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
                if -90 <= lat <= 90 and -180 <= lng <= 180:
                    norm_code = code.strip().upper()
                    if not norm_code: skipped_invalid += 1; continue
                    if norm_code not in temp_map: temp_map[norm_code] = [lat, lng]; count += 1
                else: skipped_invalid += 1
            else: skipped_invalid += 1
        backend_station_coords_map = temp_map
        logging.info(f"Finished loading coordinates into memory. Mapped identifiers: {len(backend_station_coords_map)} ({count} valid).")
        if skipped_invalid > 0: logging.warning(f"Skipped {skipped_invalid} rows from Stn table during coord map loading.")
        if not backend_station_coords_map: logging.warning("In-memory coordinate map is empty after loading attempt.")
    except sqlite3.Error as e: logging.exception(f"Database error loading station coordinates from {db_path}: {e}")
    except Exception as e: logging.exception(f"Unexpected error loading station coordinates from DB {db_path}")
    finally:
        if conn: conn.close()

# --- Helper to Get Station Coordinates (Function unchanged) ---
def get_station_coordinates(identifier):
    if not identifier or not backend_station_coords_map: return None
    norm_id = str(identifier).strip().upper()
    return backend_station_coords_map.get(norm_id)


def _railradar_headers():
    return {"X-API-Key": RAILRADAR_API_KEY} if RAILRADAR_API_KEY else {}


def _railradar_auth_params():
    return {"apiKey": RAILRADAR_API_KEY} if RAILRADAR_API_KEY else {}


def _extract_first_lat_lon(payload):
    """Best-effort parser for unknown nested schema (iterative, not recursive)."""
    if payload is None:
        return None

    stack = [payload]
    # Guardrail to avoid pathological payloads causing long scans.
    max_nodes = 200000
    scanned = 0

    while stack:
        node = stack.pop()
        scanned += 1
        if scanned > max_nodes:
            break

        if isinstance(node, dict):
            for lat_key, lon_key in (
                ("current_lat", "current_lng"),
                ("latitude", "longitude"),
                ("lat", "lng"),
                ("lat", "lon"),
                ("y", "x"),
            ):
                lat = node.get(lat_key)
                lon = node.get(lon_key)
                if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
                    return [float(lat), float(lon)]
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)

    return None


def _extract_train_number(row):
    if not isinstance(row, dict):
        return None
    for key in ("trainNumber", "train_number", "number", "trainNo", "train_no"):
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _extract_train_name(row):
    if not isinstance(row, dict):
        return None
    for key in ("trainName", "train_name", "name"):
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _safe_parse_json(raw_bytes):
    """Parse JSON bytes safely, handling deep nesting that causes RecursionError.

    Strategy:
    1. Try json.loads with temporarily raised recursion limit.
    2. If that still fails (RecursionError or other), fall back to ijson streaming.
    3. If ijson is unavailable, return None.
    """
    # --- Stage 1: json.loads with elevated recursion limit ---
    saved_limit = sys.getrecursionlimit()
    try:
        sys.setrecursionlimit(max(saved_limit, 20000))
        payload = json.loads(raw_bytes)
        return payload
    except RecursionError:
        logging.warning("json.loads hit RecursionError even at limit 20000 — falling back to ijson.")
    except Exception as e:
        logging.warning(f"json.loads failed ({type(e).__name__}: {e}) — falling back to ijson.")
    finally:
        sys.setrecursionlimit(saved_limit)

    # --- Stage 2: ijson streaming parse ---
    if ijson is not None:
        try:
            payload = {}
            stream = io.BytesIO(raw_bytes)
            # Try to parse the top-level "data" array items
            data_rows = []
            for item in ijson.items(stream, "data.item"):
                if isinstance(item, dict):
                    data_rows.append(item)
            if data_rows:
                payload["data"] = data_rows
                return payload
            # Fallback: maybe it's a top-level array
            stream.seek(0)
            top_items = []
            for item in ijson.items(stream, "item"):
                if isinstance(item, dict):
                    top_items.append(item)
            if top_items:
                return top_items  # return as list
        except Exception as stream_e:
            logging.warning(f"ijson streaming parse also failed: {type(stream_e).__name__}: {stream_e}")

    return None


def refresh_live_snapshot_cache(force=False):
    now_ts = time.time()
    if not force:
        with live_snapshot_lock:
            if now_ts - live_snapshot_cache["fetched_at"] < LIVE_SNAPSHOT_POLL_SECONDS:
                return live_snapshot_cache

    if not RAILRADAR_API_KEY:
        with live_snapshot_lock:
            live_snapshot_cache["error"] = "RAILRADAR_API_KEY missing."
        return live_snapshot_cache

    endpoint = LIVE_SNAPSHOT_ENDPOINT.lstrip("/")
    url = f"{RAILRADAR_BASE_URL}/{endpoint}"
    try:
        resp = requests.get(
            url,
            params=_railradar_auth_params(),
            headers={"User-Agent": "Mozilla/5.0 (compatible; RailTracker/1.0)",
                     "Accept": "application/json, text/plain, */*",
                     "Origin": "https://railradar.in",
                     "Referer": "https://railradar.in/",
                     **_railradar_headers()},
            timeout=30,
        )
        if resp.status_code == 401:
            raise RuntimeError("RailRadar API key rejected (401).")
        resp.raise_for_status()

        raw_bytes = resp.content
        body_hash = hashlib.sha256(raw_bytes).hexdigest()[:16]
        logging.info(f"Live snapshot fetched: {len(raw_bytes)} bytes, hash={body_hash}")

        # --- Safe JSON parse (handles deep nesting / RecursionError) ---
        payload = _safe_parse_json(raw_bytes)

        rows = []
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            rows = payload["data"]
        elif isinstance(payload, list):
            rows = payload
        elif payload is None:
            raise RuntimeError(
                "Could not parse live snapshot payload with any available parser. "
                f"Response size: {len(raw_bytes)} bytes."
            )
        else:
            # payload is some other dict structure — try to find a list in it
            for key, val in (payload.items() if isinstance(payload, dict) else []):
                if isinstance(val, list) and len(val) > 10:
                    rows = val
                    logging.info(f"Found {len(rows)} rows under key '{key}' in snapshot payload.")
                    break
            if not rows:
                logging.warning(f"Parsed snapshot payload but found no data rows. Keys: {list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__}")

        index = {}
        normalized_rows = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            tn = _extract_train_number(row)
            coords = _extract_first_lat_lon(row)
            if not tn or not coords:
                continue
            normalized_rows.append(row)
            index[tn] = row

        logging.info(f"Live snapshot parsed: {len(normalized_rows)} trains with valid coords (out of {len(rows)} rows).")

        with live_snapshot_lock:
            live_snapshot_cache["fetched_at"] = now_ts
            live_snapshot_cache["rows"] = normalized_rows
            live_snapshot_cache["index"] = index
            live_snapshot_cache["etag"] = resp.headers.get("ETag")
            live_snapshot_cache["hash"] = body_hash
            live_snapshot_cache["error"] = None
    except Exception as e:
        logging.exception("refresh_live_snapshot_cache failed")
        with live_snapshot_lock:
            live_snapshot_cache["error"] = str(e)
    return live_snapshot_cache


def start_live_snapshot_poller_once():
    global live_snapshot_thread
    with state_lock:
        if live_snapshot_thread and live_snapshot_thread.is_alive():
            return
        def _worker():
            while True:
                refresh_live_snapshot_cache(force=True)
                time.sleep(LIVE_SNAPSHOT_POLL_SECONDS)
        live_snapshot_thread = threading.Thread(target=_worker, name="live-snapshot-poller", daemon=True)
        live_snapshot_thread.start()


def get_cached_live_rows(force_refresh=False):
    cache = refresh_live_snapshot_cache(force=force_refresh)
    with live_snapshot_lock:
        return list(cache.get("rows", [])), cache.get("error"), cache.get("fetched_at")


def fetch_live_train_snapshot(train_number):
    if not train_number:
        return {"error": "Missing train number"}
    rows, err, _ = get_cached_live_rows(force_refresh=False)
    if err:
        return {"error": err}
    lookup = { _extract_train_number(r): r for r in rows }
    row = lookup.get(str(train_number))
    if not row:
        return {"error": "Train not present in current snapshot."}
    coords = _extract_first_lat_lon(row)
    if not coords:
        return {"error": "Coordinates missing in snapshot row."}
    return {
        "train_number": str(train_number),
        "coords": coords,
        "train_name": _extract_train_name(row),
        "raw": row
    }


def fetch_train_day_status(train_number, journey_date):
    """Fetch train status/details for a specific journey date."""
    if not train_number or not journey_date:
        return {"error": "Missing train_number or journey_date"}
    url = f"{RAILRADAR_BASE_URL}/api/v1/trains/{train_number}"
    try:
        resp = requests.get(
            url,
            params={"journeyDate": journey_date, "dataType": "full", **_railradar_auth_params()},
            headers=_railradar_headers(),
            timeout=20,
        )
        if resp.status_code == 401:
            return {"error": "RailRadar API key rejected (401)."}
        if resp.status_code >= 400:
            return {"error": f"{resp.status_code} at {url}"}
        payload = resp.json()
        status_text = None
        if isinstance(payload, dict):
            for key in ("runningStatus", "currentStatus", "status", "trainStatus"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    status_text = value.strip()
                    break
            data = payload.get("data")
            if isinstance(data, dict):
                for key in ("runningStatus", "currentStatus", "status", "trainStatus"):
                    value = data.get(key)
                    if isinstance(value, str) and value.strip():
                        status_text = value.strip()
                        break
        coords = _extract_first_lat_lon(payload)
        return {"status_text": status_text, "coords": coords, "raw": payload}
    except Exception as e:
        return {"error": str(e)}

# --- Load coordinates at startup ---
load_station_coordinates_from_db()
start_live_snapshot_poller_once()

# --- Flask Routes (Standard HTTP) ---
@app.route('/')
def index():
    # ... (Function unchanged) ...
    logging.info("Serving index page.")
    return render_template('index.html',
                           default_range=DEFAULT_SPATIAL_RANGE_KM)

# --- GeoJSON Endpoints (Unchanged) ---
@app.route('/get_rail_lines')
def get_rail_lines_geojson():
    # ... (Function unchanged) ...
    logging.debug(f"Request for lines GeoJSON.")
    lines_full_path = os.path.join(DATA_DIR, RAIL_LINES_FILE)
    if not os.path.exists(lines_full_path): return jsonify({"error": "Lines map data file not found."}), 404
    try: return send_from_directory(DATA_DIR, RAIL_LINES_FILE, mimetype='application/json')
    except Exception as e: logging.exception(f"Error serving lines GeoJSON"); return jsonify({"error": "Could not load lines map data."}), 500

@app.route('/get_rail_stations')
def get_rail_stations_geojson():
    # ... (Function unchanged) ...
    logging.debug(f"Request for stations GeoJSON layer file: {RAIL_STATIONS_FILE}")
    stations_full_path = os.path.join(DATA_DIR, RAIL_STATIONS_FILE)
    if not os.path.exists(stations_full_path): return jsonify({"error": "Stations map layer data file not found."}), 404
    try: return send_from_directory(DATA_DIR, RAIL_STATIONS_FILE, mimetype='application/json')
    except Exception as e: logging.exception(f"Error serving stations GeoJSON layer file"); return jsonify({"error": "Could not load stations map layer data."}), 500


# --- Initial Search Route (MODIFIED to include main train in results) ---
@app.route('/find_location_at_ref_time', methods=['POST'])
def find_location_at_ref_time_api():
    logging.info(f"Initial search request received (HTTP POST)")
    if not backend_station_coords_map:
         logging.error("Initial search: Backend station coordinate map is empty.")
         return jsonify({"error": "Server configuration error: Station location data unavailable."}), 500

    data = request.form
    main_train_number = data.get('main_train', '').strip()
    journey_date = data.get('journey_date', '').strip()
    ref_station_identifier = data.get('last_known_station', '').strip()
    spatial_range_km_str = data.get('spatial_range', str(DEFAULT_SPATIAL_RANGE_KM))
    try:
        user_range = int(spatial_range_km_str)
        spatial_range_km = max(MIN_SPATIAL_RANGE_KM, min(user_range, MAX_SPATIAL_RANGE_KM))
    except (ValueError, TypeError):
        spatial_range_km = DEFAULT_SPATIAL_RANGE_KM

    if not RAILRADAR_API_KEY:
        return jsonify({"error": "Server missing RAILRADAR_API_KEY. Add it as an environment variable."}), 500
    if not main_train_number:
        return jsonify({"error": "Missing 'Main Train Number'"}), 400
    if not journey_date:
        journey_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    ref_stn_code = None
    ref_coords = None
    if ref_station_identifier:
        ref_stn_code = utils.get_station_code(ref_station_identifier)
        if ref_stn_code:
            ref_coords = get_station_coordinates(ref_stn_code)

    rows, cache_error, fetched_at = get_cached_live_rows(force_refresh=True)
    if cache_error:
        return jsonify({"error": f"Live snapshot fetch failed: {cache_error}"}), 502

    main_status = fetch_train_day_status(main_train_number, journey_date)

    main_row = None
    for row in rows:
        if str(_extract_train_number(row)) == str(main_train_number):
            main_row = row
            break
    center_coords = _extract_first_lat_lon(main_row) if main_row else None
    if not center_coords and main_status and not main_status.get("error"):
        center_coords = main_status.get("coords")
    if not center_coords and ref_coords:
        center_coords = ref_coords
    if not center_coords:
        return jsonify({"error": "Could not determine live location for main train. Provide a valid Reference Station fallback."}), 404
    center_label = f"train {main_train_number}"
    if ref_stn_code and center_coords == ref_coords:
        center_label = ref_stn_code

    results = []
    details_cache = {}
    main_seen = False
    for row in rows:
        tn = _extract_train_number(row)
        if not tn:
            continue
        coords = _extract_first_lat_lon(row)
        if not coords:
            continue
        try:
            distance_km = geodesic(center_coords, coords).km
        except Exception:
            continue
        is_ref = str(tn) == str(main_train_number)
        if distance_km > spatial_range_km and not is_ref:
            continue
        if tn not in details_cache:
            details_cache[tn] = utils.get_train_details([tn]).get(tn, {})
        train_name = _extract_train_name(row) or details_cache[tn].get("name", "N/A")
        if is_ref:
            main_seen = True
        status_suffix = ""
        if is_ref and main_status and not main_status.get("error") and main_status.get("status_text"):
            status_suffix = f" | {main_status['status_text']}"
        results.append({
            "train_number": str(tn),
            "train_name": train_name,
            "location_description": f"Live position ({distance_km:.1f} km from {center_label}){status_suffix}",
            "relative_km": None,
            "geo_distance_km": float(distance_km),
            "location_type": "at_station",
            "involved_stations": [ref_stn_code] if (is_ref and ref_stn_code) else [],
            "location_precise": True,
            "coords_at": coords,
            "coords_between1": None,
            "coords_between2": None,
            "is_reference_train": is_ref
        })

    if not main_seen:
        main_snap = fetch_live_train_snapshot(main_train_number)
        if main_snap and not main_snap.get("error") and main_snap.get("coords"):
            coords = main_snap["coords"]
            try:
                distance_km = geodesic(center_coords, coords).km
                status_suffix = ""
                if main_status and not main_status.get("error") and main_status.get("status_text"):
                    status_suffix = f" | {main_status['status_text']}"
                results.append({
                    "train_number": str(main_train_number),
                    "train_name": main_snap.get("train_name") or "N/A",
                    "location_description": f"Live position ({distance_km:.1f} km from {center_label}){status_suffix}",
                    "relative_km": None,
                    "geo_distance_km": float(distance_km),
                    "location_type": "at_station",
                    "involved_stations": [ref_stn_code] if ref_stn_code else [],
                    "location_precise": True,
                    "coords_at": coords,
                    "coords_between1": None,
                    "coords_between2": None,
                    "is_reference_train": True
                })
            except Exception:
                pass

    results.sort(key=lambda x: x.get("geo_distance_km", float("inf")))
    main_status_text = main_status.get("status_text") if isinstance(main_status, dict) else None
    status_msg = f" Main train status: {main_status_text}." if main_status_text else ""
    message = f"Found {len(results)} live trains within {spatial_range_km} km of {center_label}.{status_msg} Snapshot age: {int(max(0, time.time() - fetched_at))}s."
    return jsonify({
        "message": message,
        "trains": results,
        "ref_station_code": ref_stn_code or main_train_number,
        "ref_station_coords": center_coords,
        "ref_abs_time": None,
        "trains_to_track": [r["train_number"] for r in results],
        "tracking_mode": "live",
        "spatial_range_km": spatial_range_km,
        "snapshot_fetched_at": fetched_at,
        "journey_date": journey_date,
        "main_train_status": main_status_text,
    }), 200




def update_live_train_locations_task(sid, train_numbers, ref_station_code, spatial_range_km, stop_event):
    logging.info(f"[SID: {sid}] Starting LIVE tracking for {len(train_numbers)} trains.")
    ref_coords = get_station_coordinates(ref_station_code) if ref_station_code else None
    details_map = utils.get_train_details(train_numbers)
    selected = {str(tn) for tn in train_numbers}
    main_train_number = str(train_numbers[0]) if train_numbers else None
    while not stop_event.is_set():
        try:
            rows, cache_error, fetched_at = get_cached_live_rows(force_refresh=True)
            if cache_error:
                socketio.emit("tracking_status", {"status": "error", "message": f"Live snapshot error: {cache_error}"}, room=sid)
                socketio.sleep(5)
                continue
            row_map = {}
            for row in rows:
                tn = _extract_train_number(row)
                if tn:
                    row_map[tn] = row
            updated = []
            for tn in selected:
                row = row_map.get(str(tn))
                if not row:
                    continue
                coords = _extract_first_lat_lon(row)
                if not coords:
                    continue
                distance_km = None
                if ref_coords:
                    try:
                        distance_km = geodesic(ref_coords, coords).km
                    except Exception:
                        distance_km = None
                if (
                    spatial_range_km
                    and distance_km is not None
                    and distance_km > spatial_range_km
                    and str(tn) != str(main_train_number)
                ):
                    continue
                label = "Live position"
                if distance_km is not None and ref_station_code:
                    label = f"Live position ({distance_km:.1f} km from {ref_station_code})"
                updated.append({
                    "train_number": str(tn),
                    "train_name": _extract_train_name(row) or details_map.get(str(tn), {}).get("name", "N/A"),
                    "location_type": "at_station",
                    "involved_stations": [],
                    "location_precise": True,
                    "coords_at": coords,
                    "coords_between1": None,
                    "coords_between2": None,
                    "location_fraction": None,
                    "location_description": label,
                    "geo_distance_km": distance_km,
                    "updated_at": datetime.now(timezone.utc).isoformat() + "Z",
                    "is_reference_train": str(tn) == str(main_train_number),
                })
            socketio.emit(
                "location_update",
                {
                    "trains": updated,
                    "tracking_mode": "live",
                    "updated_at": datetime.now(timezone.utc).isoformat() + "Z",
                    "snapshot_fetched_at": fetched_at,
                },
                room=sid,
            )
            socketio.sleep(LIVE_UPDATE_INTERVAL_SECONDS)
        except Exception as e:
            logging.error(f"[SID: {sid}] Error in live update task loop: {e}", exc_info=True)
            socketio.sleep(5)
    logging.info(f"[SID: {sid}] LIVE tracking task stopped.")


# --- Function to Safely Stop Tracking (Unchanged) ---
def stop_tracking_for_client(sid):
    # ... (Function unchanged) ...
    with state_lock:
        if sid in client_tracking_state:
            logging.info(f"[SID: {sid}] Requesting stop for tracking task.")
            client_tracking_state[sid]['stop_event'].set()
            del client_tracking_state[sid]
            logging.info(f"[SID: {sid}] Tracking state removed.")
            return True
        return False

# --- SocketIO Event Handlers (Unchanged logic) ---
@socketio.on('connect')
def handle_connect():
    # ... (Function unchanged) ...
    sid = request.sid; logging.info(f"[SID: {sid}] Client connected.")

@socketio.on('disconnect')
def handle_disconnect():
    # ... (Function unchanged) ...
    sid = request.sid; logging.info(f"[SID: {sid}] Client disconnected."); stop_tracking_for_client(sid)

@socketio.on('start_tracking')
def handle_start_tracking(data):
    # ... (Function unchanged) ...
    sid = request.sid
    with state_lock:
        if sid in client_tracking_state: emit('tracking_status', {'status': 'error', 'message': 'Tracking already active.'}); return
        trains_to_track = data.get('trains_to_track')
        ref_station_code = data.get('ref_station_code')
        spatial_range_km = data.get('spatial_range_km')
        try:
            spatial_range_km = float(spatial_range_km) if spatial_range_km is not None else None
        except (TypeError, ValueError):
            spatial_range_km = None
        if not isinstance(trains_to_track, list) or not trains_to_track:
            emit('tracking_status', {'status': 'error', 'message': 'Invalid start request data.'})
            return
        logging.info(f"[SID: {sid}] start_tracking live, trains={len(trains_to_track)}")
        stop_event = threading.Event()
        thread = socketio.start_background_task(
            target=update_live_train_locations_task,
            sid=sid,
            train_numbers=trains_to_track,
            ref_station_code=ref_station_code,
            spatial_range_km=spatial_range_km,
            stop_event=stop_event
        )
        client_tracking_state[sid] = {
            'thread': thread,
            'stop_event': stop_event,
            'trains': trains_to_track,
            'tracking_mode': 'live',
            'ref_station_code': ref_station_code,
            'spatial_range_km': spatial_range_km
        }
        emit('tracking_status', {'status': 'started', 'message': 'Live tracking started.'})
        logging.info(f"[SID: {sid}] Tracking task started successfully.")

@socketio.on('stop_tracking')
def handle_stop_tracking():
    # ... (Function unchanged) ...
    sid = request.sid; logging.info(f"[SID: {sid}] Received stop_tracking request.")
    if stop_tracking_for_client(sid): emit('tracking_status', {'status': 'stopped', 'message': 'Live tracking stopped.'})
    else: emit('tracking_status', {'status': 'error', 'message': 'Tracking was not active.'})

# # --- Reachability Route (Frontier Envelope) ---
@app.route('/calculate_reach', methods=['POST'])
def calculate_reach_api():
    logging.info("Reachability (frontier) analysis request received.")
    if not backend_station_coords_map:
        return jsonify({"error": "Server configuration error: Station location data unavailable."}), 500

    try:
        data = request.form
        origin_input = data.get('origin_station', '').strip()
        max_hours_str = data.get('max_hours', '4')

        if not origin_input: return jsonify({"error": "Missing 'Origin Station'."}), 400
        try: max_hours = int(max_hours_str)
        except ValueError: return jsonify({"error": "Invalid 'Max Hours'."}), 400

        origin_code = utils.get_station_code(origin_input)
        if not origin_code: return jsonify({"error": f"Could not find station code for '{origin_input}'."}), 404

        origin_coords = get_station_coordinates(origin_code)
        if not origin_coords: return jsonify({"error": f"Geographic coordinates unavailable for '{origin_code}'."}), 404

        # Get farthest station per train
        frontier_hits = utils.get_frontier_reach(origin_code, max_hours)
        if not frontier_hits:
            return jsonify({
                "message": f"No direct trains found from {origin_code} within {max_hours} hours.",
                "origin_code": origin_code, "origin_name": origin_code,
                "origin_coords": origin_coords, "frontier_stations": []
            }), 200

        # Resolve coordinates and compute geographic distance from origin
        enriched = []
        for hit in frontier_hits:
            dest_coords = get_station_coordinates(hit['destination'])
            if dest_coords:
                try:
                    geo_dist = geodesic(origin_coords, dest_coords).km
                except:
                    geo_dist = 0
                enriched.append({
                    'code': hit['destination'],
                    'coords': dest_coords,
                    'train_number': hit['train_number'],
                    'route_km': hit['route_km'],
                    'travel_minutes': hit['travel_minutes'],
                    'geo_distance_km': geo_dist,
                    # Compute bearing from origin for directional grouping
                    'bearing': math.degrees(math.atan2(
                        dest_coords[1] - origin_coords[1],
                        dest_coords[0] - origin_coords[0]
                    )) % 360
                })

        # --- FRONTIER FILTER ---
        # Divide into 36 directional sectors of 10 degrees each.
        # In each sector, keep ONLY the geographically farthest station.
        SECTOR_SIZE = 10  # degrees
        sectors = {}
        for stn in enriched:
            sector_id = int(stn['bearing'] / SECTOR_SIZE)
            if sector_id not in sectors or stn['geo_distance_km'] > sectors[sector_id]['geo_distance_km']:
                sectors[sector_id] = stn

        frontier_stations = list(sectors.values())

        # Get names
        all_codes = [s['code'] for s in frontier_stations] + [origin_code]
        names_map = utils.get_station_names(all_codes)
        origin_name = names_map.get(origin_code, origin_code)

        # Get train names
        train_nums = list(set(s['train_number'] for s in frontier_stations))
        train_details = utils.get_train_details(train_nums)

        for stn in frontier_stations:
            stn['name'] = names_map.get(stn['code'], stn['code'])
            td = train_details.get(stn['train_number'], {})
            stn['train_name'] = td.get('name', 'N/A')
            # Format travel time as hours:minutes
            h = int(stn['travel_minutes'] // 60)
            m = int(stn['travel_minutes'] % 60)
            stn['travel_time_str'] = f"{h}h {m}m"

        # Sort by bearing for clean rendering
        frontier_stations.sort(key=lambda x: x['bearing'])

        logging.info(f"Frontier: {len(frontier_stations)} envelope stations from {origin_name} within {max_hours}h (from {len(enriched)} train endpoints).")
        return jsonify({
            "message": f"Frontier reach: {len(frontier_stations)} directions from {origin_name} ({origin_code}) within {max_hours}h.",
            "origin_code": origin_code,
            "origin_name": origin_name,
            "origin_coords": origin_coords,
            "frontier_stations": frontier_stations,
            "max_hours": max_hours
        }), 200

    except Exception as e:
        logging.exception("Error during reachability calculation.")
        return jsonify({"error": "An internal server error occurred."}), 500

# --- My Journeys Routes ---
@app.route('/get_journeys', methods=['GET'])
def get_journeys_api():
    """Returns all saved journeys with full route coordinates, distance, and travel time."""
    try:
        import gmail_scraper
        journeys = gmail_scraper.get_all_journeys()

        enriched = []
        total_km = 0
        total_minutes = 0

        for j in journeys:
            origin_coords = get_station_coordinates(j['origin'])
            dest_coords = get_station_coordinates(j['destination'])
            j['origin_coords'] = origin_coords
            j['destination_coords'] = dest_coords

            # Resolve actual route path from schedule
            route_data = utils.get_journey_route_data(
                j['train_number'], j['origin'], j['destination']
            )

            if route_data:
                j['route_km'] = route_data['route_km']
                j['travel_minutes'] = route_data['travel_minutes']
                total_km += route_data['route_km']
                total_minutes += route_data['travel_minutes']

                # Resolve coordinates for sampled route stations
                route_coords = []
                for code in route_data['station_codes']:
                    c = get_station_coordinates(code)
                    if c:
                        route_coords.append(c)
                j['route_coords'] = route_coords if len(route_coords) >= 2 else None
            else:
                j['route_km'] = 0
                j['travel_minutes'] = 0
                j['route_coords'] = None

            # Format travel time
            h = int(j['travel_minutes'] // 60)
            m = int(j['travel_minutes'] % 60)
            j['travel_time_str'] = f"{h}h {m}m" if h else f"{m}m"

            enriched.append(j)

        return jsonify({
            "journeys": enriched,
            "count": len(enriched),
            "total_km": round(total_km),
            "total_minutes": round(total_minutes),
            "total_hours": round(total_minutes / 60, 1) if total_minutes else 0
        }), 200
    except Exception as e:
        logging.exception("Error fetching journeys.")
        return jsonify({"error": str(e)}), 500

@app.route('/add_journey', methods=['POST'])
def add_journey_api():
    """Manually add a journey to the database."""
    try:
        import gmail_scraper
        gmail_scraper.init_journeys_table()

        data = request.form
        train_number = data.get('train_number', '').strip()
        origin = data.get('origin', '').strip().upper()
        destination = data.get('destination', '').strip().upper()
        journey_date = data.get('journey_date', '').strip()

        if not train_number or not origin or not destination:
            return jsonify({"error": "Train number, origin, and destination are required."}), 400

        # Resolve origin code if full name given
        resolved_origin = utils.get_station_code(origin) or origin
        resolved_dest = utils.get_station_code(destination) or destination

        # Generate a unique PNR for manual entries
        import time as _time
        pnr = f"MANUAL_{int(_time.time() * 1000)}"

        journey = {
            'pnr': pnr,
            'train_number': train_number,
            'train_name': '',
            'origin': resolved_origin,
            'destination': resolved_dest,
            'journey_date': journey_date,
            'travel_class': '',
            'origin_name': '',
            'destination_name': ''
        }

        # Get train name
        details = utils.get_train_details([train_number])
        if train_number in details:
            journey['train_name'] = details[train_number].get('name', '')

        saved = gmail_scraper.save_journeys([journey])
        return jsonify({
            "message": f"Journey added: {resolved_origin} -> {resolved_dest} on train {train_number}",
            "saved": saved
        }), 200
    except Exception as e:
        logging.exception("Error adding manual journey.")
        return jsonify({"error": str(e)}), 500

@app.route('/sync_journeys', methods=['POST'])
def sync_journeys_api():
    """Triggers a Gmail sync to fetch new IRCTC tickets."""
    try:
        import gmail_scraper
        gmail_scraper.init_journeys_table()
        tickets = gmail_scraper.fetch_irctc_tickets(max_results=200)
        saved = gmail_scraper.save_journeys(tickets)
        return jsonify({
            "message": f"Synced {len(tickets)} tickets, {saved} new saved.",
            "total_parsed": len(tickets),
            "new_saved": saved
        }), 200
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logging.exception("Error syncing journeys.")
        return jsonify({"error": str(e)}), 500

# --- Main Run Block (Unchanged) ---
if __name__ == '__main__':
    # ... (Startup checks unchanged) ...
    if not os.path.isdir(DATA_DIR): logging.warning(f"Data directory '{DATA_DIR}' not found.")
    db_check_path = getattr(utils, 'DATABASE_PATH', None)
    if not db_check_path or not os.path.exists(db_check_path): logging.error(f"CRITICAL: Database file not found at path: '{db_check_path}'.")
    if not backend_station_coords_map: logging.error("CRITICAL: Station coordinates map is empty.")
    logging.info("Starting Flask-SocketIO application...")
    socketio.run(app, debug=True, host='127.0.0.1', port=5000, use_reloader=False, allow_unsafe_werkzeug=True)
