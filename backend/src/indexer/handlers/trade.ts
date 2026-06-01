import { Worker, Job } from "bullmq";
import { Decimal } from "@prisma/client/runtime/library";
import { redis } from "../../cache/redis";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

// ── Types ─────────────────────────────────────────────────────────────────────
interface TradeJobData {
  txHash:          string;
  blockNumber:     number;
  logIndex:        number;
  contractAddress: string;
  direction:       "BUY" | "SELL";
  outcome:         "YES" | "NO";
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
    const user = await prisma.user.upsert({
      where:  { walletAddress },
      update: {},
      create: { walletAddress, nonce: crypto.randomUUID() },
    });

    // 3. Compute derived fields
    const isBuy          = data.direction === "BUY";
    const collateral     = BigInt(isBuy ? data.collateralIn! : data.collateralOut!);
    const tokens         = BigInt(isBuy ? data.tokensOut!   : data.tokensIn!);
    const avgPrice       = tokens > 0n
      ? Number(collateral) / Number(tokens)
      : 0;

    // 4. Fetch current reserves from the contract for price context
    const { yesBefore, noBefore, yesAfter, noAfter } =
      await fetchReservesAroundTx(data.contractAddress, data.blockNumber, data.txHash);

    const priceImpact = yesBefore > 0
      ? Math.abs((yesAfter - yesBefore) / yesBefore)
      : 0;

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
        collateralIn:  isBuy  ? collateral.toString() : "0",
        tokenAmount:   tokens.toString(),
        avgPrice:      avgPrice.toString(),
        yesPriceBefore: yesBefore.toString(),
        noPriceBefore:  noBefore.toString(),
        yesPriceAfter:  yesAfter.toString(),
        noPriceAfter:   noAfter.toString(),
        priceImpact:    priceImpact.toString(),
        marketId:       market.id,
        traderId:       user.id,
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
        totalVolume:  { increment: collateral.toString() },
        yesReserve:   yesAfter.toString(),
        noReserve:    noAfter.toString(),
        updatedAt:    new Date(),
      },
    });

    // 8. Publish price update to Redis for WebSocket fan-out
    const pricePayload = JSON.stringify({
      marketId:  market.id,
      yesPrice:  yesAfter,
      noPrice:   noAfter,
      timestamp: Date.now(),
      txHash:    data.txHash,
    });
    await redis.publish(`prices:${market.id}`, pricePayload);

    // 9. Invalidate cached market data
    await redis.del(`cache:market:${market.id}`);
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
        yesTokens:     outcome === "YES" && direction === "BUY" ? tokens.toString() : "0",
        noTokens:      outcome === "NO"  && direction === "BUY" ? tokens.toString() : "0",
        totalSpent:    direction === "BUY"  ? collateral.toString() : "0",
        totalReceived: direction === "SELL" ? collateral.toString() : "0",
      },
    });
    return;
  }

  // running totals using BigInt to stay precise
  const yesTokens = BigInt(existing.yesTokens.toString());
  const noTokens  = BigInt(existing.noTokens.toString());

  const newYes = outcome === "YES"
    ? direction === "BUY" ? yesTokens + tokens : yesTokens - tokens
    : yesTokens;
  const newNo = outcome === "NO"
    ? direction === "BUY" ? noTokens + tokens : noTokens - tokens
    : noTokens;

  // realizedPnl: on sell, pnl = collateralOut - costBasis for those tokens
  // simplified: track totalReceived and compare to totalSpent at redemption time
  await prisma.position.update({
    where: { userId_marketId: { userId, marketId } },
    data: {
      yesTokens:     newYes.toString(),
      noTokens:      newNo.toString(),
      totalSpent:    direction === "BUY"
        ? { increment: collateral.toString() }
        : undefined,
      totalReceived: direction === "SELL"
        ? { increment: collateral.toString() }
        : undefined,
      updatedAt: new Date(),
    },
  });
}

// ── Reserve fetcher (Alchemy eth_call on prev + current block) ────────────────
async function fetchReservesAroundTx(
  contractAddress: string,
  blockNumber: number,
  _txHash: string
): Promise<{ yesBefore: number; noBefore: number; yesAfter: number; noAfter: number }> {
  const { Alchemy, Network } = await import("alchemy-sdk");
  const { ethers } = await import("ethers");

  const alchemy = new Alchemy({
    apiKey: process.env.ALCHEMY_API_KEY!,
    network: Network.ETH_SEPOLIA,
  });

  const provider = await alchemy.config.getProvider();

  // getReserves() → (uint256 yesReserve, uint256 noReserve)
  const getReservesData = ethers.id("getReserves()").slice(0, 10);

  const callReserves = async (block: number) => {
    const raw = await provider.call(
      { to: contractAddress, data: getReservesData },
      block
    );
    const [yes, no] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint256"], raw
    );
    // price = yesReserve / (yesReserve + noReserve)
    const total = Number(yes) + Number(no);
    return {
      yes: total > 0 ? Number(yes) / total : 0.5,
      no:  total > 0 ? Number(no)  / total : 0.5,
    };
  };

  const [before, after] = await Promise.all([
    callReserves(blockNumber - 1),
    callReserves(blockNumber),
  ]);

  return {
    yesBefore: before.yes,
    noBefore:  before.no,
    yesAfter:  after.yes,
    noAfter:   after.no,
  };
}

// ── Error handling ────────────────────────────────────────────────────────────
tradeWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "trade worker: job failed");
});

tradeWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "trade worker: job completed");
});