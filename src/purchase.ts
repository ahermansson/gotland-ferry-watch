/**
 * The approval side of auto-booking. A webhook (notifier.ts) can only push text -- it
 * cannot listen for a click -- so a real Discord bot sits in the target channel instead,
 * posts the prepared checkout as a message with buttons, and waits.
 *
 * Nothing here can spend the travel credit on its own. `requestBookingApproval` prepares
 * a checkout and then only ever asks; the browser session it opened stays parked until a
 * user in DISCORD_APPROVERS clicks "Godkänn köp" inside the approval window, at which
 * point -- and only at which point -- pressBetala (src/booking.ts) is called.
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
} from "discord.js";
import { recordCheckResult, setActive } from "./db.js";
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

/** The master switch: off means requestBookingApproval never prepares a checkout at all. */
export function autoBookingEnabled(): boolean {
  return process.env.AUTO_BOOKING_ENABLED === "1";
}

export async function startApprovalBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn(
      "DISCORD_BOT_TOKEN saknas -- auto-bokning kan inte begära godkännande och kommer aldrig köpa något."
    );
    return;
  }
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on("interactionCreate", (interaction) => {
    if (interaction.isButton()) void handleButton(interaction);
  });
  client.once("clientReady", () => console.log("Discord-godkännandebot ansluten."));
  await client.login(token);
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
      await interaction.followUp(`✅ Köpt, godkänt av ${interaction.user.username}. ${result.detail}`);
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
    /* the message or channel may be gone by now */
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
  if (!client) return { requested: false, detail: "Discord-boten är inte ansluten." };

  const channelId = process.env.DISCORD_CHANNEL_ID;
  const approvers = approverIds();
  if (!channelId) return { requested: false, detail: "DISCORD_CHANNEL_ID saknas." };
  if (approvers.size === 0) return { requested: false, detail: "DISCORD_APPROVERS är tom -- ingen kan godkänna." };

  inFlight.add(watch.id);

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    inFlight.delete(watch.id);
    return { requested: false, detail: "DISCORD_CHANNEL_ID pekar inte på en textkanal boten kan skriva i." };
  }

  const prepared = await prepareBooking(watch);
  if (!prepared.ok) {
    inFlight.delete(watch.id);
    return { requested: false, detail: prepared.detail };
  }

  const minutes = Number(process.env.BOOKING_APPROVAL_MINUTES ?? "10");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`approve:${watch.id}`).setLabel("Godkänn köp").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reject:${watch.id}`).setLabel("Avbryt").setStyle(ButtonStyle.Danger)
  );

  let message: Message;
  try {
    message = await channel.send({
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
