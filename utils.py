# utils.py
import sqlite3
import os
import logging
import re
from collections import defaultdict

# --- Constants, Logging, DB Path ---
DAY_BITMASKS = { "monday": 1, "tuesday": 2, "wednesday": 4, "thursday": 8, "friday": 16, "saturday": 32, "sunday": 64 }
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE_PATH = os.path.join(BASE_DIR, 'data', 'ir.db')

# --- Database Connection ---
def get_db():
    """Establishes a connection to the SQLite database."""
    db_path = DATABASE_PATH
    if not os.path.exists(db_path):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        db_path = os.path.join(script_dir, 'data', 'ir.db')
        if not os.path.exists(db_path):
            raise FileNotFoundError(f"DB not found at expected locations: {DATABASE_PATH} or {db_path}")
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as e:
        logging.error(f"DB connection error to {db_path}: {e}")
        raise

# --- Station Code Lookup (Input -> Code) ---
def get_station_code(user_input):
    """Finds the station code from user input (code or name fragment)."""
    if not user_input: return None
    conn = None
    input_upper = user_input.strip().upper()
    try:
        conn = get_db()
        cursor = conn.cursor()
        is_potential_code = bool(re.match(r"^[A-Z0-9]{2,5}$", input_upper))
        if is_potential_code:
            cursor.execute("SELECT code FROM Stn WHERE code = ? LIMIT 1", (input_upper,))
            result = cursor.fetchone()
            if result:
                logging.debug(f"Found station code '{result['code']}' by direct match for '{user_input}'.")
                return result['code']

        search_term = f"%{user_input.strip()}%"
        cursor.execute("""
            SELECT code FROM Stn
            WHERE name LIKE ? OR offName LIKE ? OR localName LIKE ? OR alias LIKE ?
            ORDER BY priority DESC, name
            LIMIT 1
        """, (search_term, search_term, search_term, search_term))
        result = cursor.fetchone()
        if result:
             logging.debug(f"Found station code '{result['code']}' by name search for '{user_input}'.")
             return result['code']
        else:
             logging.warning(f"Could not find station code for input: '{user_input}'.")
             return None
    except sqlite3.Error as e:
        logging.error(f"Error getting station code for '{user_input}': {e}")
        return None
    finally:
        if conn: conn.close()


# --- Station Code from Name Lookup (Name -> Code) --- NEW FUNCTION
def get_code_from_name(station_name):
    """Finds the best matching station code for a given station name."""
    if not station_name: return None
    conn = None
    name_cleaned = station_name.strip()
    # Attempt exact match first (case-insensitive)
    try:
        conn = get_db()
        cursor = conn.cursor()
        # Exact match on 'name' (often primary name) - COLLATE NOCASE for case-insensitivity
        cursor.execute("""
            SELECT code FROM Stn WHERE name = ? COLLATE NOCASE LIMIT 1
        """, (name_cleaned,))
        result = cursor.fetchone()
        if result:
            # logging.debug(f"Found station code '{result['code']}' by exact name match for '{station_name}'.") # Make less verbose
            return result['code']

        # Fallback to LIKE search if exact match fails
        search_term = f"%{name_cleaned}%"
        # Search across multiple name fields, prioritize by 'priority' if available, then name
        # Using COLLATE NOCASE for broader case-insensitive matching with LIKE
        cursor.execute("""
            SELECT code FROM Stn
            WHERE name LIKE ? COLLATE NOCASE
               OR offName LIKE ? COLLATE NOCASE
               OR localName LIKE ? COLLATE NOCASE
               OR alias LIKE ? COLLATE NOCASE
            ORDER BY
                CASE
                    WHEN name = ? COLLATE NOCASE THEN 1  -- Prioritize exact match slightly higher here too
                    ELSE 2
                END,
                priority DESC,  -- Assuming a priority column exists, otherwise remove
                name
            LIMIT 1
        """, (search_term, search_term, search_term, search_term, name_cleaned)) # Add name_cleaned for exact match priority
        result = cursor.fetchone()
        if result:
             # logging.debug(f"Found station code '{result['code']}' by LIKE name search for '{station_name}'.") # Make less verbose
             return result['code']
        else:
             # Optional: Log if name lookup completely failed
             # logging.debug(f"Could not find station code via name lookup for: '{station_name}'.")
             return None
    except sqlite3.Error as e:
        logging.error(f"DB Error getting station code for name '{station_name}': {e}")
        return None
    finally:
        if conn: conn.close()


# --- Scheduled KM Lookup ---
def get_scheduled_km_at_station(train_number, station_code):
    """Retrieves the scheduled kilometer mark for a train at a station."""
    if not train_number or not station_code: return None
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        query = "SELECT km FROM Sch WHERE trnNumber = ? AND stnCode = ? LIMIT 1"
        cursor.execute(query, (train_number, station_code))
        result = cursor.fetchone()
        return float(result['km']) if result and result['km'] is not None else None
    except (sqlite3.Error, ValueError, TypeError) as e:
        logging.error(f"Error getting/converting scheduled km for train {train_number} at station {station_code}: {e}")
        return None
    finally:
        if conn: conn.close()

# --- Train Details Lookup ---
def get_train_details(train_numbers):
    """Retrieves details (name, type, zone) for a list of train numbers."""
    if not train_numbers: return {}
    conn = None
    details = {}
    if not isinstance(train_numbers, (list, tuple)):
        try: train_numbers = list(train_numbers)
        except TypeError: logging.error("Invalid input type for get_train_details."); return {}
    if not train_numbers: return {}
    cleaned_train_numbers = [str(num) for num in train_numbers if num is not None]
    if not cleaned_train_numbers: return {}
    try:
        conn = get_db()
        cursor = conn.cursor()
        placeholders = ','.join('?' for _ in cleaned_train_numbers)
        query = f"SELECT number, name, offName, localName, type, zone FROM Trn WHERE number IN ({placeholders})"
        cursor.execute(query, cleaned_train_numbers)
        for row in cursor.fetchall():
            train_num_str = str(row['number'])
            train_name = row['name'] or row['offName'] or row['localName'] or f"Train {train_num_str}"
            details[train_num_str] = {'name': train_name, 'type': row['type'], 'zone': row['zone']}
        return details
    except sqlite3.Error as e:
        logging.error(f"Error getting train details: {e}")
        return details
    finally:
        if conn: conn.close()

# --- Absolute Time Calculation ---
def calculate_absolute_minutes(day_num, time_minutes):
    """Converts schedule day number and minutes-since-midnight to absolute minutes."""
    if day_num is None or time_minutes is None or time_minutes == -1: return None
    try:
        day = int(day_num); time_min = int(time_minutes)
        if day < 1: day = 1
        return (day - 1) * 1440 + time_min
    except (ValueError, TypeError):
        logging.warning(f"Could not convert day/time to absolute minutes: day={day_num}, time={time_minutes}")
        return None

# --- Full Train Schedule Lookup ---
def get_train_full_schedule(train_number):
    """Retrieves the full schedule for a train, ordered by KM, with absolute times."""
    if not train_number: return []
    conn = None
    schedule = []
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT stnCode, arrTime, depTime, dayNum, km FROM Sch WHERE trnNumber = ? ORDER BY km", (train_number,))
        rows = cursor.fetchall()
        for row in rows:
            if row['stnCode'] and row['km'] is not None:
                 try:
                     row_dict = dict(row)
                     row_dict['km'] = float(row_dict['km'])
                     row_dict['arr_abs'] = calculate_absolute_minutes(row_dict['dayNum'], row_dict['arrTime'])
                     row_dict['dep_abs'] = calculate_absolute_minutes(row_dict['dayNum'], row_dict['depTime'])
                     schedule.append(row_dict)
                 except (ValueError, TypeError) as e:
                      logging.warning(f"Could not convert schedule data for train {train_number} at {row['stnCode']}: {e}")
            else:
                 logging.warning(f"Skipping schedule stop for train {train_number} due to missing code/km: {dict(row)}")
        return schedule
    except sqlite3.Error as e:
        logging.error(f"Error getting full schedule for train {train_number}: {e}")
        return []
    finally:
        if conn: conn.close()

# --- Station Names Lookup ---
def get_station_names(station_codes):
    """Retrieves station names for a list of station codes."""
    if not station_codes: return {}
    conn = None
    names_map = {}
    unique_codes = list(set(st for st in station_codes if st))
    if not unique_codes: return {}
    try:
        conn = get_db()
        cursor = conn.cursor()
        placeholders = ','.join('?' * len(unique_codes))
        query = f"SELECT code, name FROM Stn WHERE code IN ({placeholders})"
        cursor.execute(query, tuple(unique_codes))
        for row in cursor.fetchall():
            names_map[row['code']] = row['name'] or row['code']
        return names_map
    except sqlite3.Error as e:
        logging.error(f"Error getting station names: {e}")
        return {}
    finally:
        if conn: conn.close()

# --- Direction Calculation (No longer used for filtering, but maybe for info) ---
def get_direction_at_station(schedule, current_station_code):
    """Determines train direction (increasing/decreasing KM) at a station based on the next stop."""
    if not schedule: return 'indeterminate'
    current_index = -1; current_km = None
    for i, stop in enumerate(schedule):
        if stop.get('stnCode') == current_station_code:
            current_index = i; current_km = stop.get('km'); break
    if current_index == -1 or current_km is None: return 'indeterminate'
    if current_index + 1 < len(schedule):
        next_stop = schedule[current_index + 1]; next_km = next_stop.get('km')
        if next_km is not None:
            km_diff = next_km - current_km
            if km_diff > 0.01: return 'increasing'
            if km_diff < -0.01: return 'decreasing'
            return 'indeterminate'
        else: return 'indeterminate'
    else: return 'indeterminate'

# --- Get Trains on Day ---
def get_all_trains_on_day(day_bitmask, exclude_train_number=None):
    """Gets a list of all train numbers (as strings) running on a specific day, excluding one if specified."""
    if not day_bitmask: return []
    conn = None
    train_numbers = []
    try:
        conn = get_db()
        cursor = conn.cursor()
        query = "SELECT number FROM Trn WHERE (departureDaysOfWeek & ?) > 0"
        params = [day_bitmask]
        if exclude_train_number:
            query += " AND number != ?"
            params.append(str(exclude_train_number))
        cursor.execute(query, params)
        train_numbers = [str(row['number']) for row in cursor.fetchall()]
        logging.info(f"Found {len(train_numbers)} other trains running on day bitmask {day_bitmask} (excluding {exclude_train_number}).")
        return train_numbers
    except sqlite3.Error as e:
        logging.error(f"Error getting all trains on day bitmask {day_bitmask}: {e}")
        return []
    finally:
        if conn: conn.close()

# --- Reachability Logic (Frontier Envelope) ---
def get_frontier_reach(origin_code, max_hours):
    """
    For each train departing from origin_code, finds the FARTHEST station
    reachable within max_hours. Returns a list of dicts with train info,
    destination code, and travel time.
    
    Key logic:
    - Uses absolute time (dayNum * 1440 + minutes) to compute travel duration
    - Filters out depTime <= 0 at origin (terminus markers) and arrTime <= 0 at dest
    - Orders by km DESC so first valid hit per train is the farthest reachable stop
    """
    if not origin_code or not max_hours: return []
    conn = None
    max_minutes = float(max_hours) * 60.0
    try:
        conn = get_db()
        cursor = conn.cursor()
        # Get ALL (train, destination) pairs where origin station has a valid
        # departure and destination has a valid arrival, ordered farthest-first
        query = '''
        SELECT 
            S1.trnNumber AS train_number,
            S2.stnCode AS destination,
            S2.km AS dest_km,
            S1.km AS origin_km,
            S1.dayNum AS day1, S1.depTime AS dep1, 
            S2.dayNum AS day2, S2.arrTime AS arr2
        FROM Sch S1
        JOIN Sch S2 ON S1.trnNumber = S2.trnNumber
        WHERE S1.stnCode = ? 
          AND S2.km > S1.km
          AND S1.depTime > 0
          AND S2.arrTime > 0
        ORDER BY S1.trnNumber, S2.km DESC
        '''
        cursor.execute(query, (origin_code,))
        rows = cursor.fetchall()
        
        # For each train, keep only the farthest reachable station
        farthest_per_train = {}
        for r in rows:
            dep1_abs = (r['day1'] - 1) * 1440 + r['dep1']
            arr2_abs = (r['day2'] - 1) * 1440 + r['arr2']
            diff_minutes = arr2_abs - dep1_abs
            
            # Skip invalid or out-of-range travel times
            if diff_minutes <= 0 or diff_minutes > max_minutes:
                continue
            
            tn = str(r['train_number'])
            route_km = r['dest_km'] - r['origin_km']
            
            # Since ORDER BY km DESC, first valid hit per train = farthest
            if tn not in farthest_per_train:
                farthest_per_train[tn] = {
                    'train_number': tn,
                    'destination': r['destination'],
                    'route_km': route_km,
                    'travel_minutes': diff_minutes
                }
        
        results = list(farthest_per_train.values())
        logging.info(f"Frontier Reach: {len(results)} trains with farthest stops from {origin_code} within {max_hours}hrs.")
        return results
    except sqlite3.Error as e:
        logging.error(f"Error in get_frontier_reach from {origin_code}: {e}")
        return []
    finally:
        if conn: conn.close()


# --- Journey Route Resolution ---
def get_journey_route_data(train_number, origin_code, destination_code):
    """
    For a given train, returns the route data between origin and destination:
    - station_codes: list of station codes along the route
    - route_km: total km between origin and destination
    - travel_minutes: total travel time in minutes
    - dep_time / arr_time info
    
    We sample every 3rd intermediate station to keep data lean while still
    drawing a geographically accurate route curve.
    """
    if not train_number or not origin_code or not destination_code:
        return None
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        # Get all stops for this train ordered by km
        cursor.execute('''
            SELECT stnCode, km, dayNum, arrTime, depTime
            FROM Sch
            WHERE trnNumber = ?
            ORDER BY km
        ''', (train_number,))
        all_stops = cursor.fetchall()
        
        if not all_stops:
            return None
        
        # Find origin and destination indices
        origin_idx = None
        dest_idx = None
        for i, s in enumerate(all_stops):
            if s['stnCode'] == origin_code and origin_idx is None:
                origin_idx = i
            if s['stnCode'] == destination_code:
                dest_idx = i
        
        # Handle case where origin comes AFTER destination in km order
        # (user boarded mid-route and went backward relative to km numbering
        # — but in Sch, km always increases, so this shouldn't normally happen)
        if origin_idx is None or dest_idx is None:
            return None
        if origin_idx > dest_idx:
            # Swap so we always go low-km to high-km
            origin_idx, dest_idx = dest_idx, origin_idx
        
        origin_stop = all_stops[origin_idx]
        dest_stop = all_stops[dest_idx]
        
        # Route km
        route_km = dest_stop['km'] - origin_stop['km']
        
        # Travel time
        dep_abs = (origin_stop['dayNum'] - 1) * 1440 + (origin_stop['depTime'] if origin_stop['depTime'] and origin_stop['depTime'] > 0 else (origin_stop['arrTime'] if origin_stop['arrTime'] and origin_stop['arrTime'] > 0 else 0))
        arr_abs = (dest_stop['dayNum'] - 1) * 1440 + (dest_stop['arrTime'] if dest_stop['arrTime'] and dest_stop['arrTime'] > 0 else (dest_stop['depTime'] if dest_stop['depTime'] and dest_stop['depTime'] > 0 else 0))
        travel_minutes = max(0, arr_abs - dep_abs)
        
        # Collect station codes for the route (sample every 3rd for intermediate)
        route_between = all_stops[origin_idx:dest_idx + 1]
        sampled_codes = []
        for j, s in enumerate(route_between):
            # Always include first and last, and every 3rd intermediate
            if j == 0 or j == len(route_between) - 1 or j % 3 == 0:
                sampled_codes.append(s['stnCode'])
        
        return {
            'station_codes': sampled_codes,
            'route_km': route_km,
            'travel_minutes': travel_minutes
        }
    except sqlite3.Error as e:
        logging.error(f"Error in get_journey_route_data for train {train_number}: {e}")
        return None
    finally:
        if conn: conn.close()