import type { Env } from "./env";
import {
  shopifyOrders,
  triplewhaleMetrics,
  dbRead,
  shopifyTagOrder,
} from "./connectors";

export interface ToolDef {
  name: string;
  description: string;
  write: boolean; // write tools require the caller's allowWrite scope
  inputSchema: Record<string, unknown>;
  run: (env: Env, args: Record<string, unknown>) => Promise<unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "shopify_orders",
    description:
      "Read recent Shopify orders (id, total, status, date). Read-only.",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "max orders (1-50)", default: 10 },
      },
    },
    run: (env, args) => shopifyOrders(env, clampInt(args.limit, 10, 1, 50)),
  },
  {
    name: "triplewhale_metrics",
    description:
      "Read blended ROAS, CAC, revenue and spend for the last 7 days. Read-only.",
    write: false,
    inputSchema: { type: "object", properties: {} },
    run: (env) => triplewhaleMetrics(env),
  },
  {
    name: "db_query",
    description:
      "Read rows from an allowlisted Postgres table (posts, agents, tc_runs, tc_suites). Read-only.",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "table name (allowlisted)" },
        limit: { type: "number", description: "max rows (1-50)", default: 10 },
      },
      required: ["table"],
    },
    run: (env, args) =>
      dbRead(env, String(args.table ?? ""), clampInt(args.limit, 10, 1, 50)),
  },
  {
    name: "shopify_tag_order",
    description:
      "Add tags to a Shopify order. WRITE action, requires the client's write scope.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "number", description: "Shopify order id" },
        tags: { type: "string", description: "comma-separated tags" },
      },
      required: ["orderId", "tags"],
    },
    run: (env, args) =>
      shopifyTagOrder(env, Number(args.orderId), String(args.tags ?? "")),
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}
