import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NewWatchInput, Watch, WatchStatus } from "./types.js";

const DATA_DIR = path.resolve("data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "watches.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS watches (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT,
    search_url TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    last_status TEXT NOT NULL DEFAULT 'unknown',
    last_checked_at TEXT,
    last_detail TEXT,
    notified_at TEXT,
    created_at TEXT NOT NULL
  )
`);

interface WatchRow {
  id: string;
  label: string;
  origin: string;
  destination: string;
  date: string;
  time: string | null;
  search_url: string | null;
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
    origin: row.origin,
    destination: row.destination,
    date: row.date,
    time: row.time,
    searchUrl: row.search_url,
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
    origin: input.origin,
    destination: input.destination,
    date: input.date,
    time: input.time ?? null,
    searchUrl: input.searchUrl ?? null,
    active: true,
    lastStatus: "unknown",
    lastCheckedAt: null,
    lastDetail: null,
    notifiedAt: null,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO watches
      (id, label, origin, destination, date, time, search_url, active, last_status, last_checked_at, last_detail, notified_at, created_at)
     VALUES (@id, @label, @origin, @destination, @date, @time, @searchUrl, @active, @lastStatus, @lastCheckedAt, @lastDetail, @notifiedAt, @createdAt)`
  ).run({
    ...watch,
    active: watch.active ? 1 : 0,
  });

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
