/**
 * What happens once a watch with Auto on finds its departure: prepare the checkout and
 * pay it. There is no approval step and no second switch -- AUTO_BOOKING_ENABLED=1 means
 * the server buys, and the per-watch Auto switch decides which departures it buys.
 *
 * The asking flow this file used to hold is gone. It could not do what a ferry watch is
 * for: at 04:00 a cancellation appears, a checkout is prepared, nobody is awake to press
 * a button, and ten minutes later the session is dropped and prepared again on the next
 * cycle -- all night, against the ferry's site, buying nothing. A switch that has to be
 * on for the thing to work is not a safety feature, it is a way to be surprised twice.
 *
 * So what stands in front of a purchase is now exactly this, and it is worth knowing by
 * heart: AUTO_BOOKING_ENABLED, the watch's own Auto switch, the fare class and lounge
 * that watch asked for, and the price cap prepareBooking refuses to exceed. Discord is
 * told afterwards, with the screenshot, and never asked beforehand.
 *
 * pressBetala (src/booking.ts) is called from exactly one place: buyNow, below, on a
 * checkout prepareBooking returned ok. It is not reachable from the scraper, from a
 * route, or from `npm run book`.
 */
import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  type SendableChannels,
} from "discord.js";
import { buildTripInvite } from "./calendar.js";
import { recordCheckResult, setActive } from "./db.js";
import { broadcast } from "./events.js";
import { report, setLogChannelSender } from "./notifier.js";
import { pressBetala, prepareBooking, type PreparedBooking } from "./booking.js";
import type { Watch } from "./types.js";

let client: Client | undefined;

/** Watch ids from "found available" until the purchase settles -- the dedup net. */
const inFlight = new Set<string>();

/** The master switch: off means auto-booking never prepares a checkout at all. */
export function autoBookingEnabled(): boolean {
  return process.env.AUTO_BOOKING_ENABLED === "1";
}

export async function startDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    // Reported through the webhook rather than logged: the bot is precisely what is
    // missing, so it cannot announce its own absence, and every auto-booking from here on
    // will decline for this reason.
    await report(
      "warn",
      "**DISCORD_BOT_TOKEN saknas** — autobokning har ingen väg att visa vad den köpt och köper därför inget.",
      { repeatAfterMinutes: 0 }
    );
    return;
  }
  const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
  // A dropped gateway connection leaves `client` set but unusable, so the next purchase
  // fails on the channel fetch with a misleading reason. Say what actually happened.
  bot.on("error", (error) => void report("error", `**Discord-boten tappade anslutningen** — ${error.message}`, {
    key: "bot-error",
  }));
  bot.once("clientReady", () => void report("info", "Discord-boten ansluten.", { repeatAfterMinutes: 0 }));

  try {
    await bot.login(token);
  } catch (error) {
    // Only assigned on a successful login. Set before it, `client` is truthy while the
    // bot is unusable, and the screenshot of a purchase goes nowhere.
    await report(
      "error",
      `**Discord-boten kunde inte logga in** — autobokning är avstängd i praktiken.\n${
        error instanceof Error ? error.message : String(error)
      }`,
      { repeatAfterMinutes: 0 }
    );
    return;
  }
  client = bot;
  // Ops reports can now leave through the bot, into whatever channel DISCORD_LOG_CHANNEL_ID
  // names -- a channel nobody has to create a webhook for. Registered only here, after a
  // successful login: before it the bot cannot send, and report() falls back to the webhook,
  // which is what carries the reports about this bot failing to start at all.
  setLogChannelSender(async (line) => {
    const logChannelId = process.env.DISCORD_LOG_CHANNEL_ID;
    if (!logChannelId) return false;
    const channel = await bot.channels.fetch(logChannelId).catch(() => null);
    if (!channel || typeof (channel as SendableChannels).send !== "function") return false;
    try {
      // Reports never ping, the same rule the webhook path follows: they are frequent, and
      // none of them is the thing you asked to be woken for.
      await (channel as SendableChannels).send({ content: line, allowedMentions: { parse: [] } });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Called by the scheduler when a watch with auto-booking on finds an available departure.
 * Prepares the checkout and pays it.
 *
 * `handled: true` means Discord has been told what happened -- bought, or attempted and
 * gone wrong -- so the caller must NOT also send a plain "seat available" notification.
 * `false` means nothing was bought and nothing was said, and the notification is the
 * caller's to send.
 */
export async function autoBookNow(watch: Watch): Promise<{ handled: boolean; detail: string }> {
  if (!autoBookingEnabled()) return { handled: false, detail: "AUTO_BOOKING_ENABLED är av." };
  if (!watch.booking.autoBook) return { handled: false, detail: "Auto är avstängt för bevakningen." };
  if (inFlight.has(watch.id)) return { handled: true, detail: "Ett köp för den här bevakningen pågår redan." };

  // The bot is how the receipt and its screenshot get out, not how the purchase is
  // decided. Buying is refused when it is down only because a purchase nobody can be
  // shown evidence of is worse than a missed seat -- the watch stays active and the
  // plain notification goes out instead.
  if (!client) return { handled: false, detail: "Discord-boten är inte ansluten." };

  inFlight.add(watch.id);
  try {
    return await prepareAndBuy(watch);
  } catch (error) {
    // The id is released on every ordinary refusal inside, but a THROW used to skip all of
    // them: prepareBooking rejecting outside its own try (chromium.launch failing, say)
    // left the id in inFlight for the life of the process, and from then on every check
    // read "ett köp pågår redan" and returned early -- no booking, and no notification
    // either, for ever. Silence was the one outcome this whole file exists to prevent.
    inFlight.delete(watch.id);
    return {
      handled: false,
      detail: `Förberedelsen kraschade: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The body of autoBookNow, split out so the inFlight guard above is a plain try/catch
 * around the whole of it rather than a delete repeated on every exit.
 */
async function prepareAndBuy(watch: Watch): Promise<{ handled: boolean; detail: string }> {
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const channel = client && channelId ? await client.channels.fetch(channelId).catch(() => null) : null;

  const prepared = await prepareBooking(watch);
  if (!prepared.ok) {
    inFlight.delete(watch.id);
    return { handled: false, detail: prepared.detail };
  }

  return buyNow(watch, prepared, channel);
}

/**
/**
 * Pays the prepared checkout, and tells Discord afterwards. The one call site is
 * prepareAndBuy above, on a checkout prepareBooking already held against the watch's
 * price cap.
 *
 * The message never pings. The whole point of the watch is that a 04:00 cancellation is
 * bought while you sleep, and waking you to say it worked would undo that: the purchase
 * is there in the morning, with the screenshot. It is sent even when the bot is absent --
 * through the webhook, which needs no connection -- because a purchase nobody was told
 * about is the worst outcome this file can produce.
 */
async function buyNow(
  watch: Watch,
  prepared: PreparedBooking,
  channel: unknown
): Promise<{ handled: boolean; detail: string }> {
  try {
    const result = await pressBetala(prepared);
    const spent = prepared.total != null ? `${prepared.total} kr` : "okänt belopp";

    if (result.ok) {
      recordCheckResult(watch.id, "booked", result.detail);
      setActive(watch.id, false);
      broadcast("watches");
    }

    const headline = result.ok
      ? `🎫 **Köpt automatiskt** — ${watch.label}\n${spent} med Reskort. ${result.detail}`
      : `⚠️ **Betala klickades men flödet rapporterade ett problem** — ${watch.label}\n${result.detail}\n` +
        `Kontrollera kontot manuellt.`;

    // Through the bot when there is one, since the screenshot is the whole evidence of
    // what was bought; otherwise the webhook, which is always there.
    const sent = await postWithScreenshot(
      channel,
      headline,
      result.screenshotPath,
      // Only on a purchase that went through -- a failed Betala has no trip to put in a
      // calendar, and attaching one would say it does.
      result.ok ? tripInviteAttachment(prepared) : []
    );
    if (!sent) await report(result.ok ? "info" : "warn", headline, { repeatAfterMinutes: 0 });

    return { handled: true, detail: result.detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Betala may or may not have gone through. Say exactly that, and never quietly.
    await report(
      "error",
      `❌ **Automatiskt köp kastade ett fel efter att Betala klickats** — ${watch.label}\n${detail}\n` +
        `Kontrollera kontot manuellt innan du litar på bevakningen.`,
      { repeatAfterMinutes: 0 }
    );
    return { handled: true, detail: `Köpet kastade: ${detail}` };
  } finally {
    inFlight.delete(watch.id);
  }
}

/** Posts through the bot when one is connected and can write here. Returns whether it did. */
async function postWithScreenshot(
  channel: unknown,
  content: string,
  screenshotPath?: string,
  extraFiles: AttachmentBuilder[] = []
): Promise<boolean> {
  if (!channel || typeof (channel as SendableChannels).send !== "function") return false;
  try {
    await (channel as SendableChannels).send({
      content,
      files: [...(screenshotPath ? [new AttachmentBuilder(screenshotPath)] : []), ...extraFiles],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The .ics for a completed purchase, as a list so a failure is simply an empty one. It
 * matters more here than it looks: nobody was awake to read the times as the trip was
 * bought, so the invite is where they first arrive.
 *
 * A missing invite is a shame, not a reason to hide that the purchase went through, so
 * this never throws. It cannot reach the webhook fallback in buyNow either, which carries
 * no files at all -- the same limit the screenshot has always had there.
 */
function tripInviteAttachment(prepared: PreparedBooking): AttachmentBuilder[] {
  const { watch, arrival, returnArrival } = prepared;
  try {
    return [new AttachmentBuilder(buildTripInvite(watch, arrival, returnArrival), { name: "resa.ics" })];
  } catch (error) {
    console.error(`${watch.label}: could not build the calendar invite:`, error);
    return [];
  }
}
