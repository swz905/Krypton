# populate_xo.py  (v3 – bug‑fix for Windows logging + normalized hyphens)

import sqlite3
import os
import logging
import time
from collections import defaultdict
from itertools import combinations

# --- Configuration & Event Types ---
DATABASE_FILENAME     = 'ir.db'
EVENT_TYPE_MEET_CROSS = 1
EVENT_TYPE_OVERTAKE   = 2   # trnNumber overtakes trnNumberXO
EVENT_TYPE_OVERTAKEN  = 3   # trnNumber is overtaken by trnNumberXO

# --- Logging Setup (fix: force ASCII hyphens + UTF-8 file encoding) ---
LOG_FILE = 'populate_xo_edgecase.log'
if os.path.exists(LOG_FILE):
    try:
        os.remove(LOG_FILE)
    except OSError as e:
        print(f"Warning: could not delete old log: {e}")

logger = logging.getLogger()
logger.setLevel(logging.DEBUG)

# File handler, UTF‑8 encoded
fh = logging.FileHandler(LOG_FILE, encoding='utf-8')
# Console handler (uses whatever your console encoding is, but ASCII hyphens only in the messages now)
ch = logging.StreamHandler()

formatter = logging.Formatter(
    '%(asctime)s [%(levelname)s] [%(funcName)s:%(lineno)d] %(message)s'
)
fh.setFormatter(formatter)
ch.setFormatter(formatter)

logger.addHandler(fh)
logger.addHandler(ch)

logger.info("=== Starting XO‑population script ===")


# --- Helpers ---
def calculate_absolute_minutes(day_num, time_min, train_num=None, stn_code=None):
    """Return minutes since journey‑start (Day1 00:00=0), or None on bad data."""
    if day_num is None:
        logger.debug(f"No day_num for {train_num}@{stn_code}")
        return None
    if time_min is None or time_min == -1:
        logger.debug(f"No time_min for {train_num}@{stn_code}")
        return None

    try:
        d = int(day_num)
        t = int(time_min)
    except (ValueError, TypeError) as e:
        logger.warning(f"Conversion error for day/time for {train_num}@{stn_code}: {e}")
        return None

    if d <= 0 or not (0 <= t < 1440):
        # NOTE: Using a plain ASCII hyphen here
        logger.warning(f"Out-of-range day/time for {train_num}@{stn_code}: day={d}, time={t}")
        return None

    return (d - 1) * 1440 + t


def rotate_bitmask(orig_mask, day_offset):
    """Rotate a 7‑bit mask to account for days‑of‑week shift."""
    new_mask = 0
    for bit in range(7):
        if (orig_mask >> bit) & 1:
            new_mask |= 1 << ((bit + day_offset) % 7)
    return new_mask


# --- Main Population Function ---
def populate_xo_table():
    start = time.time()
    base = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(base, 'data', DATABASE_FILENAME)
    if not os.path.exists(db_path):
        logger.critical(f"DB not found at {db_path}")
        return

    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 1) load departureDaysOfWeek
    cur.execute("SELECT number, departureDaysOfWeek FROM Trn")
    train_daymask = {r['number']: r['departureDaysOfWeek'] for r in cur.fetchall()}
    logger.info(f"Loaded day‑masks for {len(train_daymask)} trains")

    # 2) load all schedule entries
    cur.execute("""
      SELECT trnNumber, stnCode, arrTime, depTime, dayNum
        FROM Sch
       WHERE trnNumber IS NOT NULL
         AND stnCode    IS NOT NULL
         AND dayNum     IS NOT NULL
    """)
    raw_sched = cur.fetchall()
    logger.info(f"Fetched {len(raw_sched)} schedule rows")

    # 3) group by station, compute absolute intervals + calendar bitmask
    station_map = defaultdict(list)
    for row in raw_sched:
        trn = row['trnNumber']
        stn = row['stnCode']
        day_num = row['dayNum']
        orig_mask = train_daymask.get(trn)
        if orig_mask is None:
            continue

        abs_arr = calculate_absolute_minutes(day_num, row['arrTime'], trn, stn)
        abs_dep = calculate_absolute_minutes(day_num, row['depTime'], trn, stn)

        if abs_arr is None and abs_dep is None:
            continue
        if abs_arr is None:
            abs_arr = abs_dep
        if abs_dep is None:
            abs_dep = abs_arr
        if abs_dep < abs_arr:
            logger.warning(f"Inverted times for {trn}@{stn}: arr={abs_arr}, dep={abs_dep}")
            abs_dep = abs_arr

        cal_mask = rotate_bitmask(orig_mask, day_num - 1)
        if cal_mask == 0:
            continue

        station_map[stn].append({
            'trn': trn,
            'start': abs_arr,
            'end':   abs_dep,
            'arr':   abs_arr,
            'dep':   abs_dep,
            'daymask': cal_mask
        })

    logger.info(f"Prepared schedules at {len(station_map)} stations")

    # 4) compare each pair at every station
    interactions = {}
    total_checks = 0
    found = 0

    for stn, lst in station_map.items():
        if len(lst) < 2:
            continue

        for a, b in combinations(lst, 2):
            total_checks += 1
            if not (a['start'] <= b['end'] and a['end'] >= b['start']):
                continue

            common = a['daymask'] & b['daymask']
            if common == 0:
                continue

            found += 1

            is_a_halt = (a['dep'] > a['arr'])
            is_b_halt = (b['dep'] > b['arr'])
            type_a = type_b = EVENT_TYPE_MEET_CROSS

            if is_a_halt and is_b_halt:
                if a['arr'] <= b['arr'] and a['dep'] >= b['dep']:
                    type_a, type_b = EVENT_TYPE_OVERTAKE, EVENT_TYPE_OVERTAKEN
                elif b['arr'] <= a['arr'] and b['dep'] >= a['dep']:
                    type_a, type_b = EVENT_TYPE_OVERTAKEN, EVENT_TYPE_OVERTAKE

            key_ab = (a['trn'], stn, b['trn'])
            if key_ab not in interactions:
                interactions[key_ab] = (type_a, common)
            key_ba = (b['trn'], stn, a['trn'])
            if key_ba not in interactions:
                interactions[key_ba] = (type_b, common)

    logger.info(f"Compared {total_checks} pairs; found {found} overlaps")

    # 5) write to XO (with timestamp)
    now_ts = int(time.time())
    conn.execute("BEGIN")
    conn.execute("DELETE FROM XO")
    logger.info("Cleared existing XO rows")

    to_insert = [
        (trn, stn, xo, typ, days, now_ts)
        for (trn, stn, xo), (typ, days) in interactions.items()
    ]

    if to_insert:
        cur.executemany(
            "INSERT INTO XO "
            "(trnNumber, stnCode, trnNumberXO, type, departureDaysOfWeek, updatedOnNum) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            to_insert
        )
        logger.info(f"Inserted {cur.rowcount} XO rows")
    else:
        logger.info("No interactions to insert")

    conn.commit()
    conn.close()

    logger.info(f"=== Done in {time.time() - start:.2f}s ===")


if __name__ == "__main__":
    populate_xo_table()
