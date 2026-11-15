// Telling "the connection is down" apart from real errors. After the computer wakes up, the
// network takes a few seconds to come back: requests made then fail, and that's not worth a banner.

/** A request that never reached the server: offline, DNS not ready, connection reset… */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  // fetch() rejects with a TypeError ("Failed to fetch", "NetworkError when…", "Load failed").
  if (e instanceof TypeError) return true;
  // The desktop app refreshes Google tokens in Rust; its errors arrive as strings.
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /failed to fetch|network|error sending request|connection|dns|timed? ?out|offline|unreachable/i.test(message);
}
