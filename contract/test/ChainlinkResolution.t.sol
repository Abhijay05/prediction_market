// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {Router} from "src/Router.sol";
import {LvrMarket} from "src/LvrMarket.sol";
import {MockUSD} from "src/MockUSD.sol";
import {MockV3Aggregator} from "@chainlink/contracts/src/v0.8/shared/mocks/MockV3Aggregator.sol";

contract ChainlinkResolutionTest is Test {
    uint256 constant INITIAL_LIQUIDITY = 1000 ether;
    uint256 constant MARKET_DURATION = 7 days;
    int256 constant STRIKE_PRICE = 3000e8; // $3000, 8 decimals like Chainlink ETH/USD

    Router router;
    MockUSD mUSD;
    MockV3Aggregator priceFeed;
    address market;
    bytes32 marketId;

    address creator = makeAddr("creator");

    function setUp() public {
        mUSD = new MockUSD();
        router = new Router(address(mUSD), address(0));
        priceFeed = new MockV3Aggregator(8, 2500e8); // starts below strike

        mUSD.mint(creator, INITIAL_LIQUIDITY);
        vm.startPrank(creator);
        mUSD.approve(address(router), INITIAL_LIQUIDITY);
        router.create(
            "Will ETH exceed $3000?",
            "Resolves YES if ETH/USD >= 3000 per Chainlink at deadline",
            "Chainlink ETH/USD",
            false, // isDynamic
            MARKET_DURATION,
            INITIAL_LIQUIDITY,
            address(priceFeed),
            STRIKE_PRICE,
            true // resolveYesIfAbove
        );
        (market, marketId) = router.getMarketAtIndex(0);
        vm.stopPrank();
    }

    function test_ResolvesYesWhenPriceAboveStrike() public {
        vm.warp(block.timestamp + MARKET_DURATION + 1);
        priceFeed.updateAnswer(3500e8);

        LvrMarket(market).resolveWithChainlink();

        (LvrMarket.MarketState state,, uint256 outcome,,,,,) = LvrMarket(market).getMarketDetails();
        assertEq(uint256(state), 4, "Should be RESOLVED");
        assertEq(outcome, 1, "Should resolve YES");
    }

    function test_ResolvesNoWhenPriceBelowStrike() public {
        vm.warp(block.timestamp + MARKET_DURATION + 1);
        priceFeed.updateAnswer(2000e8);

        LvrMarket(market).resolveWithChainlink();

        (,, uint256 outcome,,,,,) = LvrMarket(market).getMarketDetails();
        assertEq(outcome, 0, "Should resolve NO");
    }

    function test_RevertsBeforeDeadline() public {
        priceFeed.updateAnswer(3500e8);
        vm.expectRevert(bytes("Market not finished"));
        LvrMarket(market).resolveWithChainlink();
    }

    function test_RevertsWhenOracleNotConfigured() public {
        mUSD.mint(creator, INITIAL_LIQUIDITY);
        vm.startPrank(creator);
        mUSD.approve(address(router), INITIAL_LIQUIDITY);
        router.create(
            "No oracle market",
            "desc",
            "manual",
            false,
            MARKET_DURATION,
            INITIAL_LIQUIDITY,
            address(0),
            0,
            false
        );
        (address market2,) = router.getMarketAtIndex(1);
        vm.stopPrank();

        vm.warp(block.timestamp + MARKET_DURATION + 1);
        vm.expectRevert(bytes("Oracle not configured for this market"));
        LvrMarket(market2).resolveWithChainlink();
    }

    function test_RevertsWhenOracleDataStale() public {
        priceFeed.updateAnswer(3500e8); // sets updatedAt = now
        vm.warp(block.timestamp + MARKET_DURATION + 2 hours); // past deadline AND past 1h staleness window

        vm.expectRevert(bytes("Oracle data too stale"));
        LvrMarket(market).resolveWithChainlink();
    }

    function test_RevertsWhenCalledTwice() public {
        vm.warp(block.timestamp + MARKET_DURATION + 1);
        priceFeed.updateAnswer(3500e8);

        LvrMarket(market).resolveWithChainlink();

        vm.expectRevert(bytes("Invalid Market State"));
        LvrMarket(market).resolveWithChainlink();
    }
}
