import cron from "node-cron";
import { getWatch, listWatches, recordCheckResult } from "./db.js";
import { sendDiscordNotification } from "./notifier.js";
import { checkAvailability, summarizeOffer } from "./scraper.js";
import { VEHICLE_LABELS, type CheckResult } from "./types.js";

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
    await sendDiscordNotification(`${header}\n${body}`);
  }

  return result;
}

let running = false;

async function runCycle(): Promise<void> {
  if (running) {
    console.log("Previous check cycle still running, skipping this tick.");
    return;
  }
  running = true;
  try {
    const watches = listWatches().filter((w) => w.active);
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
