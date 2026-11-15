import { AsyncLocalStorage } from "node:async_hooks";

// Who the current request (or Telegram update) acts as (D-032). Store writes that don't name an
// actor pick it up through `Store.currentActor`, so every route is attributed without threading
// the account through each call.
const current = new AsyncLocalStorage<{ actor: string }>();

export const runAs = <T>(actor: string, fn: () => T): T => current.run({ actor }, fn);

/** The actor of the running request; "you" outside one (scripts, tests, auth turned off). */
export const currentActor = (): string => current.getStore()?.actor ?? "you";
