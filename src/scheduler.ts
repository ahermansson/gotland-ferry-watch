import { getWatch, listWatches, recordCheckResult, setActive } from "./db.js";
import { sendDiscordNotification } from "./notifier.js";
import { checkAvailability, summarizeOffer } from "./scraper.js";
import { VEHICLE_LABELS, type CheckResult, type Watch } from "./types.js";

export async function runSingleCheck(watchId: string): Promise<CheckResult | undefined> {
  const watch = getWatch(watchId);
  if (!watch) return undefined;

  const result = await checkAvailability(watch);
  const becameAvailable = result.status === "available" && watch.lastStatus !== "available";

  recordCheckResult(watch.id, result.status, result.detail, becameAvailable);

  if (becameAvailable) {
    const vehicle = VEHICLE_LABELS[watch.vehicle];
    const header =
      `🚢 **Ledig plats!** ${watch.label}\n` +
      `${watch.route.replace("-", " → ")}, ${watch.date} kl ${watch.departureTime} · ` +
      `${watch.adults} vuxen/vuxna · ${vehicle}`;
    const body = result.offer ? summarizeOffer(result.offer) : result.detail;
    const delivered = await sendDiscordNotification(`${header}\n${body}`);

    // The notification is the point of the watch, so stop once it lands. If it did not,
    // keep watching — otherwise a failed webhook would silently end the search.
    if (delivered) {
      setActive(watch.id, false);
      console.log(`  ${watch.label}: notified, watch deactivated.`);
    } else {
      console.warn(`  ${watch.label}: notification failed, keeping the watch active.`);
    }
  }

  return result;
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
    for (const watch of watches) {
      try {
        const result = await runSingleCheck(watch.id);
        console.log(`  ${watch.label}: ${result?.status ?? "error"}`);
        if (!result || result.status === "unknown") failures++;
      } catch (error) {
        console.error(`  ${watch.label}: check threw`, error);
        failures++;
      }
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

let timer: NodeJS.Timeout | undefined;

export function startScheduler(): void {
  const baseMinutes = Number(process.env.CHECK_INTERVAL_MINUTES ?? "10");
  const jitterMinutes = Number(process.env.CHECK_JITTER_MINUTES ?? "5");
  let consecutiveFailures = 0;

  console.log(
    `Scheduling checks every ${baseMinutes}–${baseMinutes + jitterMinutes} minute(s), with backoff on repeated failures.`
  );

  const scheduleNext = () => {
    const delay = nextDelayMs(baseMinutes, jitterMinutes, consecutiveFailures);
    const when = new Date(Date.now() + delay).toLocaleTimeString("sv-SE");
    const note = consecutiveFailures > 0 ? ` (backoff after ${consecutiveFailures} failed cycle(s))` : "";
    console.log(`Next check at ${when}${note}.`);
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };

  const tick = async () => {
    try {
      const outcome = await runCycle();
      consecutiveFailures = outcome.failed ? consecutiveFailures + 1 : 0;
    } catch (error) {
      console.error("Check cycle threw:", error);
      consecutiveFailures++;
    }
    scheduleNext();
  };

  // Run once at startup so you don't have to wait for the first interval.
  void tick();
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
