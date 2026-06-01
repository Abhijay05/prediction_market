// backend/src/cache/redis.ts
import IORedis from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

// Main client — used for get/set/del/pub
export const redis = new IORedis(url, {
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,
  lazyConnect: false,
});

// Dedicated subscriber client (can't share with command client)
export const redisSub = new IORedis(url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,
});

redis.on("connect",      () => console.log("[redis] connected"));
redis.on("error",  (err) => console.error("[redis] error", err));
redisSub.on("error",(err) => console.error("[redis-sub] error", err));