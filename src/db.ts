import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SETTINGS_LIMITS, type NewWatchInput, type Route, type Settings, type VehicleType, type Watch, type WatchStatus } from "./types.js";

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

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

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

function clamp(value: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A stored number, or the `.env` value, or the built-in default. The env vars stay the
 * defaults for a fresh install; once the UI writes a setting, the stored value wins.
 */
function readNumber(key: keyof Settings, envName: string, fallback: number): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  const raw = Number(row?.value ?? process.env[envName] ?? fallback);
  return clamp(Number.isFinite(raw) ? raw : fallback, SETTINGS_LIMITS[key]);
}

export function getSettings(): Settings {
  return {
    intervalMinutes: readNumber("intervalMinutes", "CHECK_INTERVAL_MINUTES", 10),
    jitterMinutes: readNumber("jitterMinutes", "CHECK_JITTER_MINUTES", 5),
  };
}

export function saveSettings(settings: Settings): Settings {
  const write = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  for (const [key, value] of Object.entries(settings)) {
    write.run(key, String(clamp(value, SETTINGS_LIMITS[key as keyof Settings])));
  }
  return getSettings();
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
