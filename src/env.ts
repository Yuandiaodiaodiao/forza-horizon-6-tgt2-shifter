export function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value == null || value.trim() === "" ? fallback : value;
}

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export function buildKeyAgentUrl(): string {
  const explicit = process.env.TGT2_KEY_AGENT_URL;
  if (explicit && explicit.trim() !== "") return explicit;
  const host = envString("TGT2_KEY_AGENT_HOST", "127.0.0.1");
  const port = envNumber("TGT2_KEY_AGENT_PORT", 7788);
  return `http://${host}:${port}`;
}

export function buildProxyRemoteWs(): string {
  const explicit = process.env.TGT2_PROXY_REMOTE_WS;
  if (explicit && explicit.trim() !== "") return explicit;
  const host = envString("TGT2_WINDOWS_HOST", "127.0.0.1");
  const port = envNumber("TGT2_WS_PORT", 8765);
  return `ws://${host}:${port}`;
}
