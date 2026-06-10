export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  BRIDGEKIT_CLIENTS?: string; // JSON map of key -> ClientConfig
  SHOPIFY_STORE?: string;
  SHOPIFY_ADMIN_TOKEN?: string;
  TRIPLEWHALE_API_KEY?: string;
  AI_GATEWAY_SECRET?: string;
}

export interface ClientConfig {
  name: string;
  tools: string[]; // tool names this client may call
  allowWrite: boolean; // gate for any tool marked write
}

export interface Caller {
  key: string;
  config: ClientConfig;
}
