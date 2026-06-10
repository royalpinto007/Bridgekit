import type { Env } from "./env";

// Connectors call the real upstream API when credentials are configured, and
// otherwise return clearly-labelled sample data so the server is demoable and
// testable without live store credentials.

export async function shopifyOrders(
  env: Env,
  limit: number,
): Promise<unknown> {
  if (env.SHOPIFY_STORE && env.SHOPIFY_ADMIN_TOKEN) {
    const url = `https://${env.SHOPIFY_STORE}/admin/api/2024-07/orders.json?status=any&limit=${limit}`;
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN },
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    return await res.json();
  }
  return {
    _sample: true,
    orders: Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
      id: 1000 + i,
      name: `#${1000 + i}`,
      total_price: (49.99 + i * 10).toFixed(2),
      financial_status: "paid",
      created_at: "2026-06-01T10:00:00Z",
    })),
  };
}

export async function triplewhaleMetrics(env: Env): Promise<unknown> {
  if (env.TRIPLEWHALE_API_KEY) {
    const res = await fetch("https://api.triplewhale.com/api/v2/summary-page", {
      headers: { "x-api-key": env.TRIPLEWHALE_API_KEY },
    });
    if (!res.ok) throw new Error(`Triple Whale ${res.status}`);
    return await res.json();
  }
  return {
    _sample: true,
    period: "last_7_days",
    blended_roas: 2.41,
    cac: 38.2,
    revenue: 184230,
    spend: 76450,
  };
}

// Read-only SQL against Supabase via PostgREST is not arbitrary SQL; instead we
// expose a guarded table read. Only SELECT-shaped reads are possible here.
export async function dbRead(
  env: Env,
  table: string,
  limit: number,
): Promise<unknown> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("db_query not configured");
  }
  // Allowlist of readable tables keeps this from becoming a data-exfil hole.
  const allowed = new Set(["posts", "agents", "tc_runs", "tc_suites"]);
  if (!allowed.has(table)) {
    throw new Error(`table "${table}" is not readable`);
  }
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?select=*&limit=${Math.min(limit, 50)}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!res.ok) throw new Error(`db read ${res.status}`);
  return await res.json();
}

// Write tool (gated by allowWrite). Tags an order in Shopify. Without creds it
// is a dry run that echoes what it would do.
export async function shopifyTagOrder(
  env: Env,
  orderId: number,
  tags: string,
): Promise<unknown> {
  if (env.SHOPIFY_STORE && env.SHOPIFY_ADMIN_TOKEN) {
    const url = `https://${env.SHOPIFY_STORE}/admin/api/2024-07/orders/${orderId}.json`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ order: { id: orderId, tags } }),
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    return await res.json();
  }
  return { _dryRun: true, orderId, tags, note: "no Shopify creds set" };
}
