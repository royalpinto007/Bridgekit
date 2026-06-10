-- Bridgekit audit log. Runs in the shared AgentPostmortem Supabase project.
-- Append-only record of every tool call routed through the MCP server.

create table if not exists bk_audit (
  id          uuid primary key default gen_random_uuid(),
  client_name text,
  key_label   text,                 -- masked key, e.g. "bk_live_…23"
  tool        text not null,
  decision    text not null,        -- allowed | denied
  reason      text,
  args        jsonb,                -- truncated, never contains secrets
  created_at  timestamptz not null default now()
);

create index if not exists bk_audit_created_idx on bk_audit(created_at desc);
create index if not exists bk_audit_tool_idx    on bk_audit(tool, created_at desc);

alter table bk_audit enable row level security;
-- Service-role only (server writes); no anon policy by design.
