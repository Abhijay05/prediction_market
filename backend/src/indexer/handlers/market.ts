// backend/src/indexer/handlers/market.ts
import { Worker, Job } from "bullmq";
import { redis } from "../../cache/redis";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { Decimal } from "@prisma/client/runtime/library";

interface MarketJobData {
  txHash:          string;
  blockNumber:     number;
  logIndex:        number;
  contractAddress: string;
  event:           "created" | "resolved";
  // created fields
  marketId?:         string;
  marketAddress?:    string;
  creatorAddress?:   string;
  initialLiquidity?: string;
  // resolved fields
  winningOutcome?:   "YES" | "NO";
  resolver?:         string;
  resolutionSource?: "ADMIN" | "ORACLE" | "DISPUTE_VRF";
  oracleAnswer?:     string;
  oracleUpdatedAt?:  string;
}

export const marketWorker = new Worker<MarketJobData>(
  "index-market",
  async (job: Job<MarketJobData>) => {
    const data = job.data;
    const log  = logger.child({ txHash: data.txHash, event: data.event });

    if (data.event === "created") {
      const marketAddress = data.marketAddress!.toLowerCase();
      const creatorAddress = data.creatorAddress!.toLowerCase();
      const initialLiquidity = data.initialLiquidity ? new Decimal(data.initialLiquidity) : new Decimal("0");

      log.info({ marketAddress, creatorAddress }, "market handler: processing creation");

      // 1. Resolve or create Creator User
      let creator;
      try {
        creator = await prisma.user.upsert({
          where:  { walletAddress: creatorAddress },
          update: {},
          create: { walletAddress: creatorAddress, nonce: crypto.randomUUID() },
        });
      } catch (err: any) {
        if (err.code === "P2002") {
          creator = await prisma.user.findUniqueOrThrow({
            where: { walletAddress: creatorAddress }
          });
        } else {
          throw err;
        }
      }

      // 2. Query blockchain for metadata with graceful fallbacks
      let question = "On-Chain Prediction Market";
      let description = "A decentralized prediction market created via LvrAMM Router.";
      let expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days fallback
      let collateralToken = "0x0000000000000000000000000000000000000000";
      let yesReserve = new Decimal("0");
      let noReserve = new Decimal("0");

      try {
        const { Alchemy, Network } = await import("alchemy-sdk");
        const { ethers } = await import("ethers");

        const alchemy = new Alchemy({
          apiKey: process.env.ALCHEMY_API_KEY!,
          network: Network.ETH_SEPOLIA,
        });

        const provider = await alchemy.config.getProvider();

        // ABI fragment to fetch reserves, tokens, and deadline
        const marketAbi = [
          "function i_collateral() view returns (address)",
          "function deadline() view returns (uint256)",
          "function getReserves() view returns (uint256, uint256)",
        ];
        const marketContract = new ethers.Contract(marketAddress, marketAbi, provider as any);

        const [collateralCall, deadlineCall, reservesCall] = await Promise.allSettled([
          marketContract.i_collateral(),
          marketContract.deadline(),
          marketContract.getReserves(),
        ]);

        if (collateralCall.status === "fulfilled") collateralToken = collateralCall.value.toLowerCase();
        if (deadlineCall.status === "fulfilled") expiresAt = new Date(Number(deadlineCall.value) * 1000);
        if (reservesCall.status === "fulfilled") {
          yesReserve = new Decimal(ethers.formatEther(reservesCall.value[0]));
          noReserve = new Decimal(ethers.formatEther(reservesCall.value[1]));
        }

        // Try to fetch metadata from Router: getMarketMetadata(bytes32 marketId) -> (address market, uint256 liquidity, string title, string description, string resolutionSource)
        const routerAddress = process.env.ROUTER_ADDRESS;
        if (routerAddress && data.marketId) {
          const routerAbi = [
            "function getMarketMetadata(bytes32) view returns (address, uint256, string, string, string)",
          ];
          const routerContract = new ethers.Contract(routerAddress, routerAbi, provider as any);
          const metadataCall = await routerContract.getMarketMetadata(data.marketId);
          if (metadataCall && metadataCall[2]) {
            question = metadataCall[2];
            description = metadataCall[3];
          }
        }
      } catch (err) {
        log.warn({ err }, "market handler: RPC fetch failed or incomplete, using seed fallbacks");
      }

      // 3. Upsert Market row (idempotent)
      const market = await prisma.market.upsert({
        where:  { contractAddress: marketAddress },
        update: {},
        create: {
          contractAddress:  marketAddress,
          routerAddress:    process.env.ROUTER_ADDRESS || "0x0000000000000000000000000000000000000000",
          question,
          description,
          collateralToken,
          initialLiquidity,
          yesReserve:       yesReserve.gt(0) ? yesReserve : initialLiquidity,
          noReserve:        noReserve.gt(0)  ? noReserve  : initialLiquidity,
          totalVolume:      "0",
          totalLiquidity:   initialLiquidity,
          createdAtBlock:   data.blockNumber,
          expiresAt,
          creatorId:        creator.id,
        },
      });

      log.info({ marketId: market.id }, "market handler: market successfully indexed");
    }

    else if (data.event === "resolved") {
      const contractAddress = data.contractAddress.toLowerCase();
      const winningOutcome = data.winningOutcome!;
      const resolver = data.resolver!.toLowerCase();

      log.info({ contractAddress, winningOutcome, resolver }, "market handler: processing resolution");

      const market = await prisma.market.findUnique({
        where: { contractAddress },
      });

      if (!market) {
        log.warn("market handler: resolved market not found in DB, skipping");
        return;
      }

      // Update Market status to RESOLVED
      await prisma.market.update({
        where: { id: market.id },
        data: {
          status:         "RESOLVED",
          winningOutcome,
          resolvedAt:     new Date(),
          updatedAt:      new Date(),
        },
      });

      await prisma.resolutionEvent.upsert({
        where:  { marketId: market.id },
        update: {},
        create: {
          marketId:       market.id,
          winningOutcome,
          resolvedBy:     resolver,
          source:         data.resolutionSource ?? "ADMIN",
          txHash:         data.txHash,
          blockNumber:    data.blockNumber,
          oracleAnswer:   data.oracleAnswer,
          oracleUpdatedAt: data.oracleUpdatedAt ? new Date(data.oracleUpdatedAt) : undefined,
        },
      });

      // Invalidate cache
      await redis.del(`cache:market:${market.id}`);
      await redis.del("cache:markets");

      log.info({ marketId: market.id }, "market handler: market successfully resolved");
    }
  },
  {
    connection: redis as any,
    concurrency: 2,
  }
);

marketWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "market worker: job failed");
});

marketWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "market worker: job completed");
});
