// backend/src/api/routes/markets.ts
import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { redis } from "../../cache/redis";
import { logger } from "../../lib/logger";

export const marketsRouter = Router();

// ── Query param schema ────────────────────────────────────────────────────────
const OHLCVQuery = z.object({
  interval: z
    .enum(["1m", "5m", "1h"])
    .default("5m"),
  from: z
    .string()
    .optional()
    .transform(v => (v ? new Date(v) : new Date(Date.now() - 24 * 60 * 60 * 1000))),
  to: z
    .string()
    .optional()
    .transform(v => (v ? new Date(v) : new Date())),
  limit: z
    .string()
    .optional()
    .transform(v => Math.min(parseInt(v ?? "200"), 500)),
});

const INTERVAL_SECS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "1h": 3600,
};

// ── GET /api/markets ──────────────────────────────────────────────────────────
marketsRouter.get("/", async (req: Request, res: Response) => {
  const cacheKey = "cache:markets";

  const cached = await redis.get(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.json(JSON.parse(cached));
  }

  const markets = await prisma.market.findMany({
    where:   { status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
    select: {
      id:               true,
      contractAddress:  true,
      question:         true,
      category:         true,
      status:           true,
      yesReserve:       true,
      noReserve:        true,
      totalVolume:      true,
      expiresAt:        true,
      winningOutcome:   true,
    },
  });

  // Compute implied yes probability for each market
  const payload = markets.map((m: any) => ({
    ...m,
    yesPrice: computePrice(m.yesReserve.toString(), m.noReserve.toString()),
  }));

  await redis.setex(cacheKey, 5, JSON.stringify(payload)); // 5s TTL
  res.setHeader("X-Cache", "MISS");
  return res.json(payload);
});

// ── GET /api/markets/:id ──────────────────────────────────────────────────────
marketsRouter.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const cacheKey = `cache:market:${id}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.json(JSON.parse(cached));
  }

  const market = await prisma.market.findUnique({
    where: { id },
    include: {
      creator: { select: { walletAddress: true, ensName: true } },
      _count:  { select: { trades: true } },
    },
  });

  if (!market) return res.status(404).json({ error: "Market not found" });

  const payload = {
    ...market,
    yesPrice: computePrice(market.yesReserve.toString(), market.noReserve.toString()),
    tradeCount: market._count.trades,
  };

  await redis.setex(cacheKey, 2, JSON.stringify(payload)); // 2s TTL
  res.setHeader("X-Cache", "MISS");
  return res.json(payload);
});

// ── GET /api/markets/:id/ohlcv ────────────────────────────────────────────────
marketsRouter.get("/:id/ohlcv", async (req: Request, res: Response) => {
  const { id } = req.params;

  // Validate query params
  const parsed = OHLCVQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { interval, from, to, limit } = parsed.data;
  const intervalSecs = INTERVAL_SECS[interval];
  const cacheKey = `cache:ohlcv:${id}:${interval}:${from.getTime()}:${to.getTime()}`;

  // Check Redis — short TTL since this is time-series data
  const cached = await redis.get(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.json(JSON.parse(cached));
  }

  // Verify market exists
  const market = await prisma.market.findUnique({
    where:  { id },
    select: { id: true, question: true, status: true },
  });
  if (!market) return res.status(404).json({ error: "Market not found" });

  // Fetch OHLCV rows
  const snapshots = await prisma.priceSnapshot.findMany({
    where: {
      marketId:     id,
      intervalSecs,
      bucketStart: { gte: from, lte: to },
    },
    orderBy: { bucketStart: "asc" },
    take:    limit,
    select: {
      bucketStart: true,
      yesOpen:     true,
      yesHigh:     true,
      yesLow:      true,
      yesClose:    true,
      volume:      true,
      tradeCount:  true,
    },
  });

  // Shape into standard OHLCV array (TradingView / lightweight-charts compatible)
  const candles: Candle[] = snapshots.map((s: any) => ({
    time:   Math.floor(s.bucketStart.getTime() / 1000), // unix seconds
    open:   parseFloat(s.yesOpen.toString()),
    high:   parseFloat(s.yesHigh.toString()),
    low:    parseFloat(s.yesLow.toString()),
    close:  parseFloat(s.yesClose.toString()),
    volume: parseFloat(s.volume.toString()),
    trades: s.tradeCount,
  }));

  // Fill gaps with previous close (so chart has no holes)
  const filled = fillGaps(candles, intervalSecs, from, to);

  const payload = {
    marketId:     id,
    question:     market.question,
    interval,
    intervalSecs,
    from:         from.toISOString(),
    to:           to.toISOString(),
    candles:      filled,
    count:        filled.length,
  };

  // Cache for half the interval duration (stale data is fine here)
  const ttl = Math.max(intervalSecs / 2, 10);
  await redis.setex(cacheKey, ttl, JSON.stringify(payload));

  res.setHeader("X-Cache", "MISS");
  return res.json(payload);
});

// ── GET /api/markets/:id/trades ───────────────────────────────────────────────
marketsRouter.get("/:id/trades", async (req: Request, res: Response) => {
  const { id } = req.params;
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50"), 200);

  const trades = await prisma.trade.findMany({
    where:   { marketId: id },
    orderBy: { createdAt: "desc" },
    take:    limit,
    select: {
      txHash:       true,
      direction:    true,
      outcome:      true,
      collateralIn: true,
      tokenAmount:  true,
      avgPrice:     true,
      yesPriceAfter: true,
      priceImpact:  true,
      createdAt:    true,
      trader: { select: { walletAddress: true, ensName: true } },
    },
  });

  return res.json({ trades, count: trades.length });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

function computePrice(yesReserve: string, noReserve: string): number {
  const yes = parseFloat(yesReserve);
  const no  = parseFloat(noReserve);
  const total = yes + no;
  return total > 0 ? yes / total : 0.5;
}

function fillGaps(
  candles: Candle[],
  intervalSecs: number,
  from: Date,
  to: Date
): Candle[] {
  if (candles.length === 0) return [];

  const filled: Candle[] = [];
  let prev = candles[0];
  let t    = Math.floor(from.getTime() / 1000 / intervalSecs) * intervalSecs;
  const end = Math.floor(to.getTime() / 1000);
  let ci = 0;

  while (t <= end) {
    const candle = candles[ci];
    if (candle && candle.time === t) {
      filled.push(candle);
      prev = candle;
      ci++;
    } else if (prev) {
      // Gap — repeat previous close as a flat candle
      filled.push({
        time:   t,
        open:   prev.close,
        high:   prev.close,
        low:    prev.close,
        close:  prev.close,
        volume: 0,
        trades: 0,
      });
    }
    t += intervalSecs;
  }

  return filled;
}