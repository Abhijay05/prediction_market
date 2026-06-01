import { Worker, Job } from "bullmq";
import { redis } from "../../cache/redis";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

interface SnapshotJobData {
  txHash:          string;
  blockNumber:     number;
  contractAddress: string;
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

    // Read current price from Redis (set by trade handler moments before)
    const priceKey = `prices:${market.id}:latest`;
    const cached   = await redis.get(priceKey);
    if (!cached) {
      log.warn("snapshot: no price in redis, skipping");
      return;
    }

    const { yesPrice, noPrice } = JSON.parse(cached);
    const now = new Date();

    for (const intervalSecs of INTERVALS) {
      // Round down to bucket start
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