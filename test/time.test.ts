import { describe, expect, it } from 'vitest';
import { TBILISI_OFFSET_MIN, TIMEZONE, dayRangeUtc, floorToSlot, formatSlot, isDate, nextSlot, parseSlotMinute, slotRangeUtc, tbilisiDate } from '../src/time';

describe('time', () => {
  it('fixed UTC+4 offset agrees with Intl for Asia/Tbilisi all year', () => {
    for (const iso of ['2026-01-15T12:00:00Z', '2026-04-01T12:00:00Z', '2026-07-15T12:00:00Z', '2026-10-30T12:00:00Z', '2027-03-28T12:00:00Z']) {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
      const h = Number(parts.find((p) => p.type === 'hour')?.value);
      expect(h).toBe((12 + TBILISI_OFFSET_MIN / 60) % 24);
    }
  });

  it('floors to the 5-minute cron slot', () => {
    const t = Date.parse('2026-10-03T13:17:42Z');
    expect(new Date(floorToSlot(t)).toISOString()).toBe('2026-10-03T13:15:00.000Z');
    expect(new Date(nextSlot(t)).toISOString()).toBe('2026-10-03T13:20:00.000Z');
  });

  it('derives the Tbilisi calendar date across midnight', () => {
    expect(tbilisiDate(Date.parse('2026-10-03T19:59:59Z'))).toBe('2026-10-03');
    expect(tbilisiDate(Date.parse('2026-10-03T20:00:00Z'))).toBe('2026-10-04');
  });

  it('parses HH:MM and snaps down to a 5-minute slot', () => {
    expect(parseSlotMinute('17:15')).toBe(17 * 60 + 15);
    expect(parseSlotMinute('17:19')).toBe(17 * 60 + 15);
    expect(parseSlotMinute('00:00')).toBe(0);
    expect(parseSlotMinute('23:59')).toBe(23 * 60 + 55);
    for (const bad of ['', '24:00', '9:30', '12:60', 'ab:cd', '12:3']) expect(parseSlotMinute(bad)).toBeNull();
  });

  it('converts a Tbilisi slot to a UTC half-open range', () => {
    expect(slotRangeUtc('2026-10-03', 17 * 60 + 15)).toEqual({ start: '2026-10-03T13:15:00.000Z', end: '2026-10-03T13:20:00.000Z' });
    // 01:30 Tbilisi is the previous UTC day
    expect(slotRangeUtc('2026-10-03', 90)).toEqual({ start: '2026-10-02T21:30:00.000Z', end: '2026-10-02T21:35:00.000Z' });
  });

  it('covers a whole Tbilisi day', () => {
    expect(dayRangeUtc('2026-10-03')).toEqual({ start: '2026-10-02T20:00:00.000Z', end: '2026-10-03T20:00:00.000Z' });
  });

  it('validates dates and formats slots', () => {
    expect(isDate('2026-10-03')).toBe(true);
    expect(isDate('2026-13-01')).toBe(false);
    expect(isDate('2026-1-1')).toBe(false);
    expect(formatSlot(9 * 60 + 30)).toBe('09:30');
  });
});
