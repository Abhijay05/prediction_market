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
- Creating a Chainlink-resolved market is a real toggle in `CreateMarket.jsx`'s UI
  (strike price + above/below), not just a contract-level capability reachable only by
  a direct call.

**Live on Sepolia** (deployed 2026-09-13):
- `Router`: `0x4293d76eF16B6f947050663298B818d51A0B6DD7`
- `DisputeResolverVRF`: `0x4CDe5b2F9e0909389B641ff38ECF3726783eD00a` (resolver pool
  expanded on-chain to 3 distinct funded addresses, registered as a VRF consumer)
- Sample markets: one admin-resolved (`0xe2E55C29eA26A1c716779971b5E0453a3903D8Ec`,
  Continuity-era resolution path, untouched), one Chainlink-resolved
  (`0xBCF7a7c868395cF7528e869e0DDf501A0f5a53cC`, wired to the real Sepolia ETH/USD feed)

Files: `contract/src/LvrMarket.sol`, `contract/src/Router.sol`,
`contract/src/oracle/DisputeResolverVRF.sol`,
`contract/src/interfaces/IDisputeResolverVRF.sol`, `contract/script/Deploy.s.sol`,
`contract/test/ChainlinkResolution.t.sol`, `contract/test/DisputeResolverVRF.t.sol`,
`frontend/src/pages/CreateMarket.jsx`, plus the indexer/schema/frontend changes
threading the new resolution sources through.

**Honest limitation, stated up front rather than left for a judge to find**: VRF makes
*who gets picked* from the resolver pool fair and unpredictable — it does not make *who's
eligible to be in the pool* decentralized. That's still admin-set. The claim is "no
longer always the same fixed admin," not "fully trustless dispute resolution."

### The Graph — subgraph + market-insights agent

A new subgraph (`subgraph/`) indexes `Router` and every dynamically-created `LvrMarket`
instance, live on Subgraph Studio
(`https://api.studio.thegraph.com/query/1760225/nebula-pm/v0.0.2`, indexing the real
Router above from its actual deployment block). On top of it, a backend agent
(`GET /api/agent/insights`) cross-references the subgraph's live AMM price against the
Chainlink price feed from the integration above, flagging markets where the two have
drifted apart — tying both integrations into one feature rather than two disconnected
ones.

The divergence check only fires within 6 hours of a market's deadline. Earlier in this
event's own build process, it didn't have that gate and would have flagged almost any
market whose AMM price wasn't already pinned at 0%/100%, regardless of how much time
was left for the price to move — worth stating plainly rather than quietly, since it's
exactly the kind of thing that separates "used a sponsor's product" from "used it in a
way that's actually correct."

Files: `subgraph/`, `backend/src/agent/insights.ts`, plus the `Dashboard.jsx` insights
panel.

### 1inch Aqua — collateral yield strategy

`CollateralYieldStrategy.sol` is a real Aqua app: a resolved market's collateral, idle
between resolution and redemption, could be shipped into this strategy to earn swap fees
without ever leaving the maker's own custody (Aqua is non-custodial by design). Tested
against a live fork of real mainnet (Aqua has no testnet), with real numbers: 1,000 USDC
in → ~0.4936 WETH out through the real deployed Aqua registry.

**Deliberately not wired into `Router`/`LvrMarket`'s live redemption path.** Aqua's
non-custodial design means a market's collateral balance shifts token composition the
moment a taker swaps against it — wiring that into the same path a user might be
redeeming from, under a hackathon deadline, is a real fund-safety risk, not just a
hypothetical one. This is presented as a fully tested, working capability the protocol
is designed to plug into — not as something already live in production, because it
isn't, on purpose.

Files: `contract/src/aqua/`, `contract/test/CollateralYieldStrategy.t.sol`.

## Commit history for the new work

Each integration above landed as its own commit (or small commit group), not one
combined "add sponsors" commit:

```
f45aa61 chainlink and aqua deps
cf13f6b chainlink resolution logic
59f6983 index oracle resolutions
e2b48af graph subgraph indexing
8e8da0c market insights agent
4ac30e7 chainlink frontend updates
d9aba79 aqua yield strategy
c959efb continuity and architecture docs
acde833 fix docker env vars
19859b1 fix insights deadline logic
fa047ef chainlink market creation ui
```

All on top of `0cb28db`, the last pre-existing commit. See `.agents/COMMIT_PLAN.md` for
how these were organized.
