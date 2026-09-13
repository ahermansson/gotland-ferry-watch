/**
 * A mention to lead the notification with, e.g. `@everyone` or `<@123456789>`. Discord
 * only pushes a plain message to a phone when it thinks you aren't reading along
 * somewhere else, and it drops it entirely for a muted channel — a mention survives both.
 * Empty (or unset) posts the message on its own.
 */
function mentionPrefix(): string {
  const mention = process.env.DISCORD_MENTION?.trim();
  return mention ? `${mention} ` : "";
}

/**
 * Which mentions Discord is allowed to act on. A webhook can ping @everyone and any user
 * it names, so this is stated rather than left to the default: whatever ends up in the
 * message body — a lounge name, a label someone typed in the UI — cannot ping anyone.
 */
function allowedMentions(mention: string): { parse: string[]; users?: string[] } {
  if (mention.includes("@everyone")) return { parse: ["everyone"] };
  const users = [...mention.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
  return users.length ? { parse: [], users } : { parse: [] };
}

/**
 * Posts to the Discord webhook. Returns whether the message actually got through —
 * callers use that to decide whether it is safe to stop watching a departure.
 */
export async function sendDiscordNotification(message: string): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("DISCORD_WEBHOOK_URL is not set — skipping notification:", message);
    return false;
  }

  const prefix = mentionPrefix();

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `${prefix}${message}`,
        allowed_mentions: allowedMentions(prefix),
      }),
    });

    if (!res.ok) {
      console.error(`Discord webhook failed (${res.status}): ${await res.text()}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Discord webhook threw:", error);
    return false;
  }
}

/**
 * Operational reporting -- the second thing this file sends, and a different kind of
 * message from a notification. A notification is the point of the watch; a report is the
 * app saying what it just did or failed to do, so a silent failure cannot stay silent.
 *
 * It exists because every reason auto-booking declines to run was a `console.warn` in a
 * terminal nobody is looking at: from the outside a watch that found a seat and did not
 * book it was indistinguishable from one that never got the chance.
 *
 * `report()` is the ONE way out, the same rule sendDiscordNotification follows for
 * notifications: it always writes the console line too, so the terminal stays the full
 * record and the two can never disagree about what happened.
 */
export type ReportLevel = "info" | "warn" | "error";

const LEVEL_MARK: Record<ReportLevel, string> = { info: "ℹ️", warn: "⚠️", error: "❌" };

/** Last time a given key was posted, so a repeating condition doesn't repeat every cycle. */
const lastReported = new Map<string, number>();

/**
 * How long the same key stays quiet after being posted. A failing check repeats every
 * 10-15 minutes for as long as it is broken, and an hourly reminder says everything a
 * per-cycle one does without burying the notification the channel exists for.
 */
const DEFAULT_REPEAT_MINUTES = 60;

/** Reports go to their own webhook when one is set, so ops noise can live in its own channel. */
function reportWebhookUrl(): string | undefined {
  return process.env.DISCORD_LOG_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
}

/**
 * The other way a report can leave: the Discord bot posting into the channel named by
 * DISCORD_LOG_CHANNEL_ID. A channel addressed by id needs no webhook created for it, the
 * same way DISCORD_CHANNEL_ID already addresses the channel receipts go to.
 *
 * Registered rather than imported. The bot lives in purchase.ts, which imports report()
 * from here, so reaching back for it would close a cycle -- the same reason events.ts
 * takes its snapshot source from server.ts instead of building one.
 */
type LogChannelSender = (line: string) => Promise<boolean>;
let logChannelSend: LogChannelSender | null = null;

export function setLogChannelSender(send: LogChannelSender | null): void {
  logChannelSend = send;
}

export function resetReportThrottle(): void {
  lastReported.clear();
}

/**
 * Says what happened, in the console always and in Discord when it is worth a message.
 *
 * `key` is what the throttle counts as "the same thing" -- pass a stable one per watch and
 * condition (`autobook:<id>`), so one broken watch reporting hourly doesn't silence a
 * second watch breaking for another reason. Without a key the message text is the key.
 * `repeatAfterMinutes: 0` turns the throttle off for events that are already rare.
 *
 * Never throws and never blocks the caller's real work: a report that cannot be delivered
 * is still on the console, which is strictly more than this code did before.
 */
export async function report(
  level: ReportLevel,
  message: string,
  options: { key?: string; repeatAfterMinutes?: number } = {}
): Promise<boolean> {
  const line = `${LEVEL_MARK[level]} ${message}`;
  const toConsole = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  toConsole(line);

  const key = options.key ?? message;
  const repeatAfter = (options.repeatAfterMinutes ?? DEFAULT_REPEAT_MINUTES) * 60_000;
  const previous = lastReported.get(key);
  if (previous !== undefined && repeatAfter > 0 && Date.now() - previous < repeatAfter) return false;

  // The bot first, when it is connected and a log channel is named; the webhook otherwise.
  // The order matters more than it looks. Three of the reports in this project are the bot
  // itself failing -- a missing token, a refused login, a dropped gateway -- and those are
  // exactly the moments this sender is absent or answers false. They leave through the
  // webhook as they always did, rather than being swallowed by the thing they are about.
  // Wrapped, not trusted. This function is registered from outside, and the promise this
  // file makes -- never throws, never blocks the caller's real work -- has to hold even
  // when whoever registered it gets that wrong. A throw here would otherwise travel up
  // into the scheduler tick that was only trying to say something had failed.
  let sentToChannel = false;
  if (logChannelSend) {
    try {
      sentToChannel = await logChannelSend(line);
    } catch (error) {
      console.error("Discord log channel threw:", error);
    }
  }
  if (sentToChannel) {
    lastReported.set(key, Date.now());
    return true;
  }

  const webhookUrl = reportWebhookUrl();
  if (!webhookUrl) return false;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Reports never ping. They are frequent enough to be a nuisance and none of them is
      // the thing you asked to be woken for -- that is what a notification is.
      body: JSON.stringify({ content: line, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) {
      console.error(`Discord report failed (${res.status}): ${await res.text()}`);
      return false;
    }
    // Stamped only on a delivered report, so a webhook outage doesn't start the quiet
    // period for a condition Discord was never told about.
    lastReported.set(key, Date.now());
    return true;
  } catch (error) {
    console.error("Discord report threw:", error);
    return false;
  }
}
