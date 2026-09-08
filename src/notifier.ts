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
