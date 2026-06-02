import { Alchemy, Network } from "alchemy-sdk";
import { ethers } from "ethers";
import { Queue } from "bullmq";
import { redis } from "../cache/redis";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";

// ── ABI fragments (only the events we care about) ────────────────────────────
const MARKET_ABI = [
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed creator, string title, string description, string resolutionSource, uint256 deadline, uint256 liquidity)",
  "event MarketBuy(address indexed buyer, bool isBuyYes, uint256 amountIn, uint256 amountOut)",
  "event MarketSell(address indexed seller, bool isSellYes, uint256 amountIn, uint256 amountOut)",
  "event MarketResolvedByAdmin(uint256 outcome, address indexed admin)",
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

export function watchMarket(marketAddress: string) {
  const lowerAddress = marketAddress.toLowerCase();
  if (watchedAddresses.has(lowerAddress)) return;

  watchedAddresses.add(lowerAddress);
  logger.info({ market: lowerAddress }, "indexer: dynamically subscribing to new market");

  alchemy.ws.on(
    {
      address: lowerAddress,
    } as any,
    async (log) => {
      try {
        await handleLog(log);
      } catch (err) {
        logger.error({ err, log }, "indexer: unhandled log error");
      }
    }
  );
}

// ── Main listener ─────────────────────────────────────────────────────────────
export async function startIndexer() {
  logger.info("indexer: connecting to Alchemy WebSocket");

  // Subscribe to logs from all watched market contracts individually
  for (const addr of watchedAddresses) {
    logger.info({ market: addr }, "indexer: subscribing to watched market");
    alchemy.ws.on(
      {
        address: addr,
      } as any,
      async (log) => {
        try {
          await handleLog(log);
        } catch (err) {
          logger.error({ err, log }, "indexer: unhandled log error");
        }
      }
    );
  }

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

function parseNumeric(val: any): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    if (val.startsWith("0x")) {
      return parseInt(val, 16);
    }
    return parseInt(val, 10);
  }
  return Number(val);
}

export async function backfillHistory() {
  const routerAddress = process.env.ROUTER_ADDRESS;
  if (!routerAddress) {
    logger.warn("indexer: ROUTER_ADDRESS env variable is not set, skipping backfill");
    return;
  }

  logger.info({ routerAddress }, "indexer: starting historical backfill");

  try {
    const provider = await alchemy.config.getProvider();
    
    // ABI for Router
    const routerAbi = [
      "function getAllMarkets() external view returns (address[])",
    ];
    
    const routerContract = new ethers.Contract(routerAddress, routerAbi, provider as any);
    const marketsOnChain: string[] = await routerContract.getAllMarkets();
    logger.info({ count: marketsOnChain.length }, "indexer: found markets on-chain");

    // Populate initial watched addresses from contract
    for (const marketAddress of marketsOnChain) {
      watchedAddresses.add(marketAddress.toLowerCase());
    }

    // 1. Gather all unique transaction hashes from asset transfers to all markets
    const uniqueTxHashes = new Set<string>();
    const txTimestamps = new Map<string, string>();

    for (const marketAddress of marketsOnChain) {
      const lowerAddress = marketAddress.toLowerCase();
      logger.info({ market: lowerAddress }, "indexer: querying asset transfers for market");
      
      const response = await alchemy.core.getAssetTransfers({
        fromBlock: "0x0",
        toBlock: "latest",
        toAddress: lowerAddress,
        category: ["erc20", "external"] as any,
        withMetadata: true,
      });

      for (const transfer of response.transfers) {
        if (transfer.hash) {
          const hashLower = transfer.hash.toLowerCase();
          uniqueTxHashes.add(hashLower);
          if (transfer.metadata?.blockTimestamp) {
            txTimestamps.set(hashLower, transfer.metadata.blockTimestamp);
          }
        }
      }
    }

    logger.info({ count: uniqueTxHashes.size }, "indexer: gathered unique transaction hashes to sync");

    // 2. Fetch full transaction receipts for each unique txHash
    const allParsedLogs: any[] = [];

    for (const txHash of uniqueTxHashes) {
      logger.info({ txHash }, "indexer: fetching receipt");
      const receipt = await alchemy.core.getTransactionReceipt(txHash);
      if (!receipt || !receipt.logs) continue;

      for (const log of receipt.logs) {
        const addressLower = log.address.toLowerCase();
        if (addressLower === routerAddress.toLowerCase() || watchedAddresses.has(addressLower)) {
          allParsedLogs.push(log);
        }
      }
    }

    // Sort logs chronologically by block number and log index
    allParsedLogs.sort((a, b) => {
      const aBlock = parseNumeric(a.blockNumber);
      const bBlock = parseNumeric(b.blockNumber);
      if (aBlock !== bBlock) return aBlock - bBlock;
      
      const aIndex = parseNumeric(a.logIndex);
      const bIndex = parseNumeric(b.logIndex);
      return aIndex - bIndex;
    });

    // 3. Process MarketCreated logs first
    const marketLogs = allParsedLogs.filter(log => {
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        return parsed && parsed.name === "MarketCreated";
      } catch {
        return false;
      }
    });

    const tradeLogs = allParsedLogs.filter(log => {
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        return parsed && parsed.name !== "MarketCreated";
      } catch {
        return false;
      }
    });

    logger.info({ count: marketLogs.length }, "indexer: enqueuing market creation logs first");
    for (const log of marketLogs) {
      await handleLog(log, txTimestamps.get(log.transactionHash.toLowerCase()));
    }

    // Wait until all markets are indexed in the database
    logger.info("indexer: waiting for database to index all on-chain markets...");
    let allIndexed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const countInDb = await prisma.market.count({
        where: { contractAddress: { in: marketsOnChain.map(m => m.toLowerCase()) } }
      });
      if (countInDb >= marketsOnChain.length) {
        allIndexed = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!allIndexed) {
      logger.warn("indexer: timeout waiting for all markets to be indexed, proceeding anyway");
    } else {
      logger.info("indexer: all on-chain markets successfully indexed in DB");
    }

    logger.info({ count: tradeLogs.length }, "indexer: enqueuing trade and resolution logs");
    for (const log of tradeLogs) {
      try {
        await handleLog(log, txTimestamps.get(log.transactionHash.toLowerCase()));
      } catch (err) {
        logger.error({ err, txHash: log.transactionHash }, "indexer: error processing log in backfill");
      }
    }

    logger.info("indexer: historical backfill completed successfully");
  } catch (err) {
    logger.error({ err }, "indexer: historical backfill failed");
  }
}

// ── Log dispatcher ────────────────────────────────────────────────────────────
async function handleLog(log: any, timestamp?: string) {
  let parsed: ethers.LogDescription | null = null;

  try {
    parsed = iface.parseLog({ topics: log.topics, data: log.data });
  } catch {
    return; // not one of our events
  }

  if (!parsed) return;

  const base = {
    txHash:      log.transactionHash,
    blockNumber: parseNumeric(log.blockNumber),
    logIndex:    parseNumeric(log.logIndex),
    contractAddress: log.address.toLowerCase(),
    timestamp:   timestamp || new Date().toISOString(),
  };

  switch (parsed.name) {
    case "MarketBuy":
      await tradeQueue.add(
        "buy",
        {
          ...base,
          direction: "BUY",
          buyer:     parsed.args.buyer.toLowerCase(),
          outcome:   parsed.args.isBuyYes ? "YES" : "NO",
          collateralIn: parsed.args.amountIn.toString(),
          tokensOut:    parsed.args.amountOut.toString(),
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

    case "MarketSell":
      await tradeQueue.add(
        "sell",
        {
          ...base,
          direction: "SELL",
          seller:    parsed.args.seller.toLowerCase(),
          outcome:   parsed.args.isSellYes ? "YES" : "NO",
          tokensIn:     parsed.args.amountIn.toString(),
          collateralOut: parsed.args.amountOut.toString(),
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
      // add new market and dynamically subscribe to its logs
      watchMarket(parsed.args.market);
      await marketQueue.add(
        "created",
        {
          ...base,
          event:            "created",
          marketId:         parsed.args.marketId,
          marketAddress:    parsed.args.market.toLowerCase(),
          creatorAddress:   parsed.args.creator.toLowerCase(),
          initialLiquidity: ethers.formatEther(parsed.args.liquidity),
        },
        { jobId: `${base.txHash}-${base.logIndex}` }
      );
      break;

    case "MarketResolvedByAdmin":
      await marketQueue.add(
        "resolved",
        {
          ...base,
          event:          "resolved",
          winningOutcome: parsed.args.outcome.toString() === "1" ? "YES" : "NO",
          resolver:       parsed.args.admin.toLowerCase(),
        },
        { jobId: `${base.txHash}-${base.logIndex}` }
      );
      break;
  }
}