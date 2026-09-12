// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.19;

import { Math } from "@openzeppelin/utils/math/Math.sol";

import { IAqua } from "lib/aqua/src/interfaces/IAqua.sol";
import { AquaApp } from "lib/aqua/src/AquaApp.sol";
import { ICollateralYieldCallback } from "./interfaces/ICollateralYieldCallback.sol";

/// @title CollateralYieldStrategy — a constant-product Aqua app for idle prediction-market collateral
/// @notice A resolved LvrMarket's collateral sits idle between resolution and redemption. Instead of
/// depositing it into a separate lending contract, its holder can "ship" it into this Aqua strategy as
/// a maker: the collateral never leaves the maker's own contract custody (Aqua is non-custodial — see
/// IAqua), and it earns swap fees from real taker flow until it's withdrawn again for redemption.
///
/// @dev Deliberately NOT wired into LvrMarket/Router's live settlement path — this is a standalone,
/// separately-tested app so a bug here has zero blast radius on core PM-AMM correctness. Swap math is
/// the same constant-product-with-fee formula as Aqua's own reference XYCSwap example, since reusing a
/// proven-correct formula is safer than inventing new AMM math under time pressure.
contract CollateralYieldStrategy is AquaApp {
    using Math for uint256;

    error InsufficientOutputAmount(uint256 amountOut, uint256 amountOutMin);
    error ExcessiveInputAmount(uint256 amountIn, uint256 amountInMax);

    /// @param maker The collateral holder providing liquidity (e.g. a satellite contract holding a
    /// resolved market's idle collateral)
    /// @param token0 First token in the pair (e.g. mUSD / real USDC)
    /// @param token1 Second token in the pair
    /// @param feeBps Swap fee in basis points, paid to the maker
    /// @param salt Lets the same maker run multiple independent strategies with identical parameters
    struct Strategy {
        address maker;
        address token0;
        address token1;
        uint256 feeBps;
        bytes32 salt;
    }

    uint256 internal constant BPS_BASE = 10_000;

    constructor(IAqua aqua_) AquaApp(aqua_) { }

    function quoteExactIn(Strategy calldata strategy, bool zeroForOne, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        bytes32 strategyHash = keccak256(abi.encode(strategy));
        (,, uint256 balanceIn, uint256 balanceOut) = _getInAndOut(strategy, strategyHash, zeroForOne);
        amountOut = _quoteExactIn(strategy, balanceIn, balanceOut, amountIn);
    }

    function swapExactIn(
        Strategy calldata strategy,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin,
        address to,
        bytes calldata takerData
    )
        external
        nonReentrantStrategy(strategy.maker, keccak256(abi.encode(strategy)))
        returns (uint256 amountOut)
    {
        bytes32 strategyHash = keccak256(abi.encode(strategy));

        (address tokenIn, address tokenOut, uint256 balanceIn, uint256 balanceOut) =
            _getInAndOut(strategy, strategyHash, zeroForOne);
        amountOut = _quoteExactIn(strategy, balanceIn, balanceOut, amountIn);
        require(amountOut >= amountOutMin, InsufficientOutputAmount(amountOut, amountOutMin));

        AQUA.pull(strategy.maker, strategyHash, tokenOut, amountOut, to);
        ICollateralYieldCallback(msg.sender).collateralYieldSwapCallback(
            tokenIn, tokenOut, amountIn, amountOut, strategy.maker, address(this), strategyHash, takerData
        );
        _safeCheckAquaPush(strategy.maker, strategyHash, tokenIn, balanceIn + amountIn);
    }

    function swapExactOut(
        Strategy calldata strategy,
        bool zeroForOne,
        uint256 amountOut,
        uint256 amountInMax,
        address to,
        bytes calldata takerData
    )
        external
        nonReentrantStrategy(strategy.maker, keccak256(abi.encode(strategy)))
        returns (uint256 amountIn)
    {
        bytes32 strategyHash = keccak256(abi.encode(strategy));

        (address tokenIn, address tokenOut, uint256 balanceIn, uint256 balanceOut) =
            _getInAndOut(strategy, strategyHash, zeroForOne);
        amountIn = _quoteExactOut(strategy, balanceIn, balanceOut, amountOut);
        require(amountIn <= amountInMax, ExcessiveInputAmount(amountIn, amountInMax));

        AQUA.pull(strategy.maker, strategyHash, tokenOut, amountOut, to);
        ICollateralYieldCallback(msg.sender).collateralYieldSwapCallback(
            tokenIn, tokenOut, amountIn, amountOut, strategy.maker, address(this), strategyHash, takerData
        );
        _safeCheckAquaPush(strategy.maker, strategyHash, tokenIn, balanceIn + amountIn);
    }

    function _quoteExactIn(Strategy calldata strategy, uint256 balanceIn, uint256 balanceOut, uint256 amountIn)
        internal
        pure
        returns (uint256 amountOut)
    {
        uint256 amountInWithFee = amountIn * (BPS_BASE - strategy.feeBps) / BPS_BASE;
        amountOut = (amountInWithFee * balanceOut) / (balanceIn + amountInWithFee);
    }

    function _quoteExactOut(Strategy calldata strategy, uint256 balanceIn, uint256 balanceOut, uint256 amountOut)
        internal
        pure
        returns (uint256 amountIn)
    {
        uint256 amountOutWithFee = amountOut * BPS_BASE / (BPS_BASE - strategy.feeBps);
        amountIn = (balanceIn * amountOutWithFee).ceilDiv(balanceOut - amountOutWithFee);
    }

    function _getInAndOut(Strategy calldata strategy, bytes32 strategyHash, bool zeroForOne)
        private
        view
        returns (address tokenIn, address tokenOut, uint256 balanceIn, uint256 balanceOut)
    {
        tokenIn = zeroForOne ? strategy.token0 : strategy.token1;
        tokenOut = zeroForOne ? strategy.token1 : strategy.token0;
        (balanceIn, balanceOut) = AQUA.safeBalances(strategy.maker, address(this), strategyHash, tokenIn, tokenOut);
    }
}
