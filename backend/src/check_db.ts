import { prisma } from "./lib/prisma";

async function main() {
  console.log("Checking DB connection and counts...");
  try {
    const markets = await prisma.market.findMany();
    console.log(`Markets count: ${markets.length}`);
    for (const m of markets) {
      console.log(`- Market: ${m.question} (${m.contractAddress})`);
    }

    const trades = await prisma.trade.findMany();
    console.log(`Trades count: ${trades.length}`);

    const snapshots = await prisma.priceSnapshot.findMany();
    console.log(`Price snapshots count: ${snapshots.length}`);
  } catch (err) {
    console.error("Error checking DB:", err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
