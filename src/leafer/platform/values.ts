/** Narrowing helpers for the untyped values Leafer records and NSH returns. */

export type PathRule = "nonzero" | "evenodd";

export interface RecordLike {
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

/** A positive finite size, or `null` for anything else. */
export function dimension(value: unknown): number | null {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? size : null;
}

/** Reads a numeric argument, tolerating values recorded as strings. */
export function numberArg(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export function ruleArg(value: unknown): PathRule | undefined {
  return value === "nonzero" || value === "evenodd" ? value : undefined;
}
