import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NewWatchInput, Route, VehicleType, Watch, WatchStatus } from "./types.js";

const DATA_DIR = path.resolve("data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "watches.sqlite"));
db.pragma("journal_mode = WAL");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS watches (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    route TEXT NOT NULL,
    date TEXT NOT NULL,
    departure_time TEXT NOT NULL,
    adults INTEGER NOT NULL DEFAULT 2,
    vehicle TEXT NOT NULL DEFAULT 'car-under-225',
    active INTEGER NOT NULL DEFAULT 1,
    last_status TEXT NOT NULL DEFAULT 'unknown',
    last_checked_at TEXT,
    last_detail TEXT,
    notified_at TEXT,
    created_at TEXT NOT NULL
  )
`;

db.exec(SCHEMA);

// The pre-V1 schema stored a pasted search URL instead of a departure. It cannot be
// migrated into the new model, so replace it — see README.
const columns = db.prepare("PRAGMA table_info(watches)").all() as { name: string }[];
if (!columns.some((c) => c.name === "departure_time")) {
  console.warn("Replacing the pre-V1 watches table (its search-URL model is no longer supported).");
  db.exec("DROP TABLE watches");
  db.exec(SCHEMA);
}

interface WatchRow {
  id: string;
  label: string;
  route: string;
  date: string;
  departure_time: string;
  adults: number;
  vehicle: string;
  active: number;
  last_status: string;
  last_checked_at: string | null;
  last_detail: string | null;
  notified_at: string | null;
  created_at: string;
}

function rowToWatch(row: WatchRow): Watch {
  return {
    id: row.id,
    label: row.label,
    route: row.route as Route,
    date: row.date,
    departureTime: row.departure_time,
    adults: row.adults,
    vehicle: row.vehicle as VehicleType,
    active: row.active === 1,
    lastStatus: row.last_status as WatchStatus,
    lastCheckedAt: row.last_checked_at,
    lastDetail: row.last_detail,
    notifiedAt: row.notified_at,
    createdAt: row.created_at,
  };
}

export function listWatches(): Watch[] {
  const rows = db.prepare("SELECT * FROM watches ORDER BY created_at DESC").all() as WatchRow[];
  return rows.map(rowToWatch);
}

export function getWatch(id: string): Watch | undefined {
  const row = db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as WatchRow | undefined;
  return row ? rowToWatch(row) : undefined;
}

export function createWatch(input: NewWatchInput): Watch {
  const watch: Watch = {
    id: randomUUID(),
    label: input.label,
    route: input.route,
    date: input.date,
    departureTime: input.departureTime,
    adults: input.adults ?? 2,
    vehicle: input.vehicle ?? "car-under-225",
    active: true,
    lastStatus: "unknown",
    lastCheckedAt: null,
    lastDetail: null,
    notifiedAt: null,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO watches
      (id, label, route, date, departure_time, adults, vehicle, active, last_status, last_checked_at, last_detail, notified_at, created_at)
     VALUES (@id, @label, @route, @date, @departureTime, @adults, @vehicle, @active, @lastStatus, @lastCheckedAt, @lastDetail, @notifiedAt, @createdAt)`
  ).run({ ...watch, active: watch.active ? 1 : 0 });

  return watch;
}

export function setActive(id: string, active: boolean): void {
  db.prepare("UPDATE watches SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function deleteWatch(id: string): void {
  db.prepare("DELETE FROM watches WHERE id = ?").run(id);
}

export function recordCheckResult(
  id: string,
  status: WatchStatus,
  detail: string,
  notified: boolean
): void {
  const now = new Date().toISOString();
  if (notified) {
    db.prepare(
      "UPDATE watches SET last_status = ?, last_checked_at = ?, last_detail = ?, notified_at = ? WHERE id = ?"
    ).run(status, now, detail, now, id);
  } else {
    db.prepare(
      "UPDATE watches SET last_status = ?, last_checked_at = ?, last_detail = ? WHERE id = ?"
    ).run(status, now, detail, id);
  }
}
