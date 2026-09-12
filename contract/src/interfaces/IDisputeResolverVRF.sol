// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

interface IDisputeResolverVRF {
    function requestResolver(address market) external returns (uint256 requestId);
}
