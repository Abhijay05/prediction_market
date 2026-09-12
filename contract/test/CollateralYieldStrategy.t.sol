// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.19;

// Fork test — requires MAINNET_RPC_URL in contract/.env (see .agents/CREDENTIALS_CHECKLIST.md).
// Aqua/SwapVM has no testnet; 1inch's own rules for this track explicitly allow a local
// mainnet fork for the demo ("local forks are ok"). Run with:
//   forge test --match-path test/CollateralYieldStrategy.t.sol --fork-url $MAINNET_RPC_URL
// No real funds move — deal() mints test balances on the local fork only.

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/token/ERC20/IERC20.sol";
import { IAqua } from "lib/aqua/src/interfaces/IAqua.sol";
import { CollateralYieldStrategy } from "src/aqua/CollateralYieldStrategy.sol";
import { ICollateralYieldCallback } from "src/aqua/interfaces/ICollateralYieldCallback.sol";

// Aqua's registry is a deterministic deployment — same address on every supported chain.
address constant AQUA_MAINNET = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
// Real, deeply-liquid mainnet tokens — used only so the strategy operates against genuine
// ERC20s; deal() mints fork-local test balances regardless of real holder distribution.
address constant USDC_MAINNET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
address constant WETH_MAINNET = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

/// @dev Aqua takers must be contracts implementing the swap callback — a swap can't be
/// executed directly from a plain EOA.
contract TestTaker is ICollateralYieldCallback {
    function swap(
        CollateralYieldStrategy strategy_,
        CollateralYieldStrategy.Strategy memory strategy,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin,
        address to
    ) external returns (uint256) {
        return strategy_.swapExactIn(strategy, zeroForOne, amountIn, amountOutMin, to, "");
    }

    function collateralYieldSwapCallback(
        address tokenIn,
        address, /* tokenOut */
        uint256 amountIn,
        uint256, /* amountOut */
        address maker,
        address app,
        bytes32 strategyHash,
        bytes calldata /* takerData */
    ) external override {
        IAqua(AQUA_MAINNET).push(maker, app, strategyHash, tokenIn, amountIn);
    }
}

contract CollateralYieldStrategyTest is Test {
    CollateralYieldStrategy strategy;
    TestTaker taker;
    address maker = makeAddr("maker");

    uint256 constant MAKER_USDC = 100_000e6; // USDC has 6 decimals
    uint256 constant MAKER_WETH = 50e18;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        strategy = new CollateralYieldStrategy(IAqua(AQUA_MAINNET));
        taker = new TestTaker();

        deal(USDC_MAINNET, maker, MAKER_USDC);
        deal(WETH_MAINNET, maker, MAKER_WETH);
        deal(USDC_MAINNET, address(taker), 10_000e6);

        vm.startPrank(maker);
        IERC20(USDC_MAINNET).approve(AQUA_MAINNET, type(uint256).max);
        IERC20(WETH_MAINNET).approve(AQUA_MAINNET, type(uint256).max);
        vm.stopPrank();

        vm.prank(address(taker));
        IERC20(USDC_MAINNET).approve(AQUA_MAINNET, type(uint256).max);
    }

    function _strategy() internal view returns (CollateralYieldStrategy.Strategy memory) {
        return CollateralYieldStrategy.Strategy({
            maker: maker,
            token0: USDC_MAINNET,
            token1: WETH_MAINNET,
            feeBps: 30, // 0.30%
            salt: bytes32(0)
        });
    }

    function test_MakerShipsAndTakerSwapsUsdcForWeth() public {
        CollateralYieldStrategy.Strategy memory s = _strategy();

        address[] memory tokens = new address[](2);
        tokens[0] = USDC_MAINNET;
        tokens[1] = WETH_MAINNET;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = MAKER_USDC;
        amounts[1] = MAKER_WETH;

        vm.prank(maker);
        bytes32 strategyHash = IAqua(AQUA_MAINNET).ship(address(strategy), abi.encode(s), tokens, amounts);

        uint256 amountIn = 1_000e6; // 1,000 USDC
        uint256 quotedOut = strategy.quoteExactIn(s, true, amountIn);
        assertGt(quotedOut, 0, "quote should be nonzero");

        uint256 takerWethBefore = IERC20(WETH_MAINNET).balanceOf(address(taker));

        vm.prank(address(taker));
        uint256 amountOut = taker.swap(strategy, s, true, amountIn, 0, address(taker));

        assertEq(amountOut, quotedOut, "actual output should match the pre-swap quote");
        assertEq(
            IERC20(WETH_MAINNET).balanceOf(address(taker)),
            takerWethBefore + amountOut,
            "taker should receive WETH directly from the maker's own wallet"
        );

        (uint256 balanceUsdc, uint256 balanceWeth) =
            IAqua(AQUA_MAINNET).safeBalances(maker, address(strategy), strategyHash, USDC_MAINNET, WETH_MAINNET);
        assertEq(balanceUsdc, MAKER_USDC + amountIn, "maker's tracked USDC balance grows by the swap's input");
        assertEq(balanceWeth, MAKER_WETH - amountOut, "maker's tracked WETH balance shrinks by the swap's output");

        // The collateral never left the maker's own custody at any point — it moved
        // directly wallet-to-wallet via Aqua's pull/push, never into a pooled vault.
        assertEq(IERC20(USDC_MAINNET).balanceOf(maker), MAKER_USDC + amountIn);
        assertEq(IERC20(WETH_MAINNET).balanceOf(maker), MAKER_WETH - amountOut);
    }

    function test_RevertsWhenOutputBelowMinimum() public {
        CollateralYieldStrategy.Strategy memory s = _strategy();

        address[] memory tokens = new address[](2);
        tokens[0] = USDC_MAINNET;
        tokens[1] = WETH_MAINNET;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = MAKER_USDC;
        amounts[1] = MAKER_WETH;

        vm.prank(maker);
        IAqua(AQUA_MAINNET).ship(address(strategy), abi.encode(s), tokens, amounts);

        uint256 amountIn = 1_000e6;
        uint256 quotedOut = strategy.quoteExactIn(s, true, amountIn);

        vm.prank(address(taker));
        vm.expectRevert();
        taker.swap(strategy, s, true, amountIn, quotedOut + 1, address(taker));
    }
}
