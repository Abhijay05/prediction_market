import { Worker, Job } from "bullmq";
import { redis } from "../../cache/redis";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

interface SnapshotJobData {
  txHash:          string;
  blockNumber:     number;
  contractAddress: string;
  timestamp?:      string;
}

// Bucket intervals in seconds
const INTERVALS = [60, 300, 3600]; // 1m, 5m, 1h

export const snapshotWorker = new Worker<SnapshotJobData>(
  "index-snapshot",
  async (job: Job<SnapshotJobData>) => {
    const { contractAddress, blockNumber, txHash } = job.data;
    const log = logger.child({ txHash });

    const market = await prisma.market.findUnique({
      where: { contractAddress },
    });
    if (!market) return;

    let yesPrice: number | null = null;
    let noPrice: number | null = null;

    // cache lookups
    const priceKey = `prices:${market.id}:latest`;
    const cached = await redis.get(priceKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed.txHash === txHash) {
          yesPrice = Number(parsed.yesPrice);
          noPrice = Number(parsed.noPrice);
        }
      } catch (e) {
        log.error({ err: e }, "snapshot: error parsing redis price");
      }
    }

    // poll db if redis is empty (handles parallel race conditions)
    if (yesPrice === null) {
      log.info({ txHash }, "snapshot: price not in redis for this tx, polling database for trade");
      for (let attempt = 1; attempt <= 15; attempt++) {
        const trade = await prisma.trade.findUnique({
          where: { txHash }
        });
        if (trade) {
          yesPrice = Number(trade.yesPriceAfter);
          noPrice = Number(trade.noPriceAfter);
          log.info({ txHash, attempt }, "snapshot: retrieved price from database");
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    if (yesPrice === null || noPrice === null) {
      log.warn({ txHash }, "snapshot: no price in redis or database after polling, skipping");
      return;
    }
    const now = job.data.timestamp ? new Date(job.data.timestamp) : new Date();

    // TODO: evaluate bulk upserts if high trade volumes block database threads
    for (const intervalSecs of INTERVALS) {
      // align time bounds
      const bucketMs    = intervalSecs * 1000;
      const bucketStart = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);

      const existing = await prisma.priceSnapshot.findUnique({
        where: {
          marketId_intervalSecs_bucketStart: {
            marketId: market.id,
            intervalSecs,
            bucketStart,
          },
        },
      });

      if (!existing) {
        // First trade in this bucket — open = close = current price
        await prisma.priceSnapshot.create({
          data: {
            marketId:     market.id,
            intervalSecs,
            bucketStart,
            yesOpen:      yesPrice.toString(),
            yesHigh:      yesPrice.toString(),
            yesLow:       yesPrice.toString(),
            yesClose:     yesPrice.toString(),
            volume:       "0",
            startBlock:   blockNumber,
            endBlock:     blockNumber,
            tradeCount:   1,
          },
        });
      } else {
        // Update high/low/close; increment volume and trade count
        const newHigh = Math.max(Number(existing.yesHigh), yesPrice);
        const newLow  = Math.min(Number(existing.yesLow),  yesPrice);

        await prisma.priceSnapshot.update({
          where: {
            marketId_intervalSecs_bucketStart: {
              marketId: market.id,
              intervalSecs,
              bucketStart,
            },
          },
          data: {
            yesHigh:    newHigh.toString(),
            yesLow:     newLow.toString(),
            yesClose:   yesPrice.toString(),
            endBlock:   blockNumber,
            tradeCount: { increment: 1 },
          },
        });
      }
    }

    log.info({ marketId: market.id }, "snapshot: updated all intervals");
  },
  {
    connection: redis as any,
    concurrency: 10,
  }
);

snapshotWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "snapshot worker: job failed");
});