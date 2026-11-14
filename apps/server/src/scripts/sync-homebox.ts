import { Store } from "@burrow/core";
import { config } from "../config.ts";
import { aiMigrations } from "../ai/gateway.ts";
import { HomeBox, syncFromHomeBox } from "../adapters/homebox.ts";

const store = Store.open(config.db, aiMigrations);
const report = await syncFromHomeBox(store, new HomeBox(config.homebox.url, config.homebox.token));
console.log(report);
