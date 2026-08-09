// Not deployed as its own function — Supabase's CLI/platform excludes any `_`-prefixed folder
// under supabase/functions/ from deployment, so this is safe to import via a relative path from
// any function's index.ts (e.g. `import { timingSafeEqualString } from "../_shared/timingSafeEqual.ts"`).
//
// Every internal-dispatch function in this codebase compares a request header against a shared
// secret (INTERNAL_DISPATCH_KEY or LAMBDA_INBOUND_KEY) using plain string `!==`, which short-circuits
// on the first differing byte — a network-observable timing side channel that could, in principle,
// let an attacker guess the secret byte-by-byte. This constant-time comparison always walks the
// full length of both inputs before returning, regardless of where they first differ.
export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // A length mismatch is itself a difference, but comparing it away immediately would reintroduce
  // a timing signal — walk a same-length dummy pass first so the function's running time doesn't
  // depend on whether the lengths matched.
  if (aBytes.length !== bBytes.length) {
    const dummy = new Uint8Array(aBytes.length);
    let diff = 0;
    for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ dummy[i];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}
