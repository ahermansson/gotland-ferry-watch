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

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
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
