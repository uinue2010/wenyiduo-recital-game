import "dotenv/config";
import { resolve } from "node:path";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? "../../data");
const geminiApiKey = process.env.GEMINI_API_KEY;
const liveModel =
  process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-preview-12-2025";
const scoreModel = process.env.GEMINI_SCORE_MODEL ?? "gemini-2.5-flash";

const app = createApp({
  port,
  webOrigin,
  dataDir,
  geminiApiKey,
  liveModel,
  scoreModel
});

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`Server listening on http://localhost:${port}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
