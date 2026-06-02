// backend/src/queue/index.ts
import { tradeWorker }    from "../indexer/handlers/trade";
import { snapshotWorker } from "../indexer/handlers/snapshot";
import { marketWorker }   from "../indexer/handlers/market";
import { logger }         from "../lib/logger";
import { startIndexer, backfillHistory } from "../indexer/listener";

logger.info("queue: all workers started");
logger.info({ queues: ["index-trade", "index-snapshot", "index-market"] }, "queue: listening");

async function startup() {
  try {
    // 1. Run historical backfill to parse past events and populate queues
    logger.info("queue: triggering historical backfill...");
    await backfillHistory();

    // 2. Start standard WebSocket real-time event indexing
    logger.info("queue: starting websocket real-time listener...");
    await startIndexer();
  } catch (err) {
    logger.error({ err }, "queue: error during startup indexer initialization");
  }
}

startup();

process.on("SIGTERM", async () => {
  logger.info("queue: SIGTERM received, draining workers...");
  await Promise.all([
    tradeWorker.close(),
    snapshotWorker.close(),
    marketWorker.close(),
  ]);
  logger.info("queue: workers drained, exiting");
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("queue: SIGINT received, shutting down");
  await Promise.all([
    tradeWorker.close(),
    snapshotWorker.close(),
    marketWorker.close(),
  ]);
  process.exit(0);
});