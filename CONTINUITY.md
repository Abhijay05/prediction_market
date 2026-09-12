# Continuity Documentation

This project is submitted to ETHOnline 2026 under the **Continuity** track. This file
separates the pre-existing build from the work done during the event, per that track's
rules.

## Pre-existing work (2026-05-29 → 2026-06-03)

PM-AMM Prediction Markets — a prediction market protocol implementing the PM-AMM design
from Paradigm's research paper — was built before this event, on Ethereum Sepolia. The
full commit history is intact on `main` and covers, in order:

- The core protocol: `MockUSD`, `YesToken`/`NoToken`, `LvrMarket` (the PM-AMM curve),
  `Router` (factory + trade routing), and the `SwapMath`/`Math`/`Gaussian` libraries
  implementing the Gaussian-CDF pricing model.
- Market resolution as it originally existed: an optimistic propose/dispute flow with a
  bond, and an admin fallback (`adminResolve`).
- Supporting infrastructure: a Node.js/BullMQ event-indexing pipeline reading Sepolia via
  Alchemy, a Postgres schema (Prisma) for markets/trades/positions/price snapshots, a
  WebSocket layer for live price updates, Redis caching, and a React/wagmi frontend
  (market creation, trading, charting, a dashboard).
- A Prometheus/Grafana monitoring stack for API performance, WebSocket connections, and
  indexer health.

See `git log` on `main` for the complete, unmodified history (`9921d83` through
`0cb28db`).

## New work — added during this event

Three sponsor integrations, each scoped to close a real, specific gap in the
pre-existing protocol rather than being a generic bolt-on. Full reasoning for why these
three tracks (and not others) is in `.agents/HACKATHON_CONTEXT.md`.

### Chainlink — Price Feed resolution + VRF dispute resolver

The pre-existing protocol had two resolution paths: an optimistic propose/dispute flow,
and an admin fallback. `dispute()` itself, however, was a dead end — it flipped the
market to `DISPUTED` and had no actual resolution mechanism (see the original code's own
comment: *"set the market outcome through creator/resolver voting/admin"* — never
implemented). This event's work closes two real gaps at once:

- `resolveWithChainlink()` on `LvrMarket` — permissionless, pulls
  `AggregatorV3Interface.latestRoundData()` once a market's deadline passes, resolving
  objective markets with no human involved.
- `DisputeResolverVRF` — a new contract that requests Chainlink VRF randomness on
  dispute, selecting one resolver from a registered pool to finalize the market, in
  place of the previously-nonexistent dispute-resolution path.

Files: `contract/src/LvrMarket.sol`, `contract/src/Router.sol`,
`contract/src/oracle/DisputeResolverVRF.sol`,
`contract/src/interfaces/IDisputeResolverVRF.sol`, `contract/script/Deploy.s.sol`,
`contract/test/ChainlinkResolution.t.sol`, `contract/test/DisputeResolverVRF.t.sol`, plus
the indexer/schema/frontend changes threading the new resolution sources through.

### The Graph — subgraph + market-insights agent

A new subgraph (`subgraph/`) indexes `Router` and every dynamically-created `LvrMarket`
instance. On top of it, a new backend agent (`GET /api/agent/insights`) cross-references
the subgraph's live AMM price against the Chainlink price feed from the integration
above, flagging markets where the two have drifted apart — tying both integrations into
one feature rather than two disconnected ones.

Files: `subgraph/`, `backend/src/agent/insights.ts`, plus the `Dashboard.jsx` insights
panel.

### 1inch Aqua — collateral yield strategy

`CollateralYieldStrategy.sol` is a real Aqua app: a resolved market's collateral, idle
between resolution and redemption, could be shipped into this strategy to earn swap fees
without ever leaving the maker's own custody (Aqua is non-custodial by design).
Deliberately kept isolated from `Router`/`LvrMarket`'s live settlement path — zero blast
radius on core protocol correctness regardless of this integration's own correctness.

Files: `contract/src/aqua/`, `contract/test/CollateralYieldStrategy.t.sol`.

## Commit history for the new work

Each integration above landed as its own commit (or small commit group), not one
combined "add sponsors" commit — see the repository's commit log for the exact
boundaries, and `.agents/COMMIT_PLAN.md` for how they were organized.
