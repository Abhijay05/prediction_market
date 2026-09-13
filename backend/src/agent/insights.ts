// backend/src/agent/insights.ts
//
// Cross-references the Graph subgraph (Phase 2) against the Chainlink price feed each
// market's on-chain resolution is configured against (Phase 1) to flag markets where
// the AMM's crowd-priced YES probability has drifted from what the oracle already
// implies the outcome would be if the market settled right now.
import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { logger } from "../lib/logger";

export const agentRouter = Router();

const SUBGRAPH_QUERY_URL = process.env.SUBGRAPH_QUERY_URL;
const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// gemini-2.5-flash is no longer available to new users as of this key (confirmed via a
// live test call, which is how the deprecation surfaced) — Google's own 404 pointed at
// this replacement.
const GEMINI_MODEL = "gemini-3.6-flash";

const AGGREGATOR_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];
const LVR_MARKET_ABI = ["function getPriceYes() view returns (uint256)"];

// Flag markets where the AMM's YES price is more than this many percentage points
// away from the oracle-implied outcome.
const DIVERGENCE_THRESHOLD = 0.15;

// "What would happen if this market resolved right now" is only a fair proxy for
// "what will actually happen at the deadline" when there's little time left for the
// price to move back. Far from the deadline, a rational AMM price should differ from
// a hard 0/1 oracle snapshot — that's not a mispricing, it's the market correctly
// pricing in the chance the price moves before it actually matters. Only compare the
// two once a market is this close to expiring.
const NEAR_DEADLINE_SECONDS = 6 * 60 * 60; // 6 hours

interface OracleMarket {
  id: string;
  title: string;
  priceFeed: string;
  strikePrice: string;
  resolveYesIfAbove: boolean;
  status: string;
  deadline: string;
}

interface MarketInsight {
  marketId: string;
  title: string;
  ammPriceYes: number;
  oracleAnswer: string;
  strikePrice: string;
  wouldResolveYesNow: boolean;
  divergence: number;
  secondsToDeadline: number;
  flagged: boolean;
  reasoning: string;
}

async function queryOracleMarkets(): Promise<OracleMarket[]> {
  const query = `
    {
      markets(where: { priceFeed_not: null, status: "OPEN" }) {
        id
        title
        priceFeed
        strikePrice
        resolveYesIfAbove
        status
        deadline
      }
    }
  `;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (GRAPH_API_KEY) headers["Authorization"] = `Bearer ${GRAPH_API_KEY}`;

  const res = await fetch(SUBGRAPH_QUERY_URL!, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  if (!res.ok) throw new Error(`Subgraph query failed: ${res.status}`);
  const json: any = await res.json();
  if (json.errors) throw new Error(`Subgraph query errors: ${JSON.stringify(json.errors)}`);
  return json.data.markets as OracleMarket[];
}

async function getInsight(market: OracleMarket, provider: ethers.Provider): Promise<MarketInsight> {
  const feed = new ethers.Contract(market.priceFeed, AGGREGATOR_ABI, provider);
  const lvrMarket = new ethers.Contract(market.id, LVR_MARKET_ABI, provider);

  const [roundData, ammPriceRaw] = await Promise.all([
    feed.latestRoundData(),
    lvrMarket.getPriceYes(),
  ]);

  const answer = roundData[1] as bigint;
  const strikePrice = BigInt(market.strikePrice);
  const wouldResolveYesNow = market.resolveYesIfAbove ? answer >= strikePrice : answer <= strikePrice;
  const oracleImpliedProbability = wouldResolveYesNow ? 1 : 0;

  const ammPriceYes = Number(ethers.formatEther(ammPriceRaw));
  const divergence = Math.abs(ammPriceYes - oracleImpliedProbability);

  const secondsToDeadline = Number(market.deadline) - Math.floor(Date.now() / 1000);
  const isNearDeadline = secondsToDeadline <= NEAR_DEADLINE_SECONDS;
  // Only ever flag near-deadline markets. Far from the deadline, a price that hasn't
  // already snapped to 0/1 isn't a mispricing — it's the market correctly pricing in
  // the chance the underlying price still moves before the real deadline arrives.
  const flagged = isNearDeadline && divergence > DIVERGENCE_THRESHOLD;

  const reasoning = flagged
    ? `With under ${Math.max(1, Math.round(secondsToDeadline / 3600))}h left, the AMM still prices YES at ` +
      `${(ammPriceYes * 100).toFixed(1)}%, but the current Chainlink answer (${answer.toString()}) already ` +
      `implies this market would resolve ${wouldResolveYesNow ? "YES" : "NO"} if it settled right now — a ` +
      `${(divergence * 100).toFixed(1)}pp gap that's unlikely to close on its own this close to expiry.`
    : isNearDeadline
      ? `The AMM's ${(ammPriceYes * 100).toFixed(1)}% YES price is broadly consistent with the current ` +
        `Chainlink-implied outcome this close to the deadline.`
      : `Deadline is more than ${Math.round(NEAR_DEADLINE_SECONDS / 3600)}h away — a gap between the AMM's ` +
        `${(ammPriceYes * 100).toFixed(1)}% and the current spot price isn't meaningful yet, since the ` +
        `underlying price still has time to move either way before it actually matters.`;

  return {
    marketId: market.id,
    title: market.title,
    ammPriceYes,
    oracleAnswer: answer.toString(),
    strikePrice: market.strikePrice,
    wouldResolveYesNow,
    divergence,
    secondsToDeadline,
    flagged,
    reasoning,
  };
}

// Optional natural-language layer on top of the rule-based insights above. Never lets
// an LLM failure break the endpoint — falls back to the automation-only output (which
// already satisfies the qualification bar on its own) if GEMINI_API_KEY isn't set or
// the call fails for any reason.
async function generateNarrativeSummary(insights: MarketInsight[]): Promise<string | null> {
  if (!GEMINI_API_KEY || insights.length === 0) return null;

  const flagged = insights.filter((i) => i.flagged);
  if (flagged.length === 0) return null;

  const prompt =
    "You are a terse market-risk analyst for a prediction-market platform. Each market " +
    "below is close to its deadline (that filtering has already been done for you — " +
    "don't second-guess it), and its AMM crowd price disagrees with what an independent " +
    "Chainlink price feed already implies the outcome would be if it settled right now. " +
    "Write a 2-3 sentence briefing a trader could read in five seconds, specific with " +
    "the numbers given. Don't restate the methodology or mention that filtering happened.\n\n" +
    JSON.stringify(
      flagged.map((i) => ({
        title: i.title,
        ammPriceYes: i.ammPriceYes,
        wouldResolveYesNow: i.wouldResolveYesNow,
        divergence: i.divergence,
        hoursToDeadline: Math.round(i.secondsToDeadline / 3600),
      }))
    );

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    if (!res.ok) {
      logger.warn({ status: res.status }, "agent: Gemini call failed, falling back to rule-based reasoning only");
      return null;
    }

    const json: any = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === "string" ? text.trim() : null;
  } catch (err) {
    logger.warn({ err }, "agent: Gemini call threw, falling back to rule-based reasoning only");
    return null;
  }
}

// GET /api/agent/insights
agentRouter.get("/insights", async (_req: Request, res: Response) => {
  if (!SUBGRAPH_QUERY_URL) {
    return res.status(503).json({
      error: "SUBGRAPH_QUERY_URL not configured yet — see .agents/CREDENTIALS_CHECKLIST.md",
    });
  }

  try {
    const markets = await queryOracleMarkets();
    if (markets.length === 0) {
      return res.json({ insights: [], count: 0, flaggedCount: 0, note: "No Chainlink-resolved markets currently open." });
    }

    const provider = new ethers.AlchemyProvider("sepolia", ALCHEMY_API_KEY);
    const insights = await Promise.all(markets.map((m) => getInsight(m, provider)));
    const narrativeSummary = await generateNarrativeSummary(insights);

    return res.json({
      insights,
      count: insights.length,
      flaggedCount: insights.filter((i) => i.flagged).length,
      narrativeSummary,
    });
  } catch (err) {
    logger.error({ err }, "agent: insights query failed");
    return res.status(500).json({ error: "Failed to compute insights" });
  }
});
