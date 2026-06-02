// backend/src/api/index.ts
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { marketsRouter } from "./routes/markets";
import { metricsRouter, httpMetricsMiddleware } from "../metrics/index";
import { createWsServer } from "../ws/server";
import { authMiddleware } from "./middleware/auth";
import { logger } from "../lib/logger";

export const app = express();

// Standard middleware
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL ?? "*" }));
app.use(express.json());

// Metrics middleware (Prometheus)
app.use(httpMetricsMiddleware);

// Routes
app.use("/metrics", metricsRouter);
app.use("/api/markets", marketsRouter);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date() });
});

// Authentication endpoint
app.post("/api/auth/verify", (req, res) => {
  const { message, signature } = req.body;
  if (!message || !signature) {
    return res.status(400).json({ error: "message and signature required" });
  }
  // TODO: implement real SIWE verification using Ethers.js
  res.json({ token: "stub-jwt-token" });
});

// User portfolio (protected)
app.get("/api/portfolio", authMiddleware, (req, res) => {
  res.json({ positions: [] });
});

// Global trade feed (protected)
app.get("/api/trades", authMiddleware, (req, res) => {
  res.json({ trades: [] });
});

// Start servers if run directly (and not in test mode)
if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
  const WS_PORT = PORT + 1; // e.g. 3002

  app.listen(PORT, () => {
    logger.info({ port: PORT }, "api: express server started");
  });

  createWsServer(WS_PORT);
}
