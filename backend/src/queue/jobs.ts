// backend/src/queue/jobs.ts
import { z } from "zod";

// ── Shared base for every on-chain event job ──────────────────────────────────
const BaseJob = z.object({
  txHash:          z.string().length(66),   // 0x + 64 hex chars
  blockNumber:     z.number().int().positive(),
  logIndex:        z.number().int().min(0),
  contractAddress: z.string().length(42),   // 0x + 40 hex chars
});

// ── Trade job (BUY or SELL) ───────────────────────────────────────────────────
export const TradeJobSchema = BaseJob.extend({
  direction:     z.enum(["BUY", "SELL"]),
  outcome:       z.enum(["YES", "NO"]),
  // BUY fields
  buyer:         z.string().optional(),
  collateralIn:  z.string().optional(),   // uint256 as string
  tokensOut:     z.string().optional(),
  // SELL fields
  seller:        z.string().optional(),
  tokensIn:      z.string().optional(),
  collateralOut: z.string().optional(),
}).refine(
  data =>
    (data.direction === "BUY"  && data.buyer  && data.collateralIn && data.tokensOut) ||
    (data.direction === "SELL" && data.seller && data.tokensIn     && data.collateralOut),
  { message: "BUY requires buyer/collateralIn/tokensOut; SELL requires seller/tokensIn/collateralOut" }
);

// ── Market lifecycle job ──────────────────────────────────────────────────────
export const MarketJobSchema = BaseJob.extend({
  event: z.enum(["created", "resolved"]),
  // created fields
  marketAddress:    z.string().optional(),
  creatorAddress:   z.string().optional(),
  initialLiquidity: z.string().optional(),
  // resolved fields
  winningOutcome:   z.enum(["YES", "NO"]).optional(),
  resolver:         z.string().optional(),
}).refine(
  data =>
    (data.event === "created"  && data.marketAddress && data.creatorAddress) ||
    (data.event === "resolved" && data.winningOutcome && data.resolver),
  { message: "created requires marketAddress/creatorAddress; resolved requires winningOutcome/resolver" }
);

// ── Snapshot job ──────────────────────────────────────────────────────────────
export const SnapshotJobSchema = BaseJob;

// ── Inferred types ────────────────────────────────────────────────────────────
export type TradeJobData    = z.infer<typeof TradeJobSchema>;
export type MarketJobData   = z.infer<typeof MarketJobSchema>;
export type SnapshotJobData = z.infer<typeof SnapshotJobSchema>;

// ── Queue names (single source of truth) ─────────────────────────────────────
export const QUEUES = {
  TRADE:    "index-trade",
  MARKET:   "index-market",
  SNAPSHOT: "index-snapshot",
} as const;

// ── Default job options (used in listener.ts when enqueuing) ──────────────────
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: { count: 500 },   // keep last 500 completed jobs for Bull Dashboard
  removeOnFail:     { count: 100 },   // keep last 100 failed jobs for debugging
};