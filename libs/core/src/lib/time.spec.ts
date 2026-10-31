import {
  addDays,
  dayKeyOf,
  formatDuration,
  formatStamp,
  parseDuration,
  parseStamp,
  splitByDay,
  startOfDay,
  weekdayOf,
} from './time';

const ROME = 'Europe/Rome';
const HOUR = 3600_000;

describe('wall time', () => {
  it('round-trips stamps in a timezone', () => {
    const moment = parseStamp('2026-10-29 09:37:58', ROME) as number;
    expect(new Date(moment).toISOString()).toBe('2026-10-29T08:37:58.000Z');
    expect(formatStamp(moment, ROME)).toBe('2026-10-29 09:37:58');
    expect(formatStamp(moment, 'UTC')).toBe('2026-10-29 08:37:58');
  });

  it('accepts minutes without seconds and rejects invalid dates', () => {
    expect(formatStamp(parseStamp('2026-01-05 7:05', ROME) as number, ROME)).toBe('2026-01-05 07:05:00');
    expect(parseStamp('2026-02-30 10:00:00', ROME)).toBeNull();
    expect(parseStamp('yesterday', ROME)).toBeNull();
  });

  it('resolves times skipped by DST to after the jump', () => {
    // 2026-03-29 02:30 does not exist in Rome (02:00 -> 03:00)
    expect(formatStamp(parseStamp('2026-03-29 02:30:00', ROME) as number, ROME)).toBe('2026-03-29 03:30:00');
  });

  it('resolves repeated times to the first occurrence', () => {
    // 2026-10-25 02:30 happens twice in Rome
    const moment = parseStamp('2026-10-25 02:30:00', ROME) as number;
    expect(new Date(moment).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('finds the start of days that skip midnight', () => {
    // Santiago skipped 2024-09-08 00:00 -> 01:00
    expect(formatStamp(startOfDay('2024-09-08', 'America/Santiago'), 'America/Santiago')).toBe('2024-09-08 01:00:00');
  });
});

describe('days', () => {
  it('does calendar arithmetic', () => {
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(weekdayOf('2026-10-26')).toBe(0); // Monday
    expect(weekdayOf('2026-11-01')).toBe(6); // Sunday
  });

  it('splits sessions on local midnights', () => {
    const start = parseStamp('2026-10-28 22:00:00', ROME) as number;
    const end = parseStamp('2026-10-29 01:30:00', ROME) as number;
    expect([...splitByDay(start, end, ROME)]).toEqual([
      ['2026-10-28', 2 * HOUR],
      ['2026-10-29', 1.5 * HOUR],
    ]);
  });

  it('measures DST days with their real length', () => {
    const start = startOfDay('2026-10-25', ROME);
    const end = startOfDay('2026-10-26', ROME);
    expect(splitByDay(start, end, ROME).get('2026-10-25')).toBe(25 * HOUR);
    const springStart = startOfDay('2026-03-29', ROME);
    expect(splitByDay(springStart, springStart + 30 * HOUR, ROME).get('2026-03-29')).toBe(23 * HOUR);
  });

  it('uses the timezone for the day of a moment', () => {
    const moment = Date.UTC(2026, 9, 28, 23, 30);
    expect(dayKeyOf(moment, 'UTC')).toBe('2026-10-28');
    expect(dayKeyOf(moment, ROME)).toBe('2026-10-29');
  });
});

describe('durations', () => {
  it('formats and parses', () => {
    expect(formatDuration(140)).toBe('2h 20m');
    expect(formatDuration(0.5)).toBe('30s');
    expect(formatDuration(0)).toBe('0m');
    expect(parseDuration('2h 20m')).toBe(140);
    expect(parseDuration('2h20m')).toBe(140);
    expect(parseDuration('1.5h')).toBe(90);
    expect(parseDuration('30s')).toBe(0.5);
    expect(parseDuration('two hours')).toBeNull();
    expect(parseDuration(formatDuration(37.25))).toBe(37.25);
  });
});
