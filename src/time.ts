// All stored timestamps are UTC ISO-8601 strings produced by Date#toISOString(), so
// they sort lexicographically. Asia/Tbilisi is only used to interpret user input
// (date / 5-minute slot) and, on the client, to display times.
//
// Georgia has used a fixed UTC+4 offset with no DST since 2005. test/time.test.ts
// checks this constant against Intl so a future tzdata change fails loudly.

export const TIMEZONE = 'Asia/Tbilisi';
export const TBILISI_OFFSET_MIN = 240;
export const SLOT_MS = 5 * 60_000;

export const nowIso = (t: number = Date.now()): string => new Date(t).toISOString();

/** Start of the 5-minute cron slot containing t (cron fires on UTC minutes divisible by 5). */
export const floorToSlot = (t: number): number => Math.floor(t / SLOT_MS) * SLOT_MS;
export const nextSlot = (t: number): number => floorToSlot(t) + SLOT_MS;

/** YYYY-MM-DD of instant t as seen in Tbilisi. */
export function tbilisiDate(t: number = Date.now()): string {
  return new Date(t + TBILISI_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** "HH:MM" -> minutes since local midnight, or null if malformed. Snaps down to the 5-minute slot. */
export function parseSlotMinute(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins - (mins % 5);
}

/** UTC instants [start, end) for a Tbilisi date + slot. end is exclusive. */
export function slotRangeUtc(date: string, slotMinute: number): { start: string; end: string } {
  const base = Date.parse(`${date}T00:00:00Z`) - TBILISI_OFFSET_MIN * 60_000;
  const start = base + slotMinute * 60_000;
  return { start: nowIso(start), end: nowIso(start + SLOT_MS) };
}

/** UTC instants [start, end) covering one whole Tbilisi calendar day. */
export function dayRangeUtc(date: string): { start: string; end: string } {
  const start = Date.parse(`${date}T00:00:00Z`) - TBILISI_OFFSET_MIN * 60_000;
  return { start: nowIso(start), end: nowIso(start + 86_400_000) };
}

export function formatSlot(slotMinute: number): string {
  const h = String(Math.floor(slotMinute / 60)).padStart(2, '0');
  const m = String(slotMinute % 60).padStart(2, '0');
  return `${h}:${m}`;
}
