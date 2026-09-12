import { Address, BigInt } from "@graphprotocol/graph-ts";
import { MarketCreated as MarketCreatedEvent } from "../generated/Router/Router";
import {
  LvrMarket as LvrMarketContract,
  MarketBuy as MarketBuyEvent,
  MarketSell as MarketSellEvent,
  PriceSnapshot as PriceSnapshotEvent,
  MarketResolvedByAdmin as MarketResolvedByAdminEvent,
  MarketResolvedByOracle as MarketResolvedByOracleEvent,
  MarketResolvedByDispute as MarketResolvedByDisputeEvent,
} from "../generated/templates/LvrMarket/LvrMarket";
import { LvrMarket as LvrMarketTemplate } from "../generated/templates";
import { Market, Trade, PriceSnapshot } from "../generated/schema";

export function handleMarketCreated(event: MarketCreatedEvent): void {
  let market = new Market(event.params.market);
  market.marketId = event.params.marketId;
  market.router = event.address;
  market.creator = event.params.creator;
  market.title = event.params.title;
  market.description = event.params.description;
  market.resolutionSource = event.params.resolutionSource;
  market.deadline = event.params.deadline;
  market.initialLiquidity = event.params.liquidity;
  market.yesReserve = event.params.liquidity;
  market.noReserve = event.params.liquidity;
  market.totalVolume = BigInt.fromI32(0);
  market.status = "OPEN";
  market.createdAtBlock = event.block.number;
  market.createdAtTimestamp = event.block.timestamp;

  // priceFeed/strikePrice/resolveYesIfAbove aren't in MarketCreated — read them
  // directly off the freshly-deployed LvrMarket instance instead.
  let lvrMarket = LvrMarketContract.bind(event.params.market);
  let priceFeedResult = lvrMarket.try_i_priceFeed();
  if (!priceFeedResult.reverted && !priceFeedResult.value.equals(Address.zero())) {
    market.priceFeed = priceFeedResult.value;
    let strikeResult = lvrMarket.try_i_strikePrice();
    if (!strikeResult.reverted) market.strikePrice = strikeResult.value;
    let resolveAboveResult = lvrMarket.try_i_resolveYesIfAbove();
    if (!resolveAboveResult.reverted) market.resolveYesIfAbove = resolveAboveResult.value;
  }

  market.save();

  // Start indexing this specific market's own events dynamically — Router is a
  // factory, so each LvrMarket instance only exists after this event fires.
  LvrMarketTemplate.create(event.params.market);
}

export function handleMarketBuy(event: MarketBuyEvent): void {
  let market = Market.load(event.address);
  if (market == null) return;

  let trade = new Trade(event.transaction.hash.concatI32(event.logIndex.toI32()));
  trade.market = market.id;
  trade.direction = "BUY";
  trade.outcome = event.params.isBuyYes ? "YES" : "NO";
  trade.trader = event.params.buyer;
  trade.amountIn = event.params.amountIn;
  trade.amountOut = event.params.amountOut;
  trade.blockNumber = event.block.number;
  trade.timestamp = event.block.timestamp;
  trade.txHash = event.transaction.hash;
  trade.save();

  market.totalVolume = market.totalVolume.plus(event.params.amountIn);
  market.save();
}

export function handleMarketSell(event: MarketSellEvent): void {
  let market = Market.load(event.address);
  if (market == null) return;

  let trade = new Trade(event.transaction.hash.concatI32(event.logIndex.toI32()));
  trade.market = market.id;
  trade.direction = "SELL";
  trade.outcome = event.params.isSellYes ? "YES" : "NO";
  trade.trader = event.params.seller;
  trade.amountIn = event.params.amountIn;
  trade.amountOut = event.params.amountOut;
  trade.blockNumber = event.block.number;
  trade.timestamp = event.block.timestamp;
  trade.txHash = event.transaction.hash;
  trade.save();

  market.totalVolume = market.totalVolume.plus(event.params.amountOut);
  market.save();
}

export function handlePriceSnapshot(event: PriceSnapshotEvent): void {
  let market = Market.load(event.address);
  if (market == null) return;

  let snapshot = new PriceSnapshot(event.transaction.hash.concatI32(event.logIndex.toI32()));
  snapshot.market = market.id;
  snapshot.priceYes = event.params.priceYes;
  snapshot.priceNo = event.params.priceNo;
  snapshot.reserveYes = event.params.reserveYes;
  snapshot.reserveNo = event.params.reserveNo;
  snapshot.timestamp = event.params.timestamp;
  snapshot.blockNumber = event.block.number;
  snapshot.save();

  market.yesReserve = event.params.reserveYes;
  market.noReserve = event.params.reserveNo;
  market.save();
}

export function handleMarketResolvedByAdmin(event: MarketResolvedByAdminEvent): void {
  let market = Market.load(event.address);
  if (market == null) return;
  market.status = "RESOLVED";
  market.winningOutcome = event.params.outcome.toI32();
  market.resolutionMethod = "ADMIN";
  market.resolvedAtTimestamp = event.block.timestamp;
  market.save();
}

export function handleMarketResolvedByOracle(event: MarketResolvedByOracleEvent): void {
  let market = Market.load(event.address);
  if (market == null) return;
  market.status = "RESOLVED";
  market.winningOutcome = event.params.outcome.toI32();
  market.resolutionMethod = "ORACLE";
  market.resolvedAtTimestamp = event.block.timestamp;
  market.save();
}

export function handleMarketResolvedByDispute(event: MarketResolvedByDisputeEvent): void {
  let market = Market.load(event.address);
  if (market == null) return;
  market.status = "RESOLVED";
  market.winningOutcome = event.params.outcome.toI32();
  market.resolutionMethod = "DISPUTE_VRF";
  market.resolvedAtTimestamp = event.block.timestamp;
  market.save();
}
