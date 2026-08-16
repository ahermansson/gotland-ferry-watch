import cron from "node-cron";
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

let running = false;

async function runCycle(): Promise<void> {
  if (running) {
    console.log("Previous check cycle still running, skipping this tick.");
    return;
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
    for (const watch of watches) {
      try {
        const result = await runSingleCheck(watch.id);
        console.log(`  ${watch.label}: ${result?.status ?? "error"}`);
      } catch (error) {
        console.error(`  ${watch.label}: check threw`, error);
      }
    }
  } finally {
    running = false;
  }
}

/**
 * node-cron's `*​/N` only lines up with the hour when N divides 60, so we pick the nearest
 * divisor instead of silently checking at uneven gaps.
 */
export function cronExpressionFor(intervalMinutes: number): string {
  const divisors = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
  const wanted = Math.max(1, Math.round(intervalMinutes));
  const chosen = divisors.reduce((best, d) =>
    Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best
  );
  return chosen === 60 ? "0 * * * *" : `*/${chosen} * * * *`;
}

export function startScheduler(): void {
  const intervalMinutes = Number(process.env.CHECK_INTERVAL_MINUTES ?? "10");
  const cronExpression = cronExpressionFor(intervalMinutes);

  console.log(`Scheduling checks every ${intervalMinutes} minute(s) (${cronExpression}).`);
  cron.schedule(cronExpression, () => {
    void runCycle();
  });

  // Also run once at startup so you don't have to wait for the first tick.
  void runCycle();
}
