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

    // Human-facing landing (HTML); machine info at /info.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return html(landingPage());
    }
    if (req.method === "GET" && url.pathname === "/info") {
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

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function landingPage(): string {
  const rows = TOOLS.map(
    (t) => `<tr>
      <td class="mono">${t.name}</td>
      <td>${t.write ? '<span class="badge write">write</span>' : '<span class="badge read">read</span>'}</td>
      <td class="muted">${t.description}</td>
    </tr>`,
  ).join("");
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bridgekit: scoped MCP server</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%236e8bff'/%3E%3Cpath d='M9 13h11l-3-3m6 9H12l3 3' stroke='%2308080a' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>${LANDING_CSS}</style></head>
<body><div class="glow"></div><main>
  <header>
    <div class="logo"><span class="mark">⇄</span> bridgekit</div>
    <span class="status"><i></i> live</span>
  </header>
  <span class="eyebrow">model context protocol</span>
  <h1>Give your AI your tools.<br>Not your API keys.</h1>
  <p class="lede">A scoped MCP server that exposes Shopify, Triple Whale, and your database to an AI stack with per-client permission boundaries, read/write separation, and an append-only audit log.</p>
  <div class="card">
    <div class="card-head">Exposed tools</div>
    <table><thead><tr><th>tool</th><th>type</th><th>description</th></tr></thead><tbody>${rows}</tbody></table>
  </div>
  <div class="card">
    <div class="card-head">Connect over Streamable HTTP</div>
    <pre>curl $URL/mcp \\
  -H "x-bridgekit-key: &lt;client-key&gt;" \\
  -H "content-type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</pre>
  </div>
  <footer>Per-key scopes · write actions gated · every call audited · <a href="/info">/info</a></footer>
</main></body></html>`;
}

const LANDING_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#08080a;color:#ededf2;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 70% 40% at 50% -8%,rgba(110,139,255,.16),transparent 60%),radial-gradient(ellipse 50% 30% at 90% 0,rgba(54,214,195,.09),transparent 55%)}
main{position:relative;max-width:760px;margin:0 auto;padding:32px 22px 60px;z-index:1}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:48px}
.logo{display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,#6e8bff,#36d6c3);color:#08080a;font-weight:800}
.status{display:inline-flex;align-items:center;gap:7px;border:1px solid #26262e;background:#111114;border-radius:999px;padding:5px 11px;font-size:11px;color:#8b8b96}
.status i{width:7px;height:7px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950}
.eyebrow{display:inline-block;border:1px solid #26262e;background:#111114;border-radius:999px;padding:4px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#8b8b96}
h1{font-size:38px;line-height:1.1;letter-spacing:-.02em;margin:16px 0 14px;font-weight:650}
.lede{color:#8b8b96;max-width:560px;font-size:16px}
.card{border:1px solid #26262e;background:#111114;border-radius:18px;padding:18px;margin-top:26px;box-shadow:0 8px 24px -12px rgba(0,0,0,.6)}
.card-head{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#8b8b96;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:500;color:#8b8b96;font-size:11px;text-transform:uppercase;letter-spacing:.08em;padding:0 0 8px}
td{padding:9px 12px 9px 0;border-top:1px solid #1d1d23;vertical-align:top}
.mono{font-family:ui-monospace,Menlo,monospace;color:#ededf2}
.muted{color:#8b8b96}
.badge{font-size:11px;padding:2px 8px;border-radius:6px;font-weight:600}
.badge.read{background:rgba(54,214,195,.14);color:#36d6c3}
.badge.write{background:rgba(227,160,8,.14);color:#e3a008}
pre{background:#08080a;border-radius:12px;padding:14px;overflow-x:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:#8b8b96;line-height:1.6}
footer{margin-top:34px;color:#8b8b96;font-size:12.5px}
a{color:#6e8bff;text-decoration:none}
@media (prefers-color-scheme: light){
  body{background:#fafafc;color:#12141b}
  .status,.eyebrow,.card{background:#fff;border-color:#e2e4e9}
  .status,.eyebrow,.muted,.lede,footer,pre,th{color:#5f626e}
  td{border-top-color:#eceef2}
  .mono{color:#12141b}
  pre{background:#f3f4f6}
  .glow{background:radial-gradient(ellipse 70% 40% at 50% -8%,rgba(79,102,241,.10),transparent 60%)}
}
`;
