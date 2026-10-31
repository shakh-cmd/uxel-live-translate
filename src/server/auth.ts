import { timingSafeEqual } from "node:crypto";

export function pinMatches(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function pinFrom(header: string | undefined): string {
  if (!header) return "";
  return header.startsWith("Bearer ") ? header.slice(7) : header;
}
