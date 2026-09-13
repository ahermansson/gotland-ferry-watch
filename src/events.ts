/**
 * The server telling open pages that something changed, so the UI needs no timer.
 *
 * Server-Sent Events rather than a socket: this is one-way by nature -- the browser has
 * nothing to say back that an ordinary request doesn't already carry -- and EventSource
 * reconnects on its own, which is the half of a long-polling loop that is easy to get
 * wrong.
 *
 * What is sent is a NUDGE, never the data: `/api/watches` and `/api/settings` stay the
 * only definition of what a watch or the schedule looks like. A payload here would be a
 * second copy of both, and the two would drift the first time either changed.
 *
 * The events exist because server-side state changes in only a handful of moments: a
 * cycle starting, a check finishing, the next cycle being scheduled, and a purchase going
 * through. Everything else a page shows, it changed itself and already knows.
 */
import type { Response } from "express";

/** `watches` -- a watch's status, activity or existence. `scheduler` -- the countdown. */
export type ChangeKind = "watches" | "scheduler";

const clients = new Set<Response>();

/**
 * Proxies and browsers both drop an idle connection, and a dropped stream looks exactly
 * like a quiet one. A comment line is the protocol's own way of saying "still here".
 */
const HEARTBEAT_MS = 25_000;
let heartbeat: NodeJS.Timeout | undefined;

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  // Never the reason the process stays alive.
  heartbeat.unref?.();
}

function stopHeartbeat(): void {
  if (!heartbeat || clients.size > 0) return;
  clearInterval(heartbeat);
  heartbeat = undefined;
}

/** Registers an open response as a subscriber until the client goes away. */
export function addClient(res: Response): void {
  clients.add(res);
  startHeartbeat();
  res.on("close", () => {
    clients.delete(res);
    stopHeartbeat();
  });
}

/**
 * Tells every open page that something of `kind` changed. Never throws: a page that has
 * gone away mid-write must not take down the check that was reporting its own result.
 */
export function broadcast(kind: ChangeKind): void {
  for (const res of clients) {
    try {
      res.write(`event: ${kind}\ndata: {}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

/** How many pages are listening -- for the log line at startup and nothing else. */
export function clientCount(): number {
  return clients.size;
}
