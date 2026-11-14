import { config } from "./config.ts";
import { createApp, createDeps } from "./app.ts";

const deps = createDeps(config);
const app = createApp(deps);
app.listen(config.port, () => {
  console.log(`burrow api on http://localhost:${config.port}`);
  console.log(`  db: ${config.db}`);
  console.log(
    `  homebox: ${deps.homebox.configured ? config.homebox.url : "off"} (write ${config.homebox.write ? "on" : "off"})`,
  );
  console.log(`  paperless: ${deps.paperless.mode}`);
  console.log(
    `  ai: ollama ${deps.ollama.configured ? "on" : "off"}, anthropic ${deps.anthropic.configured ? "on" : "off"}`,
  );
});
