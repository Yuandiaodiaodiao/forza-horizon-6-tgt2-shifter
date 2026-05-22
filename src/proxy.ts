/**
 * Mac-side WebSocket proxy
 *
 * Connects to Windows server (WS 8765), relays all events
 * to local browser clients (WS 8766).
 */

import { buildProxyRemoteWs, envNumber, envString } from "./env";

const REMOTE_WS = buildProxyRemoteWs();
const LOCAL_PORT = envNumber("TGT2_PROXY_LOCAL_PORT", 8766);
const LOCAL_HOST = envString("TGT2_PROXY_LOCAL_HOST", "127.0.0.1");

const clients = new Set<any>();

const server = Bun.serve({
  port: LOCAL_PORT,
  hostname: LOCAL_HOST,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("T-GT II Proxy", { status: 200 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      console.log(`  Browser connected (${clients.size} total)`);
    },
    close(ws) {
      clients.delete(ws);
      console.log(`  Browser disconnected (${clients.size} total)`);
    },
    message() {},
  },
});

console.log(`  Local proxy: ws://${LOCAL_HOST}:${LOCAL_PORT}`);
console.log(`  Remote:      ${REMOTE_WS}`);

function broadcast(data: string | Buffer) {
  for (const ws of clients) {
    try { ws.send(data); } catch { clients.delete(ws); }
  }
}

async function connectRemote() {
  while (true) {
    try {
      console.log(`  Connecting to ${REMOTE_WS} ...`);
      const ws = new WebSocket(REMOTE_WS);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          console.log("  Connected to Windows server!");
          resolve();
        };
        ws.onerror = (e) => reject(e);
        ws.onclose = () => reject(new Error("closed"));
      });

      await new Promise<void>((_, reject) => {
        ws.onmessage = (evt) => broadcast(evt.data as string);
        ws.onclose = () => {
          console.log("  Remote disconnected");
          reject(new Error("closed"));
        };
        ws.onerror = (e) => reject(e);
      });
    } catch (e) {
      console.log(`  Connection lost, retrying in 2s...`);
      await Bun.sleep(2000);
    }
  }
}

connectRemote();
