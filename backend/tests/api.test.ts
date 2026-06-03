// backend/tests/api.test.ts
import request from "supertest";
import { app }    from "../src/api/index";
import { prisma } from "../src/lib/prisma";
import { redis }  from "../src/cache/redis";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockRedis  = redis  as jest.Mocked<typeof redis>;

// GET /api/markets tests
describe("GET /api/markets", () => {
  beforeEach(() => {
    (mockRedis.get as jest.Mock).mockResolvedValue(null);
    (mockRedis.setex as jest.Mock).mockResolvedValue("OK");
    (mockPrisma.market.findMany as jest.Mock).mockResolvedValue([
      {
        id: "market-1", contractAddress: "0xabc", question: "Will ETH hit $5k?",
        category: "crypto", status: "ACTIVE",
        yesReserve: "500000000000000000000",
        noReserve:  "500000000000000000000",
        totalVolume: "0", expiresAt: new Date(), winningOutcome: null,
      },
    ]);
  });

  it("returns 200 with markets array", async () => {
    const res = await request(app).get("/api/markets");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty("yesPrice");
  });

  it("returns X-Cache: MISS on first call", async () => {
    const res = await request(app).get("/api/markets");
    expect(res.headers["x-cache"]).toBe("MISS");
  });

  it("returns X-Cache: HIT when cached", async () => {
    (mockRedis.get as jest.Mock).mockResolvedValue(JSON.stringify([{ id: "market-1" }]));
    const res = await request(app).get("/api/markets");
    expect(res.headers["x-cache"]).toBe("HIT");
  });
});

// GET /api/markets/:id tests
describe("GET /api/markets/:id", () => {
  it("returns 404 for unknown market", async () => {
    (mockRedis.get as jest.Mock).mockResolvedValue(null);
    (mockPrisma.market.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get("/api/markets/nonexistent");
    expect(res.status).toBe(404);
  });
});

// GET /api/markets/:id/ohlcv tests
describe("GET /api/markets/:id/ohlcv", () => {
  it("returns 400 for invalid interval param", async () => {
    (mockRedis.get as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get("/api/markets/abc/ohlcv?interval=bad");
    expect(res.status).toBe(400);
  });

  it("returns empty candles when market is not yet indexed in database", async () => {
    (mockRedis.get as jest.Mock).mockResolvedValue(null);
    (mockPrisma.market.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get("/api/markets/abc/ohlcv?interval=5m");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("candles");
    expect(res.body.candles.length).toBe(0);
  });

  it("returns candles array on success", async () => {
    (mockRedis.get as jest.Mock).mockResolvedValue(null);
    (mockRedis.setex as jest.Mock).mockResolvedValue("OK");
    (mockPrisma.market.findFirst as jest.Mock).mockResolvedValue({ id: "m1", question: "test", status: "ACTIVE" });
    (mockPrisma.priceSnapshot.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(app).get("/api/markets/m1/ohlcv?interval=5m");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("candles");
    expect(Array.isArray(res.body.candles)).toBe(true);
  });
});

// POST /api/auth/verify tests
describe("POST /api/auth/verify", () => {
  it("returns 400 with empty body", async () => {
    const res = await request(app).post("/api/auth/verify").send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when message missing", async () => {
    const res = await request(app).post("/api/auth/verify").send({ signature: "0xsig" });
    expect(res.status).toBe(400);
  });
});

// Protected routes validation tests
describe("Protected routes (no token)", () => {
  it("GET /api/portfolio returns 401 without token", async () => {
    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(401);
  });

  it("GET /api/trades returns 401 without token", async () => {
    const res = await request(app).get("/api/trades");
    expect(res.status).toBe(401);
  });
});