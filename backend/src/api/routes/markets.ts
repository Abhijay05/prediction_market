// backend/src/api/routes/markets.ts
import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { redis } from "../../cache/redis";
import { logger } from "../../lib/logger";

export const marketsRouter = Router();

// query validator
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

const EXCLUDED_TITLES = [
  "Will ETH reach $10,000 by December 2026?",
  "d",
  "will BTC will reach 200k dollar in 2026?",
  "will we win hackmoney 2026",
  "who will win ipl 2026",
  "ipl final"
];

// GET /api/markets
marketsRouter.get("/", async (req: Request, res: Response) => {
  const cacheKey = "cache:markets";

  const cached = await redis.get(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.json(JSON.parse(cached));
  }

  const markets = await prisma.market.findMany({
    where: { 
      status: { not: "CANCELLED" },
      question: { notIn: EXCLUDED_TITLES }
    },
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

  // Compute implied yes probability for each market using latest price context
  const payload = await Promise.all(
    markets.map(async (m: any) => ({
      ...m,
      yesPrice: await getLatestPrice(m.id),
    }))
  );

  await redis.setex(cacheKey, 5, JSON.stringify(payload)); // 5s TTL
  res.setHeader("X-Cache", "MISS");
  return res.json(payload);
});

// GET /api/markets/:address (address or internal uuid)
marketsRouter.get("/:address", async (req: Request, res: Response) => {
  const { address } = req.params;
  const cacheKey = `cache:market:${address.toLowerCase()}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.json(JSON.parse(cached));
  }

  // Support both contract address (0x…) and internal UUID
  const isAddress = address.startsWith("0x");
  const market = await prisma.market.findFirst({
    where: {
      AND: [
        isAddress
          ? { contractAddress: { equals: address, mode: "insensitive" } }
          : { id: address },
        { question: { notIn: EXCLUDED_TITLES } }
      ]
    },
    include: {
      creator: { select: { walletAddress: true, ensName: true } },
      _count:  { select: { trades: true } },
    },
  });

  if (!market) return res.status(404).json({ error: "Market not found" });

  const payload = {
    ...market,
    yesPrice: await getLatestPrice(market.id),
    tradeCount: market._count.trades,
  };

  await redis.setex(cacheKey, 2, JSON.stringify(payload)); // 2s TTL
  res.setHeader("X-Cache", "MISS");
  return res.json(payload);
});

// GET /api/markets/:address/ohlcv
marketsRouter.get("/:address/ohlcv", async (req: Request, res: Response) => {
  const { address } = req.params;

  const parsed = OHLCVQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { interval, from, to, limit } = parsed.data;
  const intervalSecs = INTERVAL_SECS[interval];
  const cacheKey = `cache:ohlcv:${address.toLowerCase()}:${interval}:${from.getTime()}:${to.getTime()}`;

  // cache lookup
  const cached = await redis.get(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.json(JSON.parse(cached));
  }

  // search by address or internal ID
  const isAddress = address.startsWith("0x");
  const market = await prisma.market.findFirst({
    where: {
      AND: [
        isAddress
          ? { contractAddress: { equals: address, mode: "insensitive" } }
          : { id: address },
        { question: { notIn: EXCLUDED_TITLES } }
      ]
    },
    select: { id: true, question: true, status: true },
  });

  // Market not yet indexed — return empty candles instead of 404.
  // The contract exists on-chain; the indexer just hasn't processed it yet.
  if (!market) {
    return res.json({
      marketId:     address,
      question:     "",
      interval,
      intervalSecs,
      from:         from.toISOString(),
      to:           to.toISOString(),
      candles:      [],
      count:        0,
    });
  }

  // Fetch OHLCV rows using resolved internal market ID
  const snapshots = await prisma.priceSnapshot.findMany({
    where: {
      marketId:     market.id,
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

// format candles
  const candles: Candle[] = snapshots.map((s: any) => ({
    time:   Math.floor(s.bucketStart.getTime() / 1000),
    open:   parseFloat(s.yesOpen.toString()),
    high:   parseFloat(s.yesHigh.toString()),
    low:    parseFloat(s.yesLow.toString()),
    close:  parseFloat(s.yesClose.toString()),
    volume: parseFloat(s.volume.toString()),
    trades: s.tradeCount,
  }));

  // gap filling
  const filled = fillGaps(candles, intervalSecs, from, to);

  const payload = {
    marketId:     address,
    question:     market.question,
    interval,
    intervalSecs,
    from:         from.toISOString(),
    to:           to.toISOString(),
    candles:      filled,
    count:        filled.length,
  };

  // cache results
  const ttl = Math.max(intervalSecs / 2, 10);
  await redis.setex(cacheKey, ttl, JSON.stringify(payload));

  res.setHeader("X-Cache", "MISS");
  return res.json(payload);
});

// GET /api/markets/:address/trades
marketsRouter.get("/:address/trades", async (req: Request, res: Response) => {
  const { address } = req.params;
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50"), 200);

  // Resolve internal market ID
  const isAddress = address.startsWith("0x");
  const market = await prisma.market.findFirst({
    where: isAddress
      ? { contractAddress: { equals: address, mode: "insensitive" } }
      : { id: address },
    select: { id: true },
  });

  // Not indexed yet — return empty trades
  if (!market) return res.json({ trades: [], count: 0 });

  const trades = await prisma.trade.findMany({
    where:   { marketId: market.id },
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

// --- Helpers ---

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

async function getLatestPrice(marketId: string): Promise<number> {
  // 1. Try to read from Redis
  const cached = await redis.get(`prices:${marketId}:latest`);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      return Number(parsed.yesPrice);
    } catch {}
  }
  
  // 2. Try to read from Trade table in DB
  const latestTrade = await prisma.trade.findFirst({
    where: { marketId },
    orderBy: { createdAt: "desc" },
    select: { yesPriceAfter: true },
  });
  if (latestTrade) {
    return Number(latestTrade.yesPriceAfter);
  }
  
  // 3. Fallback to default initial price
  return 0.5;
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
  // Start filling gaps from the first actual trade/snapshot rather than the 'from' date query parameter.
  // This avoids displaying long leading flat lines of inactivity before the first trade occurs.
  let t = candles[0].time;
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