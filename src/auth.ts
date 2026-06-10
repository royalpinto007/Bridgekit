import type { Caller, ClientConfig, Env } from "./env";

// Resolve the caller from the request's bearer token / x-bridgekit-key header.
// Returns null when the key is missing or unknown.
export function resolveCaller(req: Request, env: Env): Caller | null {
  const key =
    req.headers.get("x-bridgekit-key") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!key) return null;

  let clients: Record<string, ClientConfig> = {};
  try {
    clients = JSON.parse(env.BRIDGEKIT_CLIENTS ?? "{}");
  } catch {
    return null;
  }

  const config = clients[key];
  if (!config) return null;
  return { key, config };
}

// A short, non-reversible label for a key, safe to put in logs.
export function keyLabel(key: string): string {
  return key.length > 10 ? `${key.slice(0, 8)}…${key.slice(-2)}` : "key";
}
