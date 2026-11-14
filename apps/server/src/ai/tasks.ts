import type { Store } from "@burrow/core";
import { z } from "zod";
import type { AiTask } from "./gateway.ts";
import type { PagePreview } from "../link-preview.ts";

// ------------------------------------------------------------ suggest-thing

export const SuggestThingInput = z.object({
  name: z.string().min(1).max(500),
  url: z.string().optional(),
  page: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      siteName: z.string().optional(),
      price: z.string().optional(),
      brand: z.string().optional(),
    })
    .optional(),
  notes: z.string().max(2000).optional(),
});
export type SuggestThingInput = z.infer<typeof SuggestThingInput>;

export const ThingSuggestion = z.object({
  name: z.string().describe("Clean, specific name a person would search for"),
  kind: z.string().describe("One of the kind ids given"),
  description: z.string().describe("One or two plain sentences: what it is and what it is for"),
  tags: z.array(z.string()).describe("3-6 lowercase tags, reuse existing tags when they fit"),
  maker: z.string().nullable(),
  model: z.string().nullable(),
  quantity: z.number().nullable().describe("Only if the input states a count"),
  placeId: z.string().nullable().describe("Id of the most likely place from the list, or null"),
  question: z
    .object({ text: z.string(), options: z.array(z.string()) })
    .nullable()
    .describe("At most one quick multiple-choice question when something important is ambiguous"),
});
export type ThingSuggestion = z.infer<typeof ThingSuggestion>;

export function suggestThingTask(store: Store): AiTask<SuggestThingInput, ThingSuggestion> {
  return {
    id: "suggest-thing",
    confidential: false,
    schema: ThingSuggestion,
    maxTokens: 3000,
    expectedOutputTokens: 450,
    build(raw) {
      const input = SuggestThingInput.parse(raw);
      const kinds = store
        .kinds()
        .map((k) => `${k.id} (${k.name}${k.isPlace ? ", a place" : ""})`)
        .join(", ");
      const places = store
        .places()
        .slice(0, 120)
        .map((p) => `${p.id}: ${p.path}`)
        .join("\n");
      const tags = topTags(store, 60).join(", ");
      const system = [
        "You help catalogue things in a home inventory. Given what a person typed (and maybe a product page summary), fill in the details.",
        "Be concrete and conservative: leave maker/model null unless they are stated or obvious from the name.",
        "Never invent serial numbers or prices.",
        `Kinds: ${kinds}.`,
        `Existing tags: ${tags || "(none yet)"}.`,
        `Places (id: path):\n${places || "(none yet)"}`,
      ].join("\n\n");
      const user = [
        `Typed: ${input.name}`,
        input.url ? `Link: ${input.url}` : "",
        input.page ? `Page: ${JSON.stringify(input.page)}` : "",
        input.notes ? `Notes: ${input.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { system, user };
    },
  };
}

export function pageToInput(
  name: string,
  url: string | undefined,
  page: PagePreview | null,
): SuggestThingInput {
  return {
    name,
    ...(url ? { url } : {}),
    ...(page
      ? {
          page: {
            ...(page.title ? { title: page.title } : {}),
            ...(page.description ? { description: page.description.slice(0, 600) } : {}),
            ...(page.siteName ? { siteName: page.siteName } : {}),
            ...(page.price ? { price: page.price } : {}),
            ...(page.brand ? { brand: page.brand } : {}),
          },
        }
      : {}),
  };
}

export function topTags(store: Store, n: number): string[] {
  const rows = store.db
    .prepare(
      `select value tag, count(*) n from things, json_each(things.data, '$.tags')
       where archived_at is null group by value order by n desc limit ?`,
    )
    .all(n) as { tag: string }[];
  return rows.map((r) => r.tag);
}
