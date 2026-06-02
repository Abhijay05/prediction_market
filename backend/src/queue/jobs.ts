// backend/src/queue/jobs.ts
import { z } from "zod";

// Shared base for on-chain events
const BaseJob = z.object({
  txHash:          z.string().length(66),   // 0x + 64 hex
  blockNumber:     z.number().int().positive(),
  logIndex:        z.number().int().min(0),
  contractAddress: z.string().length(42),   // 0x + 40 hex
});

// Trade validation schemas (BUY/SELL)
export const TradeJobSchema = BaseJob.extend({
  direction:     z.enum(["BUY", "SELL"]),
  outcome:       z.enum(["YES", "NO"]),
  buyer:         z.string().optional(),
  collateralIn:  z.string().optional(),   // uint256 string
  tokensOut:     z.string().optional(),
  seller:        z.string().optional(),
  tokensIn:      z.string().optional(),
  collateralOut: z.string().optional(),
}).refine(
  data =>
    (data.direction === "BUY"  && data.buyer  && data.collateralIn && data.tokensOut) ||
    (data.direction === "SELL" && data.seller && data.tokensIn     && data.collateralOut),
  { message: "Invalid combination of trade fields" }
);

// Market lifecycle validation schemas (created/resolved)
export const MarketJobSchema = BaseJob.extend({
  event: z.enum(["created", "resolved"]),
  marketAddress:    z.string().optional(),
  creatorAddress:   z.string().optional(),
  initialLiquidity: z.string().optional(),
  winningOutcome:   z.enum(["YES", "NO"]).optional(),
  resolver:         z.string().optional(),
}).refine(
  data =>
    (data.event === "created"  && data.marketAddress && data.creatorAddress) ||
    (data.event === "resolved" && data.winningOutcome && data.resolver),
  { message: "Invalid lifecycle event combination" }
);

// Snapshot schema
export const SnapshotJobSchema = BaseJob;

// TS types
export type TradeJobData    = z.infer<typeof TradeJobSchema>;
export type MarketJobData   = z.infer<typeof MarketJobSchema>;
export type SnapshotJobData = z.infer<typeof SnapshotJobSchema>;

// Queue identifiers
export const QUEUES = {
  TRADE:    "index-trade",
  MARKET:   "index-market",
  SNAPSHOT: "index-snapshot",
} as const;

// Default job constraints (BullMQ retries / backoffs)
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: { count: 500 },
  removeOnFail:     { count: 100 },
};