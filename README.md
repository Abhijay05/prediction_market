<div align="center">

# 🔮 LvrAMM
### Next-Gen Prediction Market AMM with LVR Protection & Real-Time Analytics

[![Solidity](https://img.shields.io/badge/Solidity-%5E0.8.19-363636?logo=solidity)](https://soliditylang.org)
[![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react)](https://react.dev)
[![Foundry](https://img.shields.io/badge/Built%20with-Foundry-orange)](https://book.getfoundry.sh)
[![Wagmi](https://img.shields.io/badge/Wagmi-Viem-blue)](https://wagmi.sh)
[![Redis](https://img.shields.io/badge/Redis-v7-red?logo=redis)](https://redis.io)
[![Prometheus](https://img.shields.io/badge/Prometheus-v2-E6522C?logo=prometheus)](https://prometheus.io)
[![Grafana](https://img.shields.io/badge/Grafana-v10-F46800?logo=grafana)](https://grafana.com)
[![Chainlink](https://img.shields.io/badge/Chainlink-Price%20Feeds%20%2B%20VRF-375BD2?logo=chainlink)](https://chain.link)
[![The Graph](https://img.shields.io/badge/The%20Graph-Subgraph-6747ED?logo=thegraph)](https://thegraph.com)
[![1inch](https://img.shields.io/badge/1inch-Aqua-1B314F?logo=1inch)](https://1inch.io)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**[🚀 Quick Start](#-installation--setup) • [📖 Features](#-key-features) • [🏆 ETHOnline 2026](#-ethonline-2026--continuity-submission) • [🧠 System Architecture](#-system-architecture) • [🧪 Testing](#-testing) • [📈 Telemetry](#-observability--telemetry)**

Built with ❤️ by **Team CipherText**
</div>

---

## 🏆 ETHOnline 2026 — Continuity Submission

This project is pre-existing work (built May–June 2026); the sections below describe
that original build. **Three sponsor integrations were added during ETHOnline 2026**:

- **Chainlink** — Price Feeds auto-resolve objective markets with no admin involved;
  VRF replaces what used to be a dead end when a market's outcome was disputed.
- **The Graph** — a subgraph indexes the platform's markets/trades, and a risk-monitor
  agent cross-references it against the Chainlink feed to flag AMM/oracle divergence
  near a market's deadline.
- **1inch Aqua** — idle post-resolution collateral can earn swap fees via a
  non-custodial Aqua strategy, deliberately kept isolated from the live redemption path.

Full pre-existing/new breakdown: **[`CONTINUITY.md`](./CONTINUITY.md)**. Diagram of the
whole system, old and new: **[`ARCHITECTURE.md`](./ARCHITECTURE.md)**.

---

## 🎯 What is LvrAMM?

**LvrAMM** is a decentralized prediction market platform built on a specialized Automated Market Maker (AMM) design optimized to mitigate **Loss-Versus-Rebalancing (LVR)**. Traditional AMMs suffer major arbitrage losses when external asset prices shift faster than liquidity providers (LPs) can update their ranges. In binary outcome markets (YES/NO tokens), this issue is amplified due to highly discrete price adjustments and asymmetric information flow.

LvrAMM addresses these inefficiencies by pairing a high-performance **Solidity Smart Contract Router Suite** on Ethereum Sepolia with a **Real-Time Data Indexing Engine** powered by WebSockets, BullMQ, Redis Pub/Sub, and Prometheus/Grafana telemetry. 

---

## 🖼️ Live Interface & Charting

### 📈 Premium Real-Time Step-Area Chart (WebSockets & Redis)
![Live Charting](./assets/live_charting.png)

### 🖥️ Dashboard Showcase
<div align="center">

| | |
|:-------------------------:|:-------------------------:|
| ![Market List](./assets/live_markets.png) <br> **Live Markets Dashboard** | ![Trading](./assets/trading_interface.png) <br> **Outcome Trading Interface** |
| ![Create](./assets/market%20creation.png) <br> **Permissionless Market Creation** | ![Portfolio](./assets/dashboard.png) <br> **User Balance & Position Dashboard** |

</div>

---

## 🧠 System Architecture

The project is structured as a robust hub-and-spoke model. The smart contracts guarantee trustless execution and solvency, while the indexing and transport layers ensure the UI mirrors on-chain movements instantly without polling APIs.

> This diagram covers the original, pre-existing system. See
> **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** for the full picture including the
> Chainlink/Graph/Aqua integrations added during ETHOnline 2026.

```mermaid
graph TD
  subgraph "Blockchain (Sepolia Testnet)"
    Router[Router.sol]
    PM[LvrMarket.sol]
    Trader[User Wallet]
  end

  subgraph "Indexing Engine (NodeJS + BullMQ)"
    Alchemy[Alchemy WebSocket Event Stream]
    Listener[Indexer Listener]
    RedisQ[(Redis BullMQ Broker)]
    Worker[Queue Worker]
    PG[(Neon PostgreSQL)]
    RedisPub[(Redis Pub/Sub)]
  end

  subgraph "REST & Live Feeds"
    API[Express REST API]
    WSS[WebSocket Server]
  end

  subgraph "Frontend dApp (React + TS)"
    Frontend[Vite React client]
  end

  subgraph "Telemetry Stack"
    Metrics[Express Metrics Middleware]
    Prometheus[(Prometheus DB)]
    Grafana[Grafana Dashboard]
  end

  %% Connections
  Router -->|Deploys| PM
  Trader -->|Buy/Sell Shares| PM
  Frontend -->|Executes Swaps| Router

  Alchemy -->|Tx Event Logs| Listener
  Listener -->|Enqueues Job| RedisQ
  Worker -->|Dequeues Job| RedisQ
  Worker -->|Writes Trades & Snapshots| PG
  Worker -->|Publishes Price Updates| RedisPub

  API -->|Queries OHLCV & Markets| PG
  API -->|Caches Requests| RedisPub
  WSS -->|Subscribes prices:*| RedisPub
  WSS -->|Broadcasts Live Tick Data| Frontend

  Frontend -->|Connects ws://| WSS
  Frontend -->|Queries /ohlcv| API

  Metrics -->|Pushes stats| Prometheus
  Grafana -->|Queries| Prometheus
```

---

## ✨ Key Features

### 💎 Smart Contracts (Foundry Stack)
- **Centralized Router Gateway**: `Router.sol` standardizes market deployment parameters, prevents arbitrary outcome exploits, and acts as the secure entry point for trade executions.
- **Outcome Share Tokenization**: Fully compliant ERC20 YES/NO outcome tokens are minted dynamically upon adding liquidity or executing trades.
- **Precision Mathematics**: Implements 18-decimal precision accounting for shares, reserves, and pool collateral (using standard ERC20 collateral mock tokens like `mUSD`), eliminating mathematical dust leakage.
- **Three resolution paths**: the original optimistic propose/dispute flow with an admin fallback, plus two added during ETHOnline 2026 — permissionless Chainlink Price Feed resolution for objective markets, and Chainlink VRF picking a fair, unpredictable resolver when a market is disputed instead of it always falling back to admin. See `CONTINUITY.md` for the full breakdown.

### ⚡ Real-Time Indexing & WebSockets
- **Bulletproof Event Pipeline**: Listens to on-chain market swaps in real time via an Alchemy WebSockets listener, queuing jobs asynchronously with **BullMQ** to prevent backend bottlenecks during high transaction volumes.
- **Redis Pub/Sub Transport**: The indexer processes events and pushes price payloads to Redis, which triggers the WebSocket server to immediately broadcast updates to active clients.
- **Dynamic Connection Management**: The frontend features a custom `useWebSocket` hook that handles connection states, room subscriptions based on lowercased contract addresses, and a **10-attempt exponential backoff reconnect policy**.

### 📊 Advanced Data Analytics
- **Step-Area Rendering**: Since prediction markets behave as step functions rather than continuous equities, the dashboard implements a highly premium Step-Area series styled dynamically:
  - Turns **Green** on positive intervals.
  - Turns **Red** on negative intervals.
  - Automatically scales using cents (`¢`) formatting (e.g. `56.3¢` YES price).
- **Timezone Correction**: Dynamically shifts Unix timestamp data from the server into **Indian Standard Time (IST, UTC+5:30)** on the client, ensuring consistent charting global timezones.
- **Intelligent Time-Series Gap Filling**: Fills time gaps during low trading volumes by carrying forward the last recorded closing price, ensuring clean continuous charts.

---

## 🏗️ Technical Stack

| Layer | Component | Technology / Stack |
| :--- | :--- | :--- |
| **Smart Contracts** | Development Environment | Solidity v0.8.19, Foundry (Forge/Cast) |
| **Frontend UI** | Framework & Styling | React v18, Vite, TypeScript, Vanilla CSS |
| **State & Hooks** | Web3 Connector | Wagmi v2, Viem, TanStack Query |
| **Backend Engine** | API Server & Worker | Node.js, Express, TypeScript, Prisma ORM |
| **Database** | Primary Relational Storage | Serverless Neon PostgreSQL |
| **Caching & Queues** | Queue & Message Broker | Redis v7, BullMQ |
| **Monitoring** | Telemetry & Visuals | Prometheus v2, Grafana v10 |

---

## 📦 Installation & Setup

### Prerequisites
- [Node.js](https://nodejs.org) v18+ & `npm`
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for running local tests)
- [Docker & Docker Compose](https://www.docker.com/) (to run the local caching and monitoring stack)

---

### Step 1: Environment Configuration

Create a `.env` file in the **`frontend`** directory:
```bash
# frontend/.env
VITE_API_URL=http://localhost:3001
VITE_WS_URL=ws://localhost:3002
```

Create a `.env` file in the **`backend`** directory:
```bash
# backend/.env
PORT=3001
DATABASE_URL="postgresql://username:password@host/database?sslmode=require"
REDIS_URL="redis://localhost:6379"
ALCHEMY_API_KEY="your_alchemy_api_key_here"
ROUTER_ADDRESS="0x4293d76eF16B6f947050663298B818d51A0B6DD7"

# The Graph — query URL from your own Subgraph Studio deploy (see subgraph/)
SUBGRAPH_QUERY_URL="https://api.studio.thegraph.com/query/<id>/<name>/<version>"

# Optional — natural-language layer on /api/agent/insights, works fine without it
GEMINI_API_KEY=""
```

Create a `.env` file in the **`contract`** directory (only needed for deploying/testing
the contracts yourself, not for running the app against the existing Sepolia deployment):
```bash
# contract/.env
PRIVATE_KEY="0xyour_deployer_private_key"

# Chainlink VRF — create + fund a subscription at vrf.chain.link (Sepolia)
VRF_SUBSCRIPTION_ID=""
VRF_KEY_HASH=""
RESOLVER_POOL="0xaddr1,0xaddr2,0xaddr3"

# 1inch Aqua fork test only — a mainnet RPC URL, no funds ever move
MAINNET_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/your_key"
```

---

### Step 2: Spin Up Infrastructure (Redis, Prometheus, Grafana)

Use Docker Compose in the `infra` directory to spin up Redis, the local DB (optional fallback), Prometheus, and Grafana:
```bash
cd infra
docker-compose up -d
```
Verify all containers are up and healthy by running `docker compose ps`.

---

### Step 3: Install & Start the Backend

1. Navigate to the backend directory and install dependencies:
   ```bash
   cd ../backend
   npm install
   ```
2. Generate Prisma Client and apply migrations:
   ```bash
   npx prisma generate
   ```
3. Start the API server:
   ```bash
   npm run dev
   ```
4. Start the queue worker (in a separate terminal):
   ```bash
   npx tsx src/queue/index.ts
   ```

---

### Step 4: Install & Start the Frontend

1. Navigate to the frontend directory and install dependencies:
   ```bash
   cd ../frontend
   npm install
   ```
2. Run the Vite development server:
   ```bash
   npm run dev
   ```
3. Open `http://localhost:5173` in your browser.

---

## 🧪 Testing

We employ a comprehensive Foundry test suite covering unit integrity, access validations, and fuzz safety constraints on price updates and redemptions.

To run the contract tests:
```bash
cd contract

# Run all unit and fuzz tests
forge test

# Run with gas consumption profiling
forge test --gas-report

# Output complete execution trace for failures
forge test -vvvv
```

### 🧠 Key Tests Included:
- `RouterTest.sol`: Validates Router ownership, permissionless deployments, fee allocations, and admin-authorized resolution states.
- `PredictionMarket.fuzz.t.sol`: Uses Foundry Fuzzing to test YES/NO price boundaries, swap calculations under highly dynamic trade volumes, and liquidity solvency constraints.
- `ChainlinkResolution.t.sol`, `DisputeResolverVRF.t.sol`: Chainlink Price Feed resolution and VRF-based dispute resolution, using Chainlink's official `MockV3Aggregator`/`VRFCoordinatorV2_5Mock`.
- `CollateralYieldStrategy.t.sol`: 1inch Aqua strategy, run against a real mainnet fork (`FOUNDRY_PROFILE=fork forge test --match-path test/CollateralYieldStrategy.t.sol`) since Aqua has no testnet.

---

## 📈 Observability & Telemetry

LvrAMM is fully instrumented for complete transparency and production-grade monitoring:

- **Prometheus** (`http://localhost:9090`): Monitors indexer latency, queue sizes, database write throughput, and endpoint response times.
- **Grafana** (`http://localhost:3010`): Features a beautiful visual dashboard monitoring:
  - Total active WebSocket client count.
  - Alchemy event processing times.
  - Database pool utilization.
  - Dynamic cache hit/miss ratio for Express GET routes.

---

## 🛣️ Roadmap

- [x] **Core AMM Implementation**: Discrete swap logic for YES/NO tokens on-chain.
- [x] **Router Factory System**: Standardized, secure, permissionless pool creation.
- [x] **Real-Time Websockets**: Sub-second price ticks pushed via Redis Pub/Sub.
- [x] **IST & Gap-Filled Charting**: PremiumStep-Area chart scaled with custom timezones.
- [x] **Dockerized Telemetry**: Prometheus metrics & pre-configured Grafana telemetry.
- [x] **Chainlink Price Feed + VRF resolution** *(ETHOnline 2026)*: Objective markets auto-resolve off a real price feed; disputed markets get a VRF-picked resolver instead of always falling back to admin.
- [x] **The Graph subgraph + risk-monitor agent** *(ETHOnline 2026)*: Markets indexed via a standard subgraph; an agent flags AMM/oracle divergence near a market's deadline.
- [x] **1inch Aqua collateral strategy** *(ETHOnline 2026)*: Idle post-resolution collateral can earn yield non-custodially — built and fork-tested, deliberately not wired into the live redemption path.
- [ ] **Dynamic LVR Fees**: Automated fee adjustments tracking Sepolia implied volatility.
- [ ] **Cross-Chain Integration**: Deployments on Base and Arbitrum.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

---
