// backend/tests/setup.ts

// 1. Mock Redis
jest.mock("../src/cache/redis", () => {
  return {
    redis: {
      get: jest.fn(),
      set: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      publish: jest.fn(),
      psubscribe: jest.fn(),
      on: jest.fn(),
    },
    redisSub: {
      psubscribe: jest.fn(),
      on: jest.fn(),
    },
  };
});

// 2. Mock Prisma
jest.mock("../src/lib/prisma", () => {
  return {
    prisma: {
      market: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      trade: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      position: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      priceSnapshot: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
    },
  };
});