import "dotenv/config";
import { createServer } from "./server.js";
import { startScheduler } from "./scheduler.js";

const port = Number(process.env.PORT ?? "3000");

const app = createServer();
app.listen(port, () => {
  console.log(`Gotland ferry watch running at http://localhost:${port}`);
});

startScheduler();
