// server/db.js — SQLite database access via sql.js (WASM)
import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';
import cfg from './config.js';

let db = null;
const stationCoords = new Map();   // code → [lat, lng]
const DAY_BITS = { sunday: 1, monday: 2, tuesday: 4, wednesday: 8, thursday: 16, friday: 32, saturday: 64 };

export async function initDb() {
  const SQL = await initSqlJs();
  const buf = readFileSync(cfg.dbPath);
  db = new SQL.Database(buf);
  // Preload station coordinates
  const rows = db.exec("SELECT code, lat, lng FROM Stn WHERE lat IS NOT NULL AND lng IS NOT NULL");
  if (rows.length) {
    for (const r of rows[0].values) {
      stationCoords.set(r[0], [r[1], r[2]]);
    }
  }
  console.log(`[db] Loaded ${stationCoords.size} station coordinates.`);
  return db;
}

export function getStationCoords(code) {
  return stationCoords.get(code?.toUpperCase?.()) || null;
}

export function allStationCoords() { return stationCoords; }

export function resolveStationCode(input) {
  if (!input) return null;
  const up = input.trim().toUpperCase();
  if (stationCoords.has(up)) return up;
  // Try by name
  const rows = db.exec("SELECT code FROM Stn WHERE UPPER(name) = ? OR UPPER(offName) = ? LIMIT 1", [up, up]);
  return rows.length && rows[0].values.length ? rows[0].values[0][0] : null;
}

export function getTrainDetails(numbers) {
  if (!numbers.length) return {};
  const placeholders = numbers.map(() => '?').join(',');
  const rows = db.exec(`SELECT number, name, fromStnCode, toStnCode, departureDaysOfWeek FROM Trn WHERE number IN (${placeholders})`, numbers);
  const map = {};
  if (rows.length) {
    for (const r of rows[0].values) {
      map[r[0]] = { number: r[0], name: r[1], from: r[2], to: r[3], daysMask: r[4] };
    }
  }
  return map;
}

export function getStationNames(codes) {
  if (!codes.length) return {};
  const placeholders = codes.map(() => '?').join(',');
  const rows = db.exec(`SELECT code, name FROM Stn WHERE code IN (${placeholders})`, codes);
  const map = {};
  if (rows.length) {
    for (const r of rows[0].values) map[r[0]] = r[1];
  }
  return map;
}

export function getTrainSchedule(trainNumber) {
  const rows = db.exec(
    `SELECT stnCode, arrTime, depTime, dayNum, km FROM Sch WHERE trnNumber = ? ORDER BY km`,
    [trainNumber]
  );
  if (!rows.length) return [];
  return rows[0].values.map(r => ({
    stnCode: r[0],
    arrTime: r[1],
    depTime: r[2],
    dayNum:  r[3],
    km:      r[4],
    // Absolute time in minutes from midnight day 1
    arrAbs: r[1] != null && r[3] != null ? (r[3] - 1) * 1440 + r[1] : null,
    depAbs: r[2] != null && r[3] != null ? (r[3] - 1) * 1440 + r[2] : null,
  }));
}

export function getStationsForAutocomplete() {
  const rows = db.exec("SELECT code, name FROM Stn WHERE lat IS NOT NULL ORDER BY name");
  if (!rows.length) return [];
  return rows[0].values.map(r => ({ code: r[0], name: r[1] }));
}

export function getTrainsOnDay(dayName, excludeTrain) {
  const bit = DAY_BITS[dayName?.toLowerCase()];
  if (!bit) return [];
  const rows = db.exec(
    "SELECT number FROM Trn WHERE (departureDaysOfWeek & ?) != 0 AND number != ?",
    [bit, excludeTrain || '']
  );
  if (!rows.length) return [];
  return rows[0].values.map(r => r[0]);
}

// Reachability: get all trains departing from a station after a given time on a given day
export function getTrainsDepartingFrom(stnCode, dayBit) {
  const rows = db.exec(`
    SELECT s.trnNumber, s.depTime, s.dayNum, s.km, t.name, t.departureDaysOfWeek
    FROM Sch s JOIN Trn t ON s.trnNumber = t.number
    WHERE s.stnCode = ? AND (t.departureDaysOfWeek & ?) != 0
    ORDER BY s.depTime
  `, [stnCode, dayBit]);
  if (!rows.length) return [];
  return rows[0].values.map(r => ({
    trainNumber: r[0], depTime: r[1], dayNum: r[2], km: r[3], trainName: r[4], daysMask: r[5]
  }));
}

export { DAY_BITS };
