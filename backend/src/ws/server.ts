// backend/src/ws/server.ts
import { WebSocketServer, WebSocket } from "ws";
import { redisSub } from "../cache/redis";
import { logger } from "../lib/logger";
import jwt from "jsonwebtoken";

const rooms = new Map<string, Set<WebSocket>>();

export function createWsServer(port: number) {
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url!, `ws://localhost`);
    const marketId = url.searchParams.get("marketId")?.toLowerCase();
    const token = url.searchParams.get("token");

    if (!marketId) { 
      ws.close(1008, "marketId required"); 
      return; 
    }

    // TODO: hook in prometheus gauge metric tracker
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
        (ws as any).user = { walletAddress: payload.walletAddress };
        logger.info({ marketId, walletAddress: payload.walletAddress }, "ws: client authenticated");
      } catch (err) {
        logger.warn({ marketId, error: err }, "ws: auth failed");
        // fallback to public feed
      }
    } else {
      logger.info({ marketId }, "ws: client connected anonymously");
    }

    if (!rooms.has(marketId)) rooms.set(marketId, new Set());
    rooms.get(marketId)!.add(ws);
    logger.info({ marketId, total: rooms.get(marketId)!.size }, "ws: client joined");

    (ws as any).alive = true;
    ws.on("pong", () => { (ws as any).alive = true; });
    ws.on("close", () => {
      rooms.get(marketId)?.delete(ws);
      logger.info({ marketId }, "ws: client left");
    });
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!(ws as any).alive) { ws.terminate(); return; }
      (ws as any).alive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on("close", () => clearInterval(heartbeat));

  redisSub.psubscribe("prices:*", (err) => {
    if (err) logger.error(err, "ws: redis subscribe failed");
    else logger.info("ws: subscribed to prices:*");
  });

  redisSub.on("pmessage", (_pattern, channel, message) => {
    const marketId = channel.replace("prices:", "");
    const room     = rooms.get(marketId);
    if (!room) return;

    const dead: WebSocket[] = [];
    room.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
      else dead.push(ws);
    });
    dead.forEach(ws => room.delete(ws));
  });

  logger.info({ port }, "ws: server started");
  return wss;
}