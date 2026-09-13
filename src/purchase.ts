/**
 * What happens once a watch with Auto on finds its departure: prepare the checkout, and
 * then either ask or buy.
 *
 * ASK is the default and the original design. A webhook (notifier.ts) can only push text
 * -- it cannot listen for a click -- so a real Discord bot sits in the target channel,
 * posts the prepared checkout with buttons, and the browser session stays parked until a
 * user in DISCORD_APPROVERS presses "Godkänn köp" inside the approval window.
 *
 * BUY is `AUTO_BOOKING_UNATTENDED=1`, and it is what makes a watch worth running at four
 * in the morning: the same prepared checkout is paid immediately, and Discord is told
 * afterwards rather than asked beforehand. The rule this revises used to read "nothing
 * here can spend the travel credit on its own", and it is revised deliberately, because
 * the alternative was a night-time auto-booking that prepares a purchase nobody is awake
 * to approve and drops it ten minutes later.
 *
 * pressBetala (src/booking.ts) is still called from exactly two places, both in this file
 * and both in this order: after an approved click, or after prepareBooking returned ok
 * with unattended buying on. It is never reachable from the scraper, from a route, or
 * from `npm run book`.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  type ButtonInteraction,
  type Message,
  type SendableChannels,
} from "discord.js";
import { buildTripInvite } from "./calendar.js";
import { recordCheckResult, setActive } from "./db.js";
import { broadcast } from "./events.js";
import { report } from "./notifier.js";
import { pressBetala, prepareBooking, type PreparedBooking } from "./booking.js";
import type { Watch } from "./types.js";

let client: Client | undefined;

interface PendingApproval {
  prepared: PreparedBooking;
  message: Message;
  timer: NodeJS.Timeout;
}

/** Keyed by watch id: at most one prepared, unapproved checkout per watch at a time. */
const pending = new Map<string, PendingApproval>();
/** Watch ids from "found available" to "approved/rejected/expired" -- the dedup net. */
const inFlight = new Set<string>();

function approverIds(): Set<string> {
  return new Set(
    (process.env.DISCORD_APPROVERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

/** The master switch: off means auto-booking never prepares a checkout at all. */
export function autoBookingEnabled(): boolean {
  return process.env.AUTO_BOOKING_ENABLED === "1";
}

/**
 * Whether a prepared checkout is PAID without asking anyone first.
 *
 * This is the one setting in the project that spends money with nobody watching, so it is
 * off unless it says exactly "1" -- no truthiness, no "true", no default. It narrows
 * nothing on its own: AUTO_BOOKING_ENABLED must also be on, the watch's own Auto switch
 * must be on, and the price cap still refuses a checkout that came out too expensive.
 * Those three plus the cap are what stands between a scrape and a purchase.
 *
 * Off -- the default, and what the project shipped with -- the flow stops at the checkout
 * and asks in Discord exactly as before.
 */
export function unattendedBuying(): boolean {
  return process.env.AUTO_BOOKING_UNATTENDED === "1";
}

export async function startApprovalBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    // Reported through the webhook rather than logged: the bot is precisely what is
    // missing, so it cannot announce its own absence, and every auto-booking from here on
    // will decline for this reason.
    await report(
      "warn",
      "**DISCORD_BOT_TOKEN saknas** — autobokning kan inte begära godkännande och kommer aldrig köpa något.",
      { repeatAfterMinutes: 0 }
    );
    return;
  }
  const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
  bot.on("interactionCreate", (interaction) => {
    if (interaction.isButton()) void handleButton(interaction);
  });
  // A dropped gateway connection leaves `client` set but unusable, so the next approval
  // fails on the channel fetch with a misleading reason. Say what actually happened.
  bot.on("error", (error) => void report("error", `**Discord-boten tappade anslutningen** — ${error.message}`, {
    key: "bot-error",
  }));
  bot.once("clientReady", () => void report("info", "Discord-godkännandebot ansluten.", { repeatAfterMinutes: 0 }));

  try {
    await bot.login(token);
  } catch (error) {
    // Only assigned on a successful login. Set before it, `client` is truthy while the
    // bot is unusable, and requestBookingApproval's "är inte ansluten" check passes when
    // it should be the thing that stops the attempt.
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
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const [action, watchId] = interaction.customId.split(":");
  if (action !== "approve" && action !== "reject") return;

  const entry = pending.get(watchId);
  if (!entry) {
    await interaction.reply({ content: "Det här köpet är inte längre aktuellt.", ephemeral: true });
    return;
  }
  if (!approverIds().has(interaction.user.id)) {
    await interaction.reply({ content: "Du är inte godkänd att klicka på det här.", ephemeral: true });
    return;
  }

  clearTimeout(entry.timer);
  pending.delete(watchId);
  // Removed before the button lands, not after -- a second click while pressBetala is
  // already running must not be able to fire it twice.
  await interaction.update({ components: [] });

  if (action === "reject") {
    await entry.prepared.cancel();
    inFlight.delete(watchId);
    await interaction.followUp(`Avbrutet av ${interaction.user.username}. Bevakningen fortsätter.`);
    return;
  }

  try {
    const result = await pressBetala(entry.prepared);
    if (result.ok) {
      recordCheckResult(watchId, "booked", result.detail);
      setActive(watchId, false);
      // Not after a check: minutes later, when somebody pressed a button in Discord. Left
      // out, the page keeps saying "Ledig plats!" about a trip that is already bought.
      broadcast("watches");
      await interaction.followUp({
        content: `✅ Köpt, godkänt av ${interaction.user.username}. ${result.detail}`,
        files: tripInviteAttachment(entry.prepared),
      });
    } else {
      await interaction.followUp(`⚠️ Betala klickades men flödet rapporterade ett problem: ${result.detail}`);
    }
  } catch (error) {
    await interaction.followUp(
      `❌ Något gick fel efter klicket -- kontrollera kontot manuellt: ${
        error instanceof Error ? error.message : error
      }`
    );
  } finally {
    inFlight.delete(watchId);
  }
}

async function expire(watchId: string): Promise<void> {
  const entry = pending.get(watchId);
  if (!entry) return;
  pending.delete(watchId);
  inFlight.delete(watchId);
  await entry.prepared.cancel();
  try {
    await entry.message.edit({ components: [] });
    await entry.message.reply("⏱️ Ingen godkände i tid -- sessionen släpptes. Bevakningen fortsätter.");
  } catch {
    // The reply is the notice; if the message or channel is gone, the webhook still is.
    await report("warn", `**Godkännandet gick ut** — ${watchId}. Sessionen släpptes, bevakningen fortsätter.`, {
      repeatAfterMinutes: 0,
    });
  }
}

/**
 * Called by the scheduler when a watch with auto-booking on finds an available departure.
 * Prepares the checkout and posts it for approval; returns without ever having pressed
 * anything. `requested: false` means the caller should fall back to a plain notification
 * instead -- nothing is waiting in Discord for that watch.
 */
export async function requestBookingApproval(watch: Watch): Promise<{ requested: boolean; detail: string }> {
  if (!autoBookingEnabled()) return { requested: false, detail: "AUTO_BOOKING_ENABLED är av." };
  if (!watch.booking.autoBook) return { requested: false, detail: "Auto är avstängt för bevakningen." };
  if (inFlight.has(watch.id)) return { requested: true, detail: "Ett köp väntar redan på godkännande." };
  if (!client && !unattendedBuying()) return { requested: false, detail: "Discord-boten är inte ansluten." };

  const channelId = process.env.DISCORD_CHANNEL_ID;
  // Only the ASK path needs somewhere to ask and somebody to answer. Refusing to BUY
  // because the bot is down would be the setting failing exactly when it is needed: at
  // night, unattended, which is the whole reason it was turned on.
  if (!unattendedBuying()) {
    if (!channelId) return { requested: false, detail: "DISCORD_CHANNEL_ID saknas." };
    if (approverIds().size === 0) {
      return { requested: false, detail: "DISCORD_APPROVERS är tom -- ingen kan godkänna." };
    }
  }

  inFlight.add(watch.id);
  try {
    return await prepareAndAsk(watch, client, channelId);
  } catch (error) {
    // The id is released on every ordinary refusal below, but a THROW used to skip all of
    // them: prepareBooking rejecting outside its own try (chromium.launch failing, say)
    // left the id in inFlight for the life of the process, and from then on every check
    // read "ett köp väntar redan" and returned early -- no booking, and no notification
    // either, for ever. Silence was the one outcome this whole file exists to prevent.
    inFlight.delete(watch.id);
    return {
      requested: false,
      detail: `Förberedelsen kraschade: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The body of requestBookingApproval, split out so the inFlight guard above is a plain
 * try/catch around the whole of it rather than a delete repeated on every exit.
 */
async function prepareAndAsk(
  watch: Watch,
  client: Client | undefined,
  channelId: string | undefined
): Promise<{ requested: boolean; detail: string }> {
  // Fetched up front on the ASK path, so a misconfigured channel is found BEFORE a
  // checkout is driven and then thrown away. Unattended buying needs no channel.
  const channel = client && channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  if (!unattendedBuying() && (!channel || !channel.isTextBased() || !("send" in channel))) {
    inFlight.delete(watch.id);
    return { requested: false, detail: "DISCORD_CHANNEL_ID pekar inte på en textkanal boten kan skriva i." };
  }

  const prepared = await prepareBooking(watch);
  if (!prepared.ok) {
    inFlight.delete(watch.id);
    return { requested: false, detail: prepared.detail };
  }

  if (unattendedBuying()) return buyNow(watch, prepared, channel);

  const minutes = Number(process.env.BOOKING_APPROVAL_MINUTES ?? "10");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`approve:${watch.id}`).setLabel("Godkänn köp").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reject:${watch.id}`).setLabel("Avbryt").setStyle(ButtonStyle.Danger)
  );

  let message: Message;
  try {
    message = await (channel as SendableChannels).send({
      content:
        `🎫 **Redo att köpa** — ${watch.label}\n${prepared.detail}\n` +
        `Godkänn inom ${minutes} min, annars släpps sessionen och bevakningen fortsätter.`,
      components: [row],
      files: [new AttachmentBuilder(prepared.screenshotPath)],
    });
  } catch (error) {
    await prepared.cancel();
    inFlight.delete(watch.id);
    return { requested: false, detail: `Kunde inte posta i Discord: ${error instanceof Error ? error.message : error}` };
  }

  const timer = setTimeout(() => void expire(watch.id), minutes * 60_000);
  pending.set(watch.id, { prepared, message, timer });

  return { requested: true, detail: prepared.detail };
}

/**
 * Pays the prepared checkout, and tells Discord afterwards. Reached only with
 * AUTO_BOOKING_UNATTENDED=1, from the one call site above, on a checkout prepareBooking
 * already held against the watch's price cap.
 *
 * The message never pings. Somebody who turned this on did it so a 04:00 cancellation
 * would be bought while they slept, and waking them to say it worked would undo the
 * point; the purchase is there in the morning, with the screenshot. It is sent even when
 * the bot is absent -- through the webhook, which needs no connection -- because a
 * purchase nobody was told about is the one outcome worse than a purchase nobody
 * approved.
 */
async function buyNow(
  watch: Watch,
  prepared: PreparedBooking,
  channel: unknown
): Promise<{ requested: boolean; detail: string }> {
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

    return { requested: true, detail: result.detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Betala may or may not have gone through. Say exactly that, and never quietly.
    await report(
      "error",
      `❌ **Automatiskt köp kastade ett fel efter att Betala klickats** — ${watch.label}\n${detail}\n` +
        `Kontrollera kontot manuellt innan du litar på bevakningen.`,
      { repeatAfterMinutes: 0 }
    );
    return { requested: true, detail: `Köpet kastade: ${detail}` };
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
 * The .ics for a completed purchase, as a list so a failure is simply an empty one. Both
 * ways of completing a purchase attach it: the approved click, and the unattended buy --
 * which is the one that needs it most, since nobody was awake to read the times.
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
