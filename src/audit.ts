import type { Caller, Env } from "./env";
import { keyLabel } from "./auth";

// Append-only audit log. Every tool call (allowed or denied) is recorded to the
// bk_audit table in the shared Supabase project via PostgREST. Failures to log
// are swallowed so they never block the actual tool response, but are surfaced
// in the Worker logs.
export async function audit(
  env: Env,
  caller: Caller | null,
  entry: {
    tool: string;
    decision: "allowed" | "denied";
    reason?: string;
    args?: unknown;
  },
): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/bk_audit`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        client_name: caller?.config.name ?? null,
        key_label: caller ? keyLabel(caller.key) : null,
        tool: entry.tool,
        decision: entry.decision,
        reason: entry.reason ?? null,
        // Args are truncated; never log secrets and keep rows small.
        args: truncate(entry.args),
      }),
    });
  } catch (e) {
    console.error("[bridgekit] audit log failed:", (e as Error).message);
  }
}

function truncate(value: unknown): unknown {
  try {
    const s = JSON.stringify(value);
    if (!s) return null;
    return s.length > 2000 ? s.slice(0, 2000) + "…" : JSON.parse(s);
  } catch {
    return null;
  }
}
