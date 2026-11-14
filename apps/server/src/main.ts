import { config } from "./config.ts";
import { createApp, createDeps } from "./app.ts";

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
