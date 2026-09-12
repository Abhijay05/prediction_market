# Architecture

The original PM-AMM system (solid, pre-existing) plus the three sponsor integrations
added during ETHOnline 2026 (dashed, new). See `CONTINUITY.md` for the detailed
pre-existing/new breakdown.

```mermaid
flowchart TB
    subgraph Frontend["Frontend (React + wagmi) — pre-existing, extended"]
        UI[Market / Dashboard pages]
    end

    subgraph Contracts["Sepolia contracts"]
        Router["Router.sol\n(factory + trade routing)"]
        LvrMarket["LvrMarket.sol\n(PM-AMM curve, resolution)"]
        VRF["DisputeResolverVRF.sol"]:::new
        Aqua["CollateralYieldStrategy.sol"]:::new
    end

    subgraph External["External protocols"]
        ChainlinkFeed["Chainlink Price Feed\n(Sepolia ETH/USD)"]:::new
        ChainlinkVRF["Chainlink VRF Coordinator"]:::new
        AquaProtocol["Aqua (mainnet, non-custodial)"]:::new
    end

    subgraph Indexing["Indexing"]
        AlchemyListener["Alchemy WS listener\n+ BullMQ workers"]
        Postgres[("Postgres\n(Prisma)")]
        Subgraph["Graph subgraph\n(Router + LvrMarket)"]:::new
    end

    subgraph Backend["Backend (Express)"]
        MarketsAPI["/api/markets"]
        AgentAPI["/api/agent/insights"]:::new
        WS["WebSocket price fan-out"]
    end

    UI -->|read/write via wagmi| Router
    Router --> LvrMarket
    LvrMarket -->|resolveWithChainlink| ChainlinkFeed
    LvrMarket -->|dispute triggers VRF request| VRF
    VRF -->|requestRandomWords| ChainlinkVRF
    ChainlinkVRF -->|fulfillRandomWords, selects resolver| VRF
    VRF -->|setSelectedResolver| LvrMarket
    Aqua -.->|ship / pull / push, idle collateral| AquaProtocol

    LvrMarket -->|events| AlchemyListener
    Router -->|events| AlchemyListener
    AlchemyListener --> Postgres
    Postgres --> MarketsAPI
    MarketsAPI --> UI
    AlchemyListener --> WS
    WS --> UI

    Router -.->|MarketCreated| Subgraph
    LvrMarket -.->|trades, snapshots, resolutions| Subgraph
    Subgraph -.-> AgentAPI
    ChainlinkFeed -.->|latestRoundData| AgentAPI
    AgentAPI -.-> UI

    classDef new stroke:#0ea5e9,stroke-width:2px,stroke-dasharray: 4 3
```

## Integration points

| # | Sponsor | Where it lives | What it does |
|---|---|---|---|
| 1 | Chainlink | `LvrMarket.resolveWithChainlink()`, `DisputeResolverVRF.sol` | Price Feeds auto-resolve objective markets; VRF picks a resolver for disputed ones, replacing what was previously a dead end |
| 2 | The Graph | `subgraph/`, `backend/src/agent/insights.ts` | Subgraph indexes the same on-chain events as the Postgres pipeline; the agent cross-references it against integration #1's price feed to flag AMM/oracle divergence |
| 3 | 1inch Aqua | `contract/src/aqua/CollateralYieldStrategy.sol` | Idle post-resolution collateral can earn swap fees via a non-custodial Aqua strategy, kept isolated from the live settlement path |

Dashed nodes/edges above are new; solid ones are the pre-existing system, unmodified in
shape (only `LvrMarket`/`Router` gained new optional entry points — existing markets and
callers are unaffected).
