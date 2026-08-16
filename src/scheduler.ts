import cron from "node-cron";
import { getWatch, listWatches, recordCheckResult } from "./db.js";
import { sendDiscordNotification } from "./notifier.js";
import { checkAvailability } from "./scraper.js";
import type { CheckResult } from "./types.js";

export async function runSingleCheck(watchId: string): Promise<CheckResult | undefined> {
  const watch = getWatch(watchId);
  if (!watch) return undefined;

  const result = await checkAvailability(watch);
  const becameAvailable = result.status === "available" && watch.lastStatus !== "available";

  recordCheckResult(watch.id, result.status, result.detail, becameAvailable);

  if (becameAvailable) {
    const when = watch.time ? `${watch.date} ${watch.time}` : watch.date;
    await sendDiscordNotification(
      `🚢 Ledig plats! **${watch.label}** — ${watch.origin} → ${watch.destination}, ${when}\n${result.detail}`
    );
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

export function startScheduler(): void {
  const intervalMinutes = Number(process.env.CHECK_INTERVAL_MINUTES ?? "10");
  const cronExpression = `*/${Math.max(1, Math.round(intervalMinutes))} * * * *`;

  console.log(`Scheduling checks every ${intervalMinutes} minute(s) (${cronExpression}).`);
  cron.schedule(cronExpression, () => {
    void runCycle();
  });

  // Also run once at startup so you don't have to wait for the first tick.
  void runCycle();
}
