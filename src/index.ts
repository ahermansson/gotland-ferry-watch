import "dotenv/config";
import { report } from "./notifier.js";
import { startApprovalBot } from "./purchase.js";
import { createServer } from "./server.js";
import { startScheduler } from "./scheduler.js";

const port = Number(process.env.PORT ?? "3000");

const app = createServer();
app.listen(port, () => {
  console.log(`Gotland ferry watch running at http://localhost:${port}`);
});

startScheduler();
// startApprovalBot reports its own failures, but a throw on the way there would otherwise
// be an unhandled rejection -- and auto-booking would be off with nothing said anywhere.
void startApprovalBot().catch((error) =>
  report("error", `**Godkännandeboten startade inte**\n${error instanceof Error ? error.message : String(error)}`, {
    repeatAfterMinutes: 0,
  })
);
