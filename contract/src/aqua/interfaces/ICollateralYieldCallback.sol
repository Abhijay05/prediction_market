// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

/// @notice Callback interface a taker must implement to swap through CollateralYieldStrategy.
/// Mirrors Aqua's own IXYCSwapCallback pattern: called after output tokens are sent but
/// before input-side validation, so the taker must push the input amount to the maker's
/// Aqua balance inside this callback.
interface ICollateralYieldCallback {
    function collateralYieldSwapCallback(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address maker,
        address app,
        bytes32 strategyHash,
        bytes calldata takerData
    ) external;
}
