import { createHash } from "node:crypto";
import { encode } from "../util.js";
/** Format v1: JSON integer-index order, other keys in UTF-16 order; arrays retained. */
export function portableCanonical(
  value: unknown,
  limit = 8 * 1024 * 1024,
): string {
  const copy: unknown = JSON.parse(encode(value, limit));
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(copy));
}
export const portableHash = (value: unknown): string =>
  createHash("sha256").update(portableCanonical(value)).digest("hex");
