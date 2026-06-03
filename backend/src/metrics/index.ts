// backend/src/metrics/index.ts
import { Router }                                   from "express";
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

// Prometheus metrics registry definition
export const registry = new Registry();

// Collect default Node.js system metrics
collectDefaultMetrics({ register: registry });

// Counters
export const tradeCounter = new Counter({
  name:       "lvramm_trades_indexed_total",
  help:       "Total on-chain trades indexed by direction and outcome",
  labelNames: ["direction", "outcome"] as const,
  registers:  [registry],
});

export const cacheHitCounter = new Counter({
  name:       "lvramm_cache_hits_total",
  help:       "Redis cache hits by route",
  labelNames: ["route"] as const,
  registers:  [registry],
});

export const cacheMissCounter = new Counter({
  name:       "lvramm_cache_misses_total",
  help:       "Redis cache misses by route",
  labelNames: ["route"] as const,
  registers:  [registry],
});

export const authCounter = new Counter({
  name:       "lvramm_auth_attempts_total",
  help:       "SIWE auth attempts by result",
  labelNames: ["result"] as const,   // "success" | "failure"
  registers:  [registry],
});

export const rateLimitCounter = new Counter({
  name:       "lvramm_rate_limit_hits_total",
  help:       "Rate limit rejections by wallet",
  registers:  [registry],
});

// Gauges
export const wsConnectionsGauge = new Gauge({
  name:       "lvramm_ws_connections_active",
  help:       "Currently active WebSocket connections",
  labelNames: ["market_id"] as const,
  registers:  [registry],
});

export const queueDepthGauge = new Gauge({
  name:       "lvramm_queue_depth",
  help:       "BullMQ queue depth (waiting jobs) by queue name",
  labelNames: ["queue"] as const,
  registers:  [registry],
});

export const indexerBlockGauge = new Gauge({
  name:       "lvramm_indexer_last_block",
  help:       "Last block number processed by the indexer",
  registers:  [registry],
});

// Histograms
export const httpDurationHistogram = new Histogram({
  name:       "lvramm_http_request_duration_seconds",
  help:       "HTTP request duration in seconds by method, route, and status",
  labelNames: ["method", "route", "status"] as const,
  buckets:    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers:  [registry],
});

export const tradeIndexingDuration = new Histogram({
  name:    "lvramm_trade_indexing_duration_seconds",
  help:    "Time taken to fully index a trade event (DB write + Redis publish)",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

// HTTP latency tracker middleware
export function httpMetricsMiddleware(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  const end = httpDurationHistogram.startTimer();
  res.on("finish", () => {
    end({
      method: req.method,
      route:  req.route?.path ?? req.path,
      status: String(res.statusCode),
    });
  });
  next();
}

// REST route mapping
export const metricsRouter = Router();

metricsRouter.get("/", async (_req, res) => {
  try {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});