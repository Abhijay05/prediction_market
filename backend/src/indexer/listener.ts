import { Alchemy, Network } from "alchemy-sdk";
import { ethers } from "ethers";
import { Queue } from "bullmq";
import { redis } from "../cache/redis";
import { logger } from "../lib/logger";

// ── ABI fragments (only the events we care about) ────────────────────────────
const MARKET_ABI = [
  "event TokensPurchased(address indexed buyer, uint8 outcome, uint256 collateralIn, uint256 tokensOut)",
  "event TokensSold(address indexed seller, uint8 outcome, uint256 tokensIn, uint256 collateralOut)",
  "event MarketCreated(address indexed market, address indexed creator, uint256 initialLiquidity)",
  "event MarketResolved(uint8 winningOutcome, address indexed resolver)",
];

const iface = new ethers.Interface(MARKET_ABI);

// ── Alchemy SDK setup ─────────────────────────────────────────────────────────
const alchemy = new Alchemy({
  apiKey: process.env.ALCHEMY_API_KEY!,
  network: Network.ETH_SEPOLIA,
});

// ── BullMQ queues ─────────────────────────────────────────────────────────────
const tradeQueue   = new Queue("index-trade",   { connection: redis as any });
const marketQueue  = new Queue("index-market",  { connection: redis as any });
const snapshotQueue = new Queue("index-snapshot", { connection: redis as any });

// ── Known market addresses (loaded from DB at startup) ────────────────────────
let watchedAddresses = new Set<string>();

export async function loadWatchedMarkets(addresses: string[]) {
  addresses.forEach(a => watchedAddresses.add(a.toLowerCase()));
  logger.info({ count: addresses.length }, "indexer: loaded watched markets");
}

// ── Main listener ─────────────────────────────────────────────────────────────
export async function startIndexer() {
  logger.info("indexer: connecting to Alchemy WebSocket");

  // Subscribe to logs from all watched market contracts
  alchemy.ws.on(
    {
      address: [...watchedAddresses],
    } as any,
    async (log) => {
      try {
        await handleLog(log);
      } catch (err) {
        logger.error({ err, log }, "indexer: unhandled log error");
      }
    }
  );

  // Also subscribe to the Router to catch new MarketCreated events
  alchemy.ws.on(
    {
      address: process.env.ROUTER_ADDRESS!,
    } as any,
    async (log) => {
      try {
        await handleLog(log);
      } catch (err) {
        logger.error({ err, log }, "indexer: router log error");
      }
    }
  );

  logger.info("indexer: listening for on-chain events");
}

// ── Log dispatcher ────────────────────────────────────────────────────────────
async function handleLog(log: any) {
  let parsed: ethers.LogDescription | null = null;

  try {
    parsed = iface.parseLog({ topics: log.topics, data: log.data });
  } catch {
    return; // not one of our events
  }

  if (!parsed) return;

  const base = {
    txHash:      log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
    logIndex:    parseInt(log.logIndex, 16),
    contractAddress: log.address.toLowerCase(),
  };

  switch (parsed.name) {
    case "TokensPurchased":
      await tradeQueue.add(
        "buy",
        {
          ...base,
          direction: "BUY",
          buyer:     parsed.args.buyer.toLowerCase(),
          outcome:   parsed.args.outcome === 0 ? "YES" : "NO",
          collateralIn: parsed.args.collateralIn.toString(),
          tokensOut:    parsed.args.tokensOut.toString(),
        },
        { jobId: `${base.txHash}-${base.logIndex}` } // idempotency
      );
      // also enqueue a price snapshot for this block
      await snapshotQueue.add(
        "snapshot",
        { ...base },
        { jobId: `snap-${base.txHash}-${base.logIndex}` }
      );
      break;

    case "TokensSold":
      await tradeQueue.add(
        "sell",
        {
          ...base,
          direction: "SELL",
          seller:    parsed.args.seller.toLowerCase(),
          outcome:   parsed.args.outcome === 0 ? "YES" : "NO",
          tokensIn:     parsed.args.tokensIn.toString(),
          collateralOut: parsed.args.collateralOut.toString(),
        },
        { jobId: `${base.txHash}-${base.logIndex}` }
      );
      await snapshotQueue.add(
        "snapshot",
        { ...base },
        { jobId: `snap-${base.txHash}-${base.logIndex}` }
      );
      break;

    case "MarketCreated":
      // add new market to watched set so live subscriptions pick it up
      watchedAddresses.add(parsed.args.market.toLowerCase());
      await marketQueue.add(
        "created",
        {
          ...base,
          marketAddress:    parsed.args.market.toLowerCase(),
          creatorAddress:   parsed.args.creator.toLowerCase(),
          initialLiquidity: parsed.args.initialLiquidity.toString(),
        },
        { jobId: `${base.txHash}-${base.logIndex}` }
      );
      break;

    case "MarketResolved":
      await marketQueue.add(
        "resolved",
        {
          ...base,
          winningOutcome: parsed.args.winningOutcome === 0 ? "YES" : "NO",
          resolver:       parsed.args.resolver.toLowerCase(),
        },
        { jobId: `${base.txHash}-${base.logIndex}` }
      );
      break;
  }
}