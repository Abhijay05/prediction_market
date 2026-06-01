// backend/src/api/middleware/rateLimit.ts
import { Request, Response, NextFunction } from "express";
import { redis } from "../../cache/redis";

const WINDOW_SECS  = 60;
const MAX_REQUESTS = 10;

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const wallet = (req as any).user?.walletAddress ?? req.ip;
  const key    = `ratelimit:${wallet}`;

  const current = await redis.incr(key);
  if (current === 1) await redis.expire(key, WINDOW_SECS);

  res.setHeader("X-RateLimit-Limit",     MAX_REQUESTS);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, MAX_REQUESTS - current));

  if (current > MAX_REQUESTS)
    return res.status(429).json({ error: "rate limit exceeded — 10 req/min" });

  next();
}