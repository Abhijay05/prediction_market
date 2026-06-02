import { prisma } from "./lib/prisma";

async function main() {
  console.log("Truncating/Deleting all records from database tables...");
  try {
    // Delete snapshots first
    await prisma.priceSnapshot.deleteMany({});
    console.log("Deleted price snapshots");

    await prisma.resolutionEvent.deleteMany({});
    console.log("Deleted resolution events");

    await prisma.trade.deleteMany({});
    console.log("Deleted trades");

    await prisma.position.deleteMany({});
    console.log("Deleted positions");

    await prisma.market.deleteMany({});
    console.log("Deleted markets");

    await prisma.user.deleteMany({});
    console.log("Deleted users");

    console.log("Database cleared successfully!");
  } catch (err) {
    console.error("Error cleaning DB:", err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
