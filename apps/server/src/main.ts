import { config } from "./config.ts";
import { createApp, createDeps } from "./app.ts";
import { TelegramApi } from "./telegram/api.ts";
import { startTelegramBot } from "./telegram/bot.ts";

const deps = createDeps(config);
const app = createApp(deps);
app.listen(config.port, () => {
  console.log(`burrow api on http://localhost:${config.port}`);
  console.log(`  db: ${config.db}`);
  console.log(`  media: ${config.mediaDir}`);
  console.log(`  paperless: ${deps.paperless.mode}`);
  console.log(
    `  ai: lmstudio ${deps.lmstudio.configured ? "on" : "off"}, ollama ${deps.ollama.configured ? "on" : "off"}, anthropic ${deps.anthropic.configured ? "on" : "off"}`,
  );
});

const tg = config.telegram;
if (tg.enabled) {
  startTelegramBot(deps, new TelegramApi(tg.token));
  console.log(
    `  telegram: on (linked accounts${tg.chats.length ? ` + ${tg.chats.length} chat(s) from env` : ""})`,
  );
}
