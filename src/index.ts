import type { Env, Caller } from "./env";
import { resolveCaller } from "./auth";
import { audit } from "./audit";
import { TOOLS, findTool } from "./tools";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "bridgekit", version: "0.1.0" };

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Health / landing.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return json({
        server: SERVER_INFO,
        protocol: PROTOCOL_VERSION,
        transport: "Streamable HTTP (POST JSON-RPC to /mcp)",
        tools: TOOLS.map((t) => ({ name: t.name, write: t.write })),
      });
    }

    if (req.method !== "POST") {
      return json({ error: "POST JSON-RPC to /mcp" }, 405);
    }

    // Every call must present a known client key.
    const caller = resolveCaller(req, env);
    if (!caller) {
      return json(
        rpcError(null, -32001, "unauthorized: missing or unknown client key"),
        401,
      );
    }

    let body: RpcRequest;
    try {
      body = (await req.json()) as RpcRequest;
    } catch {
      return json(rpcError(null, -32700, "parse error"));
    }

    const result = await handle(body, env, caller);
    // Notifications (no id) get a 202 with no body per JSON-RPC.
    if (result === undefined) return new Response(null, { status: 202 });
    return json(result);
  },
};

async function handle(
  req: RpcRequest,
  env: Env,
  caller: Caller,
): Promise<object | undefined> {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
      return undefined; // notification, no response

    case "ping":
      return rpcOk(id, {});

    case "tools/list": {
      // Only advertise tools this client is scoped for.
      const visible = TOOLS.filter(
        (t) =>
          caller.config.tools.includes(t.name) &&
          (!t.write || caller.config.allowWrite),
      ).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return rpcOk(id, { tools: visible });
    }

    case "tools/call": {
      const name = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const tool = findTool(name);

      if (!tool) {
        await audit(env, caller, {
          tool: name,
          decision: "denied",
          reason: "unknown tool",
        });
        return rpcOk(id, toolError(`unknown tool: ${name}`));
      }
      if (!caller.config.tools.includes(name)) {
        await audit(env, caller, {
          tool: name,
          decision: "denied",
          reason: "not in client scope",
        });
        return rpcOk(id, toolError(`tool "${name}" not allowed for this client`));
      }
      if (tool.write && !caller.config.allowWrite) {
        await audit(env, caller, {
          tool: name,
          decision: "denied",
          reason: "write scope required",
          args,
        });
        return rpcOk(
          id,
          toolError(`tool "${name}" is a write action; client lacks write scope`),
        );
      }

      try {
        const out = await tool.run(env, args);
        await audit(env, caller, { tool: name, decision: "allowed", args });
        return rpcOk(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        });
      } catch (e) {
        await audit(env, caller, {
          tool: name,
          decision: "allowed",
          reason: `error: ${(e as Error).message}`,
          args,
        });
        return rpcOk(id, toolError((e as Error).message));
      }
    }

    default:
      return rpcError(id ?? null, -32601, `method not found: ${method}`);
  }
}

// --- JSON-RPC helpers ---

function rpcOk(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// MCP convention: tool-level failures come back as an isError result, not a
// transport error, so the model can read and react to them.
function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
