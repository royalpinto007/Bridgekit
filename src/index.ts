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

    // AI assistant proxy (server-side; holds the gateway secret).
    if (req.method === "POST" && url.pathname === "/ai") {
      return aiChat(req, env);
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

const AI_SYSTEM =
  "You are the assistant for Bridgekit, a scoped MCP server that exposes a " +
  "company's tools (Shopify, Triple Whale, Postgres) to their AI stack with " +
  "per-client permission scopes, read/write separation, and an append-only " +
  "audit log. Answer questions about Bridgekit and MCP concisely, 1-4 sentences.";

async function aiChat(req: Request, env: Env): Promise<Response> {
  const { prompt, max } = (await req.json().catch(() => ({}))) as { prompt?: string; max?: number };
  if (!prompt) return json({ error: "prompt required" }, 400);
  if (!env.AI_GATEWAY_SECRET) return json({ error: "AI not configured" }, 503);
  try {
    const r = await fetch("https://n8n.agentpostmortem.com/webhook/ai-gw", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ai-secret": env.AI_GATEWAY_SECRET,
      },
      body: JSON.stringify({ system: AI_SYSTEM, prompt: String(prompt).slice(0, 2000), max: typeof max === "number" ? max : undefined }),
    });
    const d = (await r.json()) as { reply?: string; error?: string };
    return json({ reply: d.reply || "", error: d.error });
  } catch {
    return json({ error: "AI upstream unreachable" }, 502);
  }
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

const AUDIT_ROWS = [
  ["growth-os", "triplewhale_metrics", true],
  ["growth-os", "shopify_orders", true],
  ["analyst-ro", "db_query · posts", true],
  ["growth-os", "shopify_tag_order", false],
  ["growth-os", "triplewhale_metrics", true],
  ["analyst-ro", "db_query · users", false],
  ["ops-bot", "shopify_orders", true],
  ["growth-os", "db_query · tc_runs", true],
]
  .map(
    ([client, tool, ok]) =>
      `<div class="trow"><span><span class="tname">${tool}</span> <span class="tcli">· ${client}</span></span><span class="${ok ? "tok" : "tno"}">${ok ? "allowed" : "denied"}</span></div>`,
  )
  .join("");

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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%237c3aed'/%3E%3Cpath d='M9 13h11l-3-3m6 9H12l3 3' stroke='%23fff' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${LANDING_CSS}</style></head>
<body><div class="glow"></div><main>
  <header>
    <div class="logo"><span class="mark">⇄</span> Bridgekit</div>
    <span class="status"><i></i> live</span>
  </header>
  <span class="eyebrow">model context protocol</span>
  <h1>Give your AI your tools.<br>Not your API keys.</h1>
  <p class="lede">A scoped MCP server that exposes Shopify, Triple Whale, and your database to an AI stack with per-client permission boundaries, read/write separation, and an append-only audit log.</p>
  <div class="card">
    <div class="card-head">Live audit log <span class="runtag"><i></i> streaming</span></div>
    <div class="ticker"><div class="ticker-inner">${AUDIT_ROWS}${AUDIT_ROWS}</div></div>
  </div>
  <div class="card">
    <div class="card-head">Which tool should I use? (AI)</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <input id="tgin" onkeydown="if(event.key==='Enter')tsuggest()" placeholder="Describe what you need, e.g. last week ad ROAS" style="flex:1;min-width:200px;background:#08080a;border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:9px 11px;color:#ededf2;font:inherit;font-size:13px"/>
      <button onclick="tsuggest()">Suggest</button>
    </div>
    <pre id="tgout" class="out"></pre>
  </div>
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
  <div class="card">
    <div class="card-head">Try it live (demo client key)</div>
    <div class="btns">
      <button onclick="bk('tools/list',{})">List my tools</button>
      <button onclick="bk('tools/call',{name:'triplewhale_metrics',arguments:{}})">Read metrics</button>
      <button onclick="bk('tools/call',{name:'shopify_tag_order',arguments:{orderId:1001,tags:'vip'}})">Try a write</button>
    </div>
    <pre id="out" class="out">Click a button to call the live MCP server. The demo key is read-only, so the write attempt is denied and logged.</pre>
  </div>
  <footer>Per-key scopes · write actions gated · every call audited · <a href="/info">/info</a></footer>
  <script>
    async function tsuggest(){var i=document.getElementById('tgin'),o=document.getElementById('tgout');var q=i.value.trim()||"last week's blended ROAS";o.textContent='Thinking…';try{var r=await fetch('/ai',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'Bridgekit exposes these MCP tools: shopify_orders (read), triplewhale_metrics (read), db_query (read, allowlisted tables), shopify_tag_order (write). Which ONE best fits this request, and give a one-line example call? Request: '+q,max:160})});var d=await r.json();o.textContent=d.reply||('Unavailable ('+(d.error||'?')+')');}catch(e){o.textContent='Error: '+e.message;}}
    async function bk(method, params){
      var out=document.getElementById('out'); out.textContent='Calling '+method+' …';
      try{
        var r=await fetch('/mcp',{method:'POST',headers:{'x-bridgekit-key':'bk_live_demo123','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:method,params:params})});
        out.textContent=JSON.stringify(await r.json(),null,2);
      }catch(e){ out.textContent='Error: '+e.message; }
    }
  </script>
  <button class="chatbtn" onclick="document.getElementById('cbox').classList.toggle('open')">✦</button>
  <div class="chatbox" id="cbox">
    <div class="chathead">Bridgekit assistant</div>
    <div class="chatmsgs" id="cmsgs"><div class="cm a">Ask me about Bridgekit, MCP, scopes, or the audit log.</div></div>
    <form class="chatform" onsubmit="return cask(event)"><input id="cin" placeholder="Ask about Bridgekit…" autocomplete="off"/><button>Send</button></form>
  </div>
  <script>
    async function cask(e){e.preventDefault();var i=document.getElementById('cin'),m=document.getElementById('cmsgs');var q=i.value.trim();if(!q)return false;i.value='';var u=document.createElement('div');u.className='cm u';u.textContent=q;m.appendChild(u);var t=document.createElement('div');t.className='cm a';t.textContent='thinking…';m.appendChild(t);m.scrollTop=m.scrollHeight;try{var r=await fetch('/ai',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:q})});var d=await r.json();t.textContent=d.reply||('Unavailable ('+(d.error||'?')+')');}catch(err){t.textContent='Network error.';}m.scrollTop=m.scrollHeight;return false;}
  </script>
</main></body></html>`;
}

const LANDING_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#08080a;color:#ededf2;font:15px/1.65 'Inter',ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 80% 50% at 20% -8%,rgba(124,58,237,.20),transparent 60%),radial-gradient(ellipse 50% 40% at 95% 10%,rgba(168,85,247,.12),transparent 55%)}
main{position:relative;max-width:980px;margin:0 auto;padding:32px 24px 60px;z-index:1}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:48px}
.logo{display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-weight:800}
.status{display:inline-flex;align-items:center;gap:7px;border:1px solid #26262e;background:#111114;border-radius:999px;padding:5px 11px;font-size:11px;color:#8b8b96}
.status i{width:7px;height:7px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950}
.eyebrow{display:inline-block;border:1px solid #26262e;background:#111114;border-radius:999px;padding:4px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#8b8b96}
h1{font-size:46px;line-height:1.06;letter-spacing:-.025em;margin:18px 0 16px;font-weight:700;background:linear-gradient(120deg,#fff,#a855f7);-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{color:#8b8b96;max-width:560px;font-size:16px}
.card{border:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,rgba(24,20,34,.9),rgba(17,17,20,.5));backdrop-filter:blur(12px);border-radius:20px;padding:20px;margin-top:18px;box-shadow:0 1px 0 0 rgba(255,255,255,.04) inset,0 16px 50px -22px rgba(0,0,0,.7);transition:.2s}.card:hover{border-color:rgba(168,85,247,.35);transform:translateY(-2px)}
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
a{color:#a855f7;text-decoration:none}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
button{font:inherit;cursor:pointer;border:1px solid #26262e;background:#08080a;color:#ededf2;border-radius:9px;padding:8px 12px;font-size:12.5px;transition:.15s}
button:hover{border-color:#a855f7}
.out{min-height:64px;white-space:pre-wrap}
.runtag{display:inline-flex;align-items:center;gap:6px;font-size:10px;color:#a855f7;background:rgba(168,85,247,.12);border-radius:999px;padding:2px 8px;margin-left:8px}
.runtag i{width:6px;height:6px;border-radius:50%;background:#a855f7;animation:blink 1.4s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:.3}50%{opacity:1}}
.flow{position:relative;margin-top:4px}
.ftrack{position:absolute;left:7%;right:7%;top:21px;height:2px;background:#2e2836;border-radius:2px;overflow:hidden;display:none}
@media(min-width:640px){.ftrack{display:block}}
.ftrack::before{content:"";position:absolute;top:-1px;height:4px;width:22%;border-radius:4px;background:linear-gradient(90deg,transparent,#a855f7,transparent);animation:ftravel 2.8s linear infinite}
@keyframes ftravel{0%{left:-22%}100%{left:100%}}
.fnodes{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:20px}
@media(max-width:640px){.fnodes{grid-template-columns:1fr}}
.fnode{text-align:center}
@media(min-width:640px){.fnode{text-align:left}}
.fico{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-weight:700;margin:0 auto 10px;animation:fpulse 2.8s ease-in-out infinite}
@media(min-width:640px){.fico{margin:0 0 10px}}
@keyframes fpulse{0%,100%{box-shadow:0 0 0 0 rgba(168,85,247,0)}50%{box-shadow:0 0 0 6px rgba(168,85,247,.18)}}
.ft{font-weight:600;font-size:13.5px}
.fd{color:#8b8b96;font-size:12px;margin-top:3px;line-height:1.5}
.ticker{height:170px;overflow:hidden;position:relative;-webkit-mask-image:linear-gradient(180deg,transparent,#000 16%,#000 84%,transparent);mask-image:linear-gradient(180deg,transparent,#000 16%,#000 84%,transparent)}
.ticker-inner{display:flex;flex-direction:column;gap:8px;animation:tick 16s linear infinite}
@keyframes tick{from{transform:translateY(0)}to{transform:translateY(-50%)}}
.trow{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:9px 12px;font-size:12.5px;background:rgba(255,255,255,.02)}
.tname{font-family:ui-monospace,Menlo,monospace}
.tcli{color:#8b8b96;font-size:11px}
.tok{color:#3fb950;background:rgba(63,185,80,.12);border-radius:6px;padding:2px 8px;font-size:11px}
.tno{color:#f85149;background:rgba(248,81,73,.12);border-radius:6px;padding:2px 8px;font-size:11px}
.chatbtn{position:fixed;bottom:20px;right:20px;width:50px;height:50px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-size:20px;box-shadow:0 10px 30px -8px rgba(124,58,237,.6);z-index:50}
.chatbox{position:fixed;bottom:82px;right:20px;width:min(92vw,360px);height:440px;display:none;flex-direction:column;background:#141019;border:1px solid rgba(255,255,255,.1);border-radius:18px;overflow:hidden;z-index:50;box-shadow:0 20px 60px -20px rgba(0,0,0,.8)}
.chatbox.open{display:flex}
.chathead{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08);font-size:13px;font-weight:600}
.chatmsgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.cm{max-width:82%;padding:8px 11px;border-radius:14px;font-size:13px;line-height:1.5}
.cm.u{align-self:flex-end;background:rgba(168,85,247,.18)}
.cm.a{align-self:flex-start;background:rgba(255,255,255,.05)}
.chatform{display:flex;gap:8px;padding:10px;border-top:1px solid rgba(255,255,255,.08)}
.chatform input{flex:1;min-width:0;background:#0c0e12;border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:8px 10px;color:#ededf2;font:inherit;font-size:13px}
.chatform button{border:none;border-radius:9px;padding:0 13px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-weight:600;cursor:pointer}
@media (prefers-color-scheme: light){
  body{background:#fafafc;color:#12141b}
  .status,.eyebrow,.card{background:#fff;border-color:#e2e4e9}
  .status,.eyebrow,.muted,.lede,footer,pre,th{color:#5f626e}
  td{border-top-color:#eceef2}
  .mono{color:#12141b}
  pre,button{background:#f3f4f6}
  button{color:#12141b;border-color:#e2e4e9}
  .glow{background:radial-gradient(ellipse 70% 40% at 50% -8%,rgba(79,102,241,.10),transparent 60%)}
}
`;
