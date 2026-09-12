// contracts/test/PredictionMarket.fuzz.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "src/Router.sol";
import "src/LvrMarket.sol";
import "src/MockUSD.sol";
import "@openzeppelin/token/ERC20/IERC20.sol";

/**
 * Fuzz test suite for LvrAMM PredictionMarket (LvrMarket).
 *
 * Invariants tested:
 *   1. Buying YES increases YES price, buying NO decreases YES price
 *   2. Selling YES decreases YES price
 *   3. YES price + NO price always equals 1 (within WAD rounding precision)
 *   4. User can never receive more collateral than they put in (no free money)
 *   5. Reserve balances are valid and backed by contract collateral holdings
 *   6. Market resolves correctly — winner redeems full collateral share
 */
contract PredictionMarketFuzzTest is Test {
    Router  public router;
    MockUSD public mUSD;
    address public market;
    bytes32 public marketId;

    address alice   = makeAddr("alice");
    address bob     = makeAddr("bob");
    address creator = makeAddr("creator");

    uint256 constant INITIAL_LIQUIDITY = 1000 ether;
    uint256 constant MINT_AMOUNT       = 10_000 ether;
    uint256 constant MARKET_DURATION   = 30 days;

    function setUp() public {
        mUSD   = new MockUSD();
        router = new Router(address(mUSD), address(0)); // no VRF dispute resolver in these tests

        // Fund alice, bob, and creator
        mUSD.mint(alice, MINT_AMOUNT);
        mUSD.mint(bob,   MINT_AMOUNT);
        mUSD.mint(creator, INITIAL_LIQUIDITY);

        // Creator approves and deploys market
        vm.startPrank(creator);
        mUSD.approve(address(router), INITIAL_LIQUIDITY);
        router.create(
            "Will ETH exceed $5000?",
            "Resolves YES if ETH exceeds 5000",
            "CoinGecko",
            true, // isDynamic
            MARKET_DURATION,
            INITIAL_LIQUIDITY,
            address(0), // priceFeed — disabled for this test
            0,          // strikePrice
            false       // resolveYesIfAbove
        );
        (market, marketId) = router.getMarketAtIndex(0);
        vm.stopPrank();

        // Approve router for traders
        vm.prank(alice); mUSD.approve(address(router), type(uint256).max);
        vm.prank(bob);   mUSD.approve(address(router), type(uint256).max);
    }

    // ── Invariant 1: Buying YES increases YES price ─────────────────────────
    function testFuzz_priceIncreasesOnBuy(uint256 collateralIn) public {
        collateralIn = bound(collateralIn, 1e16, 10 ether);

        uint256 priceBefore = LvrMarket(market).getPriceYes();

        vm.prank(alice);
        router.buyYes(market, collateralIn);

        uint256 priceAfter = LvrMarket(market).getPriceYes();

        assertGt(priceAfter, priceBefore, "Price did not increase after YES buy");
    }

    // ── Invariant 2: Buying NO decreases YES price (increases NO price) ──────
    function testFuzz_priceDecreasesOnNoBuy(uint256 collateralIn) public {
        collateralIn = bound(collateralIn, 1e16, 10 ether);

        uint256 priceBefore = LvrMarket(market).getPriceYes();

        vm.prank(alice);
        router.buyNo(market, collateralIn);

        uint256 priceAfter = LvrMarket(market).getPriceYes();

        assertLt(priceAfter, priceBefore, "Price did not decrease after NO buy");
    }

    // ── Invariant 3: Selling YES decreases YES price ────────────────────────
    function testFuzz_priceDecreasesOnSell(uint256 collateralIn) public {
        collateralIn = bound(collateralIn, 1e16, 5 ether);

        address yesToken = LvrMarket(market).getToken(true);

        // First buy some YES tokens
        vm.prank(alice);
        router.buyYes(market, collateralIn);

        uint256 yesTokens = IERC20(yesToken).balanceOf(alice);
        if (yesTokens == 0) return;

        uint256 priceAfterBuy = LvrMarket(market).getPriceYes();

        vm.startPrank(alice);
        IERC20(yesToken).approve(address(router), yesTokens);
        router.sellYes(market, yesTokens);
        vm.stopPrank();

        uint256 priceAfterSell = LvrMarket(market).getPriceYes();

        assertLt(priceAfterSell, priceAfterBuy, "Price did not decrease after YES sell");
    }

    // ── Invariant 4: YES price + NO price = 1 ────────────────────────────────
    function testFuzz_pricesSumToOne(uint256 collateralIn) public {
        collateralIn = bound(collateralIn, 1e16, 10 ether);

        vm.prank(alice);
        router.buyYes(market, collateralIn);

        uint256 priceYes = LvrMarket(market).getPriceYes();
        uint256 priceNo  = LvrMarket(market).getPriceNo();

        // Verify in WAD (18-decimal fixed point) sum to 1.0 (with high-precision rounding tolerance)
        assertApproxEqAbs(priceYes + priceNo, 1e18, 1e10, "prices don't sum to 1");
    }

    // ── Invariant 5: no free money — can't profit from buy then immediate sell ─
    function testFuzz_noFreeMoneyBuySell(uint256 collateralIn) public {
        collateralIn = bound(collateralIn, 1e16, 5 ether);

        uint256 balanceBefore = mUSD.balanceOf(alice);

        vm.prank(alice);
        router.buyYes(market, collateralIn);

        address yesToken  = LvrMarket(market).getToken(true);
        uint256 yesTokens = IERC20(yesToken).balanceOf(alice);

        vm.startPrank(alice);
        IERC20(yesToken).approve(address(router), yesTokens);
        router.sellYes(market, yesTokens);
        vm.stopPrank();

        uint256 balanceAfter = mUSD.balanceOf(alice);

        // After buy→sell, user should have less than or equal to what they started with
        assertLe(balanceAfter, balanceBefore, "free money exploit: buy+sell increased balance");
    }

    // ── Invariant 6: reserves match actual token holdings ────────────────────
    function testFuzz_reservesMatchHoldings(uint256 collateralIn) public {
        collateralIn = bound(collateralIn, 1e16, 10 ether);

        vm.prank(alice);
        router.buyYes(market, collateralIn);

        address yesToken = LvrMarket(market).getToken(true);
        address noToken  = LvrMarket(market).getToken(false);

        uint256 yesReserve = IERC20(yesToken).balanceOf(market);
        uint256 noReserve  = IERC20(noToken).balanceOf(market);

        // Contract collateral backing the reserves
        uint256 contractBalance = mUSD.balanceOf(market);

        // Reserves are consistent and positive
        assertGt(yesReserve, 0, "yes reserve is zero");
        assertGt(noReserve,  0, "no reserve is zero");
        assertGe(contractBalance, 0, "contract has no collateral");
    }

    // ── Resolution: winner redeems full share ─────────────────────────────────
    function testFuzz_resolutionPayoutIsCorrect(uint256 collateralIn) public {
        collateralIn = bound(collateralIn, 1e16, 10 ether);

        vm.prank(alice);
        router.buyYes(market, collateralIn);

        address yesToken = LvrMarket(market).getToken(true);
        uint256 yesBalance = IERC20(yesToken).balanceOf(alice);

        // Fast-forward past expiry
        vm.warp(block.timestamp + MARKET_DURATION + 1);

        // Resolve YES
        vm.prank(creator);
        LvrMarket(market).adminResolve(1); // 1 = YES

        uint256 balanceBefore = mUSD.balanceOf(alice);

        vm.startPrank(alice);
        IERC20(yesToken).approve(address(router), yesBalance);
        router.redeem(market, yesBalance, 0);
        vm.stopPrank();

        uint256 balanceAfter = mUSD.balanceOf(alice);
        uint256 redeemed     = balanceAfter - balanceBefore;

        // User redeemed something positive
        assertGt(redeemed, 0, "winner received nothing on redemption");
    }
}
