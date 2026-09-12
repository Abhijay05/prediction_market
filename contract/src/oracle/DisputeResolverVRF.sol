// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.19;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

interface IDisputedMarket {
    function setSelectedResolver(address resolver) external;
}

/// @notice Replaces "a disputed market always falls back to one hardcoded admin" with a
/// verifiably-random resolver drawn from a small registered pool, using Chainlink VRF.
/// One instance is shared by every market a Router deploys (see Router.disputeResolver).
contract DisputeResolverVRF is VRFConsumerBaseV2Plus {
    event ResolverPoolUpdated(address[] resolvers);
    event ResolverRequested(address indexed market, uint256 indexed requestId);
    event ResolverSelected(address indexed market, uint256 indexed requestId, address resolver);

    uint256 public immutable i_subscriptionId;
    bytes32 public immutable i_keyHash;

    uint32 constant CALLBACK_GAS_LIMIT = 200_000;
    uint16 constant REQUEST_CONFIRMATIONS = 3;
    uint32 constant NUM_WORDS = 1;

    address[] public resolverPool;
    mapping(uint256 requestId => address market) public requestToMarket;

    constructor(
        address vrfCoordinator,
        uint256 subscriptionId,
        bytes32 keyHash,
        address[] memory initialResolvers
    ) VRFConsumerBaseV2Plus(vrfCoordinator) {
        require(initialResolvers.length > 0, "Need at least one resolver");
        i_subscriptionId = subscriptionId;
        i_keyHash = keyHash;
        resolverPool = initialResolvers;
        emit ResolverPoolUpdated(initialResolvers);
    }

    function setResolverPool(address[] calldata resolvers) external onlyOwner {
        require(resolvers.length > 0, "Need at least one resolver");
        resolverPool = resolvers;
        emit ResolverPoolUpdated(resolvers);
    }

    /// @dev Called by a market's dispute() once it enters the DISPUTED state. Anyone can
    /// technically call this directly, but it's only useful when invoked by a market that
    /// will honor the resulting setSelectedResolver() callback (msg.sender-gated there).
    function requestResolver(address market) external returns (uint256 requestId) {
        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: i_keyHash,
                subId: i_subscriptionId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: CALLBACK_GAS_LIMIT,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: false}))
            })
        );
        requestToMarket[requestId] = market;
        emit ResolverRequested(market, requestId);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        address market = requestToMarket[requestId];
        require(market != address(0), "Unknown request");

        address selected = resolverPool[randomWords[0] % resolverPool.length];
        IDisputedMarket(market).setSelectedResolver(selected);

        emit ResolverSelected(market, requestId, selected);
    }
}
