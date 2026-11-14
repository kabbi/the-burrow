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
        .filter((k) => !store.kindIs(k.id, "tag") && !store.kindIs(k.id, "document"))
        .map((k) => `${k.id} (${k.name}${k.isPlace ? ", a place" : ""})`)
        .join(", ");
      const places = store
        .places()
        .slice(0, 120)
        .map((p) => `${p.id}: ${p.path}`)
        .join("\n");
      const tags = topTags(store, 60).join(", ");
      const system = [
        "You catalogue things for a home inventory. A person typed a short name (maybe with a product page summary). Return details that make the thing easy to find and recognise later.",
        "Rules:",
        "- name: a clear, specific name; fix capitalisation; keep the person's wording when it is already good.",
        "- kind: exactly one id from the kinds list (the part before the parentheses).",
        "- description: 1-2 sentences that add information beyond the name: what it is, what it is used for, notable traits. Never just repeat the name.",
        "- tags: 3-6 short lowercase tags; reuse existing tags when they fit.",
        "- maker / model: only when stated or unambiguous from the name, else null. Never invent serial numbers or prices.",
        "- quantity: only when the input states a count, else null.",
        "- placeId: an id from the places list only if the name clearly implies where it lives (e.g. a dishwasher → kitchen), else null.",
        "- question: null unless one multiple-choice question would remove an important ambiguity.",
        'Example: typed "hot glue gun" → {"name":"Hot glue gun","kind":"tool","description":"Electric tool that melts glue sticks for quick bonding of plastic, wood, fabric and craft materials.","tags":["glue","crafts","workshop"],"maker":null,"model":null,"quantity":null,"placeId":null,"question":null}',
        `Kinds: ${kinds}.`,
        `Existing tags: ${tags || "(none yet)"}.`,
        `Places (id: path):\n${places || "(none yet)"}`,
      ].join("\n");
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
      `select t.name tag, count(*) n from edges e join things t on t.id = e.to_id
       where e.type = 'tagged' and t.archived_at is null group by t.id order by n desc limit ?`,
    )
    .all(n) as { tag: string }[];
  return rows.map((r) => r.tag);
}

// ------------------------------------------------------------ photo-thing (Telegram, D-019)

export const PhotoThingInput = z.object({
  /** Media file names of the photos (1-3 are sent). */
  images: z
    .array(z.string().regex(/^[\w.-]+$/))
    .min(1)
    .max(3),
  caption: z.string().max(1000).optional(),
});
export type PhotoThingInput = z.infer<typeof PhotoThingInput>;

export const PhotoSuggestion = ThingSuggestion.omit({ question: true }).extend({
  lookFor: z
    .array(z.string())
    .describe(
      "4-8 search words or short phrases to find this thing in the inventory: generic nouns, synonyms, brand, model, text printed on it",
    ),
});
export type PhotoSuggestion = z.infer<typeof PhotoSuggestion>;

export function photoThingTask(store: Store): AiTask<PhotoThingInput, PhotoSuggestion> {
  const text = suggestThingTask(store);
  return {
    id: "photo-thing",
    confidential: false,
    schema: PhotoSuggestion,
    maxTokens: 3000,
    expectedOutputTokens: 500,
    async build(raw) {
      const input = PhotoThingInput.parse(raw);
      // Same catalogue rules and lists as typed names, with the photo as the input.
      const base = await text.build({ name: input.caption?.trim() || "(see photo)" });
      const system = [
        base.system
          .replace(
            "A person typed a short name (maybe with a product page summary).",
            "A person took a photo of one thing (sometimes with a short caption).",
          )
          .replace(/\n- question:[^\n]*/, ""),
        "- Name what is in the photo, using text printed on it (brand, model) when readable. If several objects are shown, catalogue the main one in focus.",
        "- lookFor: words that would find this same thing if it is already catalogued: the generic noun and synonyms, brand, model, printed text. Lowercase.",
      ].join("\n");
      const user = [
        input.images.length > 1
          ? `${input.images.length} photos of the same thing.`
          : "A photo of the thing.",
        input.caption?.trim() ? `Caption: ${input.caption.trim()}` : "No caption.",
      ].join("\n");
      // Thinking makes gemma-4 take 30-60 s on a photo instead of ~8 (2026-11-14); a name is enough here.
      return { system, user, images: input.images, noThinking: true };
    },
  };
}
