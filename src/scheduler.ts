import {
  getSettings,
  getWatch,
  listWatches,
  markNotified,
  markPartialNotified,
  recordCheckResult,
  setActive,
} from "./db.js";
import { report, resetReportThrottle, sendDiscordNotification } from "./notifier.js";
import { requestBookingApproval } from "./purchase.js";
import { checkAvailability, isBookable } from "./scraper.js";
import { VEHICLE_LABELS, type CheckResult, type TripLeg, type Watch } from "./types.js";

/**
 * One scrape at a time, whoever asked for it. A cycle is sequential on its own, but
 * "Kolla nu" arrives over HTTP and would otherwise open a second session against the site
 * mid-cycle. The cycle takes the lock per watch rather than holding it throughout, so a
 * manual check waits out one check (~35 s), not the whole cycle.
 */
let checkLock: Promise<unknown> = Promise.resolve();
let scraping = false;

function withCheckLock<T>(run: () => Promise<T>): Promise<T> {
  const result = checkLock.then(async () => {
    scraping = true;
    try {
      return await run();
    } finally {
      scraping = false;
    }
  });
  // Queue on a chain that always settles, so one failed check doesn't strand the rest.
  checkLock = result.catch(() => undefined);
  return result;
}

export async function runSingleCheck(watchId: string): Promise<CheckResult | undefined> {
  const watch = getWatch(watchId);
  if (!watch) return undefined;

  // The notification stays outside the lock — a slow webhook shouldn't hold up a check.
  const result = await withCheckLock(() => checkAvailability(watch));
  recordCheckResult(watch.id, result.status, result.detail);

  if (result.status === "available" && watch.booking.autoBook) {
    const approval = await requestBookingApproval(watch);
    if (approval.requested) {
      console.log(`  ${watch.label}: booking approval requested (${approval.detail}).`);
      return result;
    }
    // Auto-booking wanted this but couldn't get there (bot down, Reskort not offered,
    // over budget, ...) -- fall through to the plain notification so it isn't silent.
    // The reason is reported, not just logged: the watch found a seat and did not buy it,
    // which is the one outcome that looks identical to "nothing happened" from Discord.
    await report(
      "warn",
      `**Autobokning kördes inte** — ${watch.label}\n${approval.detail}\nSkickar vanlig notis i stället.`,
      { key: `autobook:${watch.id}` }
    );
  }

  // What decides this is whether a notification has landed, not how the status moved. A
  // failed webhook leaves the watch available and still searching, and keying off the
  // transition would then skip every later check — the status never changes again.
  const shouldNotify = result.status === "available" && !watch.notifiedAt;

  if (shouldNotify) {
    const delivered = await sendDiscordNotification(
      `🚢 **Ledig plats!** ${describeWatch(watch)}\n${result.detail}`
    );

    // The notification is the point of the watch, so stop once it lands. If it did not,
    // keep watching — otherwise a failed webhook would silently end the search.
    if (delivered) {
      markNotified(watch.id);
      setActive(watch.id, false);
      console.log(`  ${watch.label}: notified, watch deactivated.`);
    } else {
      // Nowhere to report this: the webhook is what failed. The console is the only
      // record, and the watch stays active so the next check tries again.
      console.warn(`  ${watch.label}: notification failed, keeping the watch active.`);
    }
  } else {
    await reportPartial(watch, result);
  }

  return result;
}

/**
 * The header line. Route, date and departure used to live here too, but each leg now
 * states its own — repeating them above only pushed the legs off a phone screen.
 */
function describeWatch(watch: Watch): string {
  const who = `${watch.adults} ${watch.adults === 1 ? "vuxen" : "vuxna"}`;
  return `${watch.label}\n${who} · ${VEHICLE_LABELS[watch.vehicle]}`;
}

/**
 * Half a return trip is worth knowing about — you may want to take the single — but it is
 * not what the watch is waiting for, so it keeps running. The leg is remembered so the
 * same half-open trip isn't announced every five minutes, while the *other* leg opening
 * still is. Falling back to nothing bookable forgets it again.
 */
async function reportPartial(watch: Watch, result: CheckResult): Promise<void> {
  if (result.status !== "partial") {
    if (watch.partialNotifiedLeg) markPartialNotified(watch.id, null);
    return;
  }

  const freeLeg: TripLeg | null = result.offer && isBookable(result.offer)
    ? "out"
    : result.returnOffer && isBookable(result.returnOffer)
      ? "return"
      : null;
  if (!freeLeg || freeLeg === watch.partialNotifiedLeg) return;

  const which = freeLeg === "out" ? "utresan" : "returen";
  const delivered = await sendDiscordNotification(
    `🟡 **Bara ${which} är ledig** — halv träff, bevakningen fortsätter.\n` +
      `${describeWatch(watch)}\n${result.detail}`
  );
  if (delivered) {
    markPartialNotified(watch.id, freeLeg);
    console.log(`  ${watch.label}: partial hit on the ${freeLeg} leg, still watching.`);
  }
}

/**
 * True once the watched departure's time has passed in Stockholm, where the timetable is
 * stated. Both sides are formatted as "YYYY-MM-DD HH:MM", so a string compare is enough
 * and no UTC-offset arithmetic is needed.
 */
export function hasDeparted(watch: Pick<Watch, "date" | "departureTime">, now = new Date()): boolean {
  const nowLocal = now.toLocaleString("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return nowLocal > `${watch.date} ${watch.departureTime}`;
}

export interface CycleOutcome {
  checked: number;
  deactivated: number;
  /** True when every check in the cycle failed, which we read as the site pushing back. */
  failed: boolean;
}

let running = false;

/** Random pause between the watches in a cycle. */
const CHECK_SPACING_MS = { min: 5_000, max: 20_000 };

export function spacingMs(random: () => number = Math.random): number {
  const { min, max } = CHECK_SPACING_MS;
  return Math.round(min + random() * (max - min));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCycle(): Promise<CycleOutcome> {
  if (running) {
    console.log("Previous check cycle still running, skipping this tick.");
    return { checked: 0, deactivated: 0, failed: false };
  }
  running = true;
  try {
    const active = listWatches().filter((w) => w.active);

    const departed = active.filter((w) => hasDeparted(w));
    for (const watch of departed) {
      setActive(watch.id, false);
      console.log(`  ${watch.label}: departure ${watch.date} ${watch.departureTime} has passed, deactivated.`);
    }

    const watches = active.filter((w) => !hasDeparted(w));
    console.log(`Checking ${watches.length} active watch(es)...`);

    let failures = 0;
    for (const [index, watch] of watches.entries()) {
      try {
        const result = await runSingleCheck(watch.id);
        console.log(`  ${watch.label}: ${result?.status ?? "error"}`);
        if (!result || result.status === "unknown") failures++;
      } catch (error) {
        // A throw here is not an ordinary failed check -- it is the check never finishing,
        // which is how a watch can go quiet for hours without a single message.
        await report(
          "error",
          `**Kontrollen kraschade** — ${watch.label}\n${error instanceof Error ? error.message : String(error)}`,
          { key: `check-threw:${watch.id}` }
        );
        failures++;
      }
      // The jitter spaces the cycles apart; without this the checks inside one cycle
      // still go out back to back, which is exactly the burst the jitter avoids.
      if (index < watches.length - 1) await sleep(spacingMs());
    }

    return {
      checked: watches.length,
      deactivated: departed.length,
      failed: watches.length > 0 && failures === watches.length,
    };
  } finally {
    running = false;
  }
}

/**
 * Delay before the next cycle: a base interval plus random jitter, so checks don't land on
 * the same clock tick every hour. Repeated all-failed cycles back off exponentially —
 * if the site is pushing back, knocking at the same rate helps nobody.
 */
export function nextDelayMs(
  baseMinutes: number,
  jitterMinutes: number,
  consecutiveFailures: number,
  random: () => number = Math.random
): number {
  const backoff = Math.min(2 ** consecutiveFailures, MAX_BACKOFF_FACTOR);
  const minutes = (baseMinutes + random() * jitterMinutes) * backoff;
  return Math.round(minutes * 60_000);
}

const MAX_BACKOFF_FACTOR = 8;

/** Minutes since midnight in Stockholm, where the timetable — and the user — lives. */
function stockholmMinutes(now: Date): number {
  const [hours, minutes] = now
    .toLocaleTimeString("sv-SE", {
      timeZone: "Europe/Stockholm",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .split(":")
    .map(Number);
  return hours * 60 + minutes;
}

function toMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Whether checks should run right now. `to` earlier than `from` reads as a window across
 * midnight (22:00–02:00), and equal values mean no window at all — check around the clock.
 */
export function isWithinWindow(from: string, to: string, now = new Date()): boolean {
  const current = stockholmMinutes(now);
  const start = toMinutes(from);
  const end = toMinutes(to);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/**
 * Time until the window next opens. Minute granularity is plenty for something that then
 * waits out a jittered interval anyway. A DST shift inside the wait moves the wake-up by
 * an hour, twice a year, which nobody watching a ferry will notice.
 */
export function msUntilWindowOpens(from: string, now = new Date()): number {
  const diff = toMinutes(from) - stockholmMinutes(now);
  return (diff > 0 ? diff : diff + 24 * 60) * 60_000;
}

let timer: NodeJS.Timeout | undefined;
let consecutiveFailures = 0;
let nextCheckAt: string | null = null;
let paused = false;
let idle = false;

/** Settings are read fresh here, so a change in the UI applies from the next cycle on. */
function scheduleNext(): void {
  // Nothing to check means nothing to schedule. An empty cycle would still wake up, find
  // no watches and re-arm, which shows up as a countdown that reaches zero and does
  // nothing. The watch list only changes through the UI, and each of those routes re-arms
  // the timer, so idling here cannot strand a watch that is switched back on.
  if (!listWatches().some((w) => w.active)) {
    idle = true;
    paused = false;
    nextCheckAt = null;
    timer = undefined;
    console.log("No active watch — idle until one is added or switched back on.");
    return;
  }
  idle = false;

  const { intervalMinutes, jitterMinutes, activeFrom, activeTo } = getSettings();
  const now = new Date();
  let delay: number;
  let note: string;

  if (isWithinWindow(activeFrom, activeTo, now)) {
    paused = false;
    delay = nextDelayMs(intervalMinutes, jitterMinutes, consecutiveFailures);
    note = consecutiveFailures > 0 ? ` (backoff after ${consecutiveFailures} failed cycle(s))` : "";
  } else {
    // Outside the window there is nothing to decide until it opens, so sleep until then
    // rather than waking every interval to conclude the same thing. The jitter still
    // applies, so the first check of the day doesn't land on the stroke of the hour.
    paused = true;
    delay = msUntilWindowOpens(activeFrom, now) + Math.round(Math.random() * jitterMinutes * 60_000);
    note = ` (outside the ${activeFrom}–${activeTo} window)`;
  }

  const at = new Date(now.getTime() + delay);
  nextCheckAt = at.toISOString();
  console.log(`Next check at ${at.toLocaleString("sv-SE")}${note}.`);
  timer = setTimeout(tick, delay);
  timer.unref?.();
}

async function tick(): Promise<void> {
  const { activeFrom, activeTo } = getSettings();
  // The window may have closed under us — the wait is long, and it is editable mid-wait.
  if (!isWithinWindow(activeFrom, activeTo)) {
    scheduleNext();
    return;
  }

  try {
    const outcome = await runCycle();
    if (outcome.failed) {
      consecutiveFailures++;
      // Every check in the cycle failed. Once is a blip; repeatedly is the scraper being
      // broken or the site pushing back, and the backoff then makes the silence longer.
      await report(
        "error",
        `**Alla kontroller misslyckades** (${consecutiveFailures} cykel(er) i rad) — ` +
          `intervallet förlängs ${Math.min(2 ** consecutiveFailures, MAX_BACKOFF_FACTOR)}×.`,
        { key: "cycle-failed" }
      );
    } else {
      if (consecutiveFailures > 0) {
        await report("info", `Kontrollerna fungerar igen efter ${consecutiveFailures} misslyckad(e) cykel(er).`, {
          key: "cycle-recovered",
          repeatAfterMinutes: 0,
        });
        resetReportThrottle();
      }
      consecutiveFailures = 0;
    }
  } catch (error) {
    consecutiveFailures++;
    await report("error", `**Kontrollcykeln kraschade**\n${error instanceof Error ? error.message : String(error)}`, {
      key: "cycle-threw",
    });
  }
  scheduleNext();
}

export function startScheduler(): void {
  const { intervalMinutes, jitterMinutes, activeFrom, activeTo } = getSettings();
  const window = activeFrom === activeTo ? "around the clock" : `between ${activeFrom} and ${activeTo}`;
  console.log(
    `Scheduling checks every ${intervalMinutes}–${intervalMinutes + jitterMinutes} minute(s) ${window}, with backoff on repeated failures.`
  );

  // Run once at startup so you don't have to wait for the first interval.
  void tick();
}

/**
 * Re-arm the timer with the current settings, so a shortened interval takes effect now
 * instead of after the pending wait. A cycle in flight schedules its own next tick from
 * the fresh settings, so leave that one alone rather than ending up with two timers.
 */
export function rescheduleNow(): void {
  if (running) return;
  if (timer) clearTimeout(timer);
  scheduleNext();
}

/**
 * Runs a cycle right now. Adding a watch is a question asked of the site, so answer it
 * instead of making the first check wait out a full interval. A cycle already in flight
 * is left alone — it would only put a second session against the site alongside it, and
 * it schedules the next one itself when it finishes.
 */
export function startCycleNow(): void {
  if (running) return;
  if (timer) clearTimeout(timer);
  timer = undefined;
  // There is a watch and a cycle starting on it, so say so now rather than at the end of
  // the cycle when the next timer is armed.
  idle = false;
  void tick();
}

export function getSchedulerState(): {
  nextCheckAt: string | null;
  checking: boolean;
  paused: boolean;
  idle: boolean;
  consecutiveFailures: number;
} {
  // While a cycle runs, `nextCheckAt` still holds the time it was started at, which would
  // read as a check that is overdue. Report the cycle instead.
  return {
    nextCheckAt: running ? null : nextCheckAt,
    // A manual check counts too — it is a session against the site like any other.
    checking: running || scraping,
    paused,
    // No active watch at all, which is a different thing from waiting out the window.
    idle,
    consecutiveFailures,
  };
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  nextCheckAt = null;
  paused = false;
  idle = false;
}
