import type { ThingId } from "./types.ts";

// D-003: ids are "B-" + a zero-padded sequence number. Short enough to read
// aloud, print on a 12 mm label and fit any RFID EPC; padding grows past 9999.
const RE = /^\s*(?:b\s*-?\s*)?0*(\d{1,9})\s*$/i;

export function formatId(seq: number): ThingId {
  return `B-${String(seq).padStart(4, "0")}`;
}

/** Accepts "B-0042", "b42", "0042", "42". Returns the sequence number or null. */
export function parseId(input: string): number | null {
  const m = RE.exec(input);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}
