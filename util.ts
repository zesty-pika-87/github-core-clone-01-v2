// Small shared helpers: hashing, fixed trial timestamps, global ids, and the
// request-id counter. Everything here is deterministic: no wall-clock reads
// outside MAKEFUN_TRIAL_NOW, no randomness, so replayed trials produce the
// same exported state byte for byte.

import { createHash } from "node:crypto";

export const ZERO_OID = "0000000000000000000000000000000000000000";
export const DEFAULT_BRANCH = "main";
export const GIT_PROTOCOL_VERSION = "2";

// The viewer is fixed by the trial scenario (the kit builds the scenario from
// a constant seed, so the same login is the owner in every trial). The token
// only proves identity; it never encodes the login.
export const VIEWER = {
  login: "adaiversen",
  id: 1000,
  name: "ada iversen",
  email: "adaiversen@example.invalid",
} as const;

const FALLBACK_EPOCH = 1700000000;

export function trialEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return FALLBACK_EPOCH;
}

export function trialNowIso(): string {
  return new Date(trialEpochSec() * 1000).toISOString();
}

export function sha1Hex(data: Buffer | string): string {
  return createHash("sha1").update(data).digest("hex");
}

export function sha1Raw(data: Buffer): Buffer {
  return createHash("sha1").update(data).digest();
}

export function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req_${requestCounter.toString(16)}`;
}

export function isSha40(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}
