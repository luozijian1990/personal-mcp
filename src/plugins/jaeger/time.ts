import { z } from "zod/v4";
const iso = z.iso.datetime({ offset: true, precision: 3 }).or(z.iso.datetime({ offset: true, precision: 0 }));
export function queryRange(start: string, end: string, now = Date.now()) {
  const parse = (input: string) => {
    let ms: number;
    const relative = /^now-(\d+)(s|m|h|d)$/.exec(input);
    if (input === "now") ms = now;
    else if (relative) ms = now - Number(relative[1]) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]!]!);
    else { if (!iso.safeParse(input).success) throw new Error("Time must be now, now-<integer>s/m/h/d or ISO 8601 with timezone and seconds (optional 3-digit milliseconds)"); ms = Date.parse(input); }
    if (ms < 0 || !Number.isSafeInteger(ms * 1000)) throw new Error("Time is outside the supported epoch range");
    return ms * 1000;
  };
  const a = parse(start), b = parse(end);
  if (a > b) throw new Error("start must not be later than end");
  return { start: String(a), end: String(b) };
}
