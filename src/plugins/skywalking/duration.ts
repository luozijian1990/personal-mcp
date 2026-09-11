export interface TimeInfo { timezone: string; currentTimestamp: number }

/** OAP Duration uses wall-clock strings in the server timezone. */
export function buildDuration(start: string, end: string, info: TimeInfo) {
  const offset = /^([+-])(\d{2})(\d{2})$/.exec(info.timezone);
  if (!offset || Number(offset[2]) > 23 || Number(offset[3]) > 59 || !Number.isFinite(info.currentTimestamp)) {
    throw new Error("Invalid SkyWalking server time information");
  }
  const offsetMs = (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000;
  const parse = (value: string) => {
    if (value === "now") return info.currentTimestamp;
    const relative = /^now-(\d+)([smhd])$/.exec(value);
    if (relative) return info.currentTimestamp - Number(relative[1]) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]!]!);
    const absolute = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!absolute) {
      throw new Error("Time must be now, now-<number>s/m/h/d, or ISO 8601 with timezone");
    }
    const year = Number(absolute[1]), month = Number(absolute[2]), day = Number(absolute[3]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (daysInMonth === undefined || day < 1 || day > daysInMonth ||
        Number(absolute[4]) > 23 || Number(absolute[5]) > 59 || Number(absolute[6]) > 59) {
      throw new Error("Invalid time: calendar date or clock field is out of range");
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new Error("Invalid time");
    return timestamp;
  };
  const from = parse(start), to = parse(end);
  if (from > to) throw new Error("start must not be after end");
  const format = (value: number) => new Date(value + offsetMs).toISOString().slice(0, 16).replace("T", " ").replace(":", "");
  return { start: format(from), end: format(to), step: "MINUTE" as const };
}
