import { Worker, Job } from "bullmq";
import { Decimal } from "@prisma/client/runtime/library";
import { redis } from "../../cache/redis";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { ethers } from "ethers";

// ── Types ─────────────────────────────────────────────────────────────────────
interface TradeJobData {
  txHash:          string;
  blockNumber:     number;
  logIndex:        number;
  contractAddress: string;
  direction:       "BUY" | "SELL";
  outcome:         "YES" | "NO";
  timestamp?:      string;
  // BUY fields
  buyer?:        string;
  collateralIn?: string;
  tokensOut?:    string;
  // SELL fields
  seller?:        string;
  tokensIn?:      string;
  collateralOut?: string;
}

// ── Worker ────────────────────────────────────────────────────────────────────
export const tradeWorker = new Worker<TradeJobData>(
  "index-trade",
  async (job: Job<TradeJobData>) => {
    const data = job.data;
    const log  = logger.child({ txHash: data.txHash, job: job.name });

    // 1. Resolve market row from contract address
    const market = await prisma.market.findUnique({
      where: { contractAddress: data.contractAddress },
    });
    if (!market) {
      log.warn("trade handler: market not found, skipping");
      return;
    }

    // 2. Resolve user row (upsert by wallet address)
    const walletAddress = (data.buyer ?? data.seller)!;
    let user;
    try {
      user = await prisma.user.upsert({
        where:  { walletAddress },
        update: {},
        create: { walletAddress, nonce: crypto.randomUUID() },
      });
    } catch (err: any) {
      if (err.code === "P2002") {
        user = await prisma.user.findUniqueOrThrow({
          where: { walletAddress }
        });
      } else {
        throw err;
      }
    }

    // 3. Compute derived fields
    const isBuy          = data.direction === "BUY";
    const collateral     = BigInt(isBuy ? data.collateralIn! : data.collateralOut!);
    const tokens         = BigInt(isBuy ? data.tokensOut!   : data.tokensIn!);
    const avgPrice       = tokens > 0n
      ? Number(collateral) / Number(tokens)
      : 0;

    // 4. Fetch current reserves and prices from the contract
    const {
      yesPriceBefore,
      noPriceBefore,
      yesPriceAfter,
      noPriceAfter,
      yesReserveAfter,
      noReserveAfter
    } = await fetchReservesAroundTx(data.contractAddress, data.blockNumber, data.txHash);

    const priceImpact = yesPriceBefore > 0
      ? Math.abs((yesPriceAfter - yesPriceBefore) / yesPriceBefore)
      : 0;

    const tradeTime = data.timestamp ? new Date(data.timestamp) : new Date();

    // 5. Upsert Trade row (idempotent via @@unique[txHash, logIndex])
    const trade = await prisma.trade.upsert({
      where:  { txHash_logIndex: { txHash: data.txHash, logIndex: data.logIndex } },
      update: {},
      create: {
        txHash:        data.txHash,
        blockNumber:   data.blockNumber,
        logIndex:      data.logIndex,
        direction:     data.direction,
        outcome:       data.outcome,
        collateralIn:  isBuy  ? ethers.formatEther(collateral) : "0",
        tokenAmount:   ethers.formatEther(tokens),
        avgPrice:      avgPrice.toString(),
        yesPriceBefore: yesPriceBefore.toString(),
        noPriceBefore:  noPriceBefore.toString(),
        yesPriceAfter:  yesPriceAfter.toString(),
        noPriceAfter:   noPriceAfter.toString(),
        priceImpact:    priceImpact.toString(),
        marketId:       market.id,
        traderId:       user.id,
        createdAt:      tradeTime,
      },
    });

    log.info({ tradeId: trade.id }, "trade handler: trade upserted");

    // 6. Update Position aggregate (upsert one row per user+market)
    await updatePosition({
      userId:      user.id,
      marketId:    market.id,
      direction:   data.direction,
      outcome:     data.outcome,
      collateral,
      tokens,
    });

    // 7. Update Market volume + reserves
    await prisma.market.update({
      where: { id: market.id },
      data: {
        totalVolume:  { increment: ethers.formatEther(collateral) },
        yesReserve:   yesReserveAfter.toString(),
        noReserve:    noReserveAfter.toString(),
        updatedAt:    new Date(),
      },
    });

    // 8. Publish price update to Redis for WebSocket fan-out (supporting both UUID and contract address rooms)
    const pricePayload = JSON.stringify({
      marketId:  market.contractAddress.toLowerCase(),
      yesPrice:  yesPriceAfter,
      noPrice:   noPriceAfter,
      timestamp: tradeTime.getTime(),
      txHash:    data.txHash,
    });
    
    await redis.set(`prices:${market.id}:latest`, pricePayload);
    await redis.set(`prices:${market.contractAddress.toLowerCase()}:latest`, pricePayload);
    
    await redis.publish(`prices:${market.id}`, pricePayload);
    await redis.publish(`prices:${market.contractAddress.toLowerCase()}`, pricePayload);

    // 9. Invalidate cached market data
    await redis.del(`cache:market:${market.id}`);
    await redis.del(`cache:market:${market.contractAddress.toLowerCase()}`);
    await redis.del("cache:markets");

    log.info("trade handler: complete");
  },
  {
    connection: redis as any,
    concurrency: 5,
  }
);

// ── Position aggregate updater ────────────────────────────────────────────────
async function updatePosition({
  userId, marketId, direction, outcome, collateral, tokens,
}: {
  userId:    string;
  marketId:  string;
  direction: "BUY" | "SELL";
  outcome:   "YES" | "NO";
  collateral: bigint;
  tokens:     bigint;
}) {
  const existing = await prisma.position.findUnique({
    where: { userId_marketId: { userId, marketId } },
  });

  if (!existing) {
    await prisma.position.create({
      data: {
        userId,
        marketId,
        yesTokens:     outcome === "YES" && direction === "BUY" ? ethers.formatEther(tokens) : "0",
        noTokens:      outcome === "NO"  && direction === "BUY" ? ethers.formatEther(tokens) : "0",
        totalSpent:    direction === "BUY"  ? ethers.formatEther(collateral) : "0",
        totalReceived: direction === "SELL" ? ethers.formatEther(collateral) : "0",
      },
    });
    return;
  }

  // running totals parsed back to BigInt wei to stay precise
  const yesTokens = ethers.parseEther(existing.yesTokens.toString());
  const noTokens  = ethers.parseEther(existing.noTokens.toString());
  const totalSpent = ethers.parseEther(existing.totalSpent.toString());
  const totalReceived = ethers.parseEther(existing.totalReceived.toString());

  const newYes = outcome === "YES"
    ? direction === "BUY" ? yesTokens + tokens : yesTokens - tokens
    : yesTokens;
  const newNo = outcome === "NO"
    ? direction === "BUY" ? noTokens + tokens : noTokens - tokens
    : noTokens;

  const newSpent = direction === "BUY" ? totalSpent + collateral : totalSpent;
  const newReceived = direction === "SELL" ? totalReceived + collateral : totalReceived;

  await prisma.position.update({
    where: { userId_marketId: { userId, marketId } },
    data: {
      yesTokens:     ethers.formatEther(newYes),
      noTokens:      ethers.formatEther(newNo),
      totalSpent:    ethers.formatEther(newSpent),
      totalReceived: ethers.formatEther(newReceived),
      updatedAt: new Date(),
    },
  });
}

// ── Reserve & Price fetcher (Alchemy eth_call on prev + current block) ────────────────
async function fetchReservesAroundTx(
  contractAddress: string,
  blockNumber: number,
  _txHash: string
): Promise<{
  yesPriceBefore: number;
  noPriceBefore: number;
  yesPriceAfter: number;
  noPriceAfter: number;
  yesReserveBefore: number;
  noReserveBefore: number;
  yesReserveAfter: number;
  noReserveAfter: number;
}> {
  const { Alchemy, Network } = await import("alchemy-sdk");
  const { ethers } = await import("ethers");

  const alchemy = new Alchemy({
    apiKey: process.env.ALCHEMY_API_KEY!,
    network: Network.ETH_SEPOLIA,
  });

  const provider = await alchemy.config.getProvider();

  // getMarketDetails() returns currentState (uint8), deadline (uint256), outcome (uint256), liquidity (uint256),
  // reserveYes (uint256), reserveNo (uint256), priceYes (uint256), priceNo (uint256)
  const getMarketDetailsData = ethers.id("getMarketDetails()").slice(0, 10);

  const callMarketDetails = async (block: number) => {
    const raw = await provider.call(
      { to: contractAddress, data: getMarketDetailsData },
      block
    );
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
      raw
    );
    return {
      yesReserve: Number(ethers.formatEther(decoded[4])),
      noReserve:  Number(ethers.formatEther(decoded[5])),
      yesPrice:   Number(ethers.formatEther(decoded[6])),
   
      noPrice:    Number(ethers.formatEther(decoded[7])),
    };
  };

  const callMarketDetailsSafe = async (block: number) => {
    try {
      return await callMarketDetails(block);
    } catch {
      return {
        yesReserve: 0.0,
        noReserve:  0.0,
        yesPrice:   0.5,
        noPrice:    0.5,
      };
    }
  };

  const [before, after] = await Promise.all([
    callMarketDetailsSafe(blockNumber - 1),
    callMarketDetailsSafe(blockNumber),
  ]);

  return {
    yesPriceBefore:   before.yesPrice,
    noPriceBefore:    before.noPrice,
    yesPriceAfter:    after.yesPrice,
    noPriceAfter:     after.noPrice,
    yesReserveBefore: before.yesReserve,
    noReserveBefore:  before.noReserve,
    yesReserveAfter:  after.yesReserve,
    noReserveAfter:   after.noReserve,
  };
}

// ── Error handling ────────────────────────────────────────────────────────────
tradeWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "trade worker: job failed");
});

tradeWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "trade worker: job completed");
});