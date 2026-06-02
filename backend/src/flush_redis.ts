import { redis } from "./cache/redis";

async function main() {
  console.log("Flushing all Redis keys...");
  try {
    await redis.flushall();
    console.log("Redis database flushed successfully!");
  } catch (err) {
    console.error("Error flushing Redis:", err);
  } finally {
    process.exit(0);
  }
}

main();
