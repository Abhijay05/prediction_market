// backend/src/api/middleware/cache.ts
import { Request, Response, NextFunction } from "express";
import { redis } from "../../cache/redis";

export function cacheMiddleware(ttlSecs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key    = `cache:${req.originalUrl}`;
    const cached = await redis.get(key);

    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.json(JSON.parse(cached));
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      redis.setex(key, ttlSecs, JSON.stringify(body));
      res.setHeader("X-Cache", "MISS");
      return originalJson(body);
    };

    next();
  };
}