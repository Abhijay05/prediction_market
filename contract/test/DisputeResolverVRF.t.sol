// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Router} from "src/Router.sol";
import {LvrMarket} from "src/LvrMarket.sol";
import {MockUSD} from "src/MockUSD.sol";
import {DisputeResolverVRF} from "src/oracle/DisputeResolverVRF.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

contract DisputeResolverVRFTest is Test {
    uint256 constant INITIAL_LIQUIDITY = 1000 ether;
    uint256 constant MARKET_DURATION = 7 days;
    uint256 constant BOND_VALUE = 50;

    Router router;
    MockUSD mUSD;
    VRFCoordinatorV2_5Mock coordinator;
    DisputeResolverVRF disputeResolver;
    address market;
    bytes32 marketId;
    uint256 subId;

    address creator = makeAddr("creator");
    address proposerAddr = makeAddr("proposer");
    address resolverA = makeAddr("resolverA");
    address resolverB = makeAddr("resolverB");
    address resolverC = makeAddr("resolverC");

    function setUp() public {
        coordinator = new VRFCoordinatorV2_5Mock(0.1 ether, 1e9, 1e18);
        subId = coordinator.createSubscription();
        coordinator.fundSubscription(subId, 10 ether);

        address[] memory pool = new address[](3);
        pool[0] = resolverA;
        pool[1] = resolverB;
        pool[2] = resolverC;
        disputeResolver = new DisputeResolverVRF(address(coordinator), subId, bytes32(uint256(1)), pool);
        coordinator.addConsumer(subId, address(disputeResolver));

        mUSD = new MockUSD();
        router = new Router(address(mUSD), address(disputeResolver));

        mUSD.mint(creator, INITIAL_LIQUIDITY);
        mUSD.mint(proposerAddr, BOND_VALUE);

        vm.startPrank(creator);
        mUSD.approve(address(router), INITIAL_LIQUIDITY);
        router.create(
            "Will it dispute?",
            "desc",
            "manual",
            false,
            MARKET_DURATION,
            INITIAL_LIQUIDITY,
            address(0),
            0,
            false
        );
        (market, marketId) = router.getMarketAtIndex(0);
        vm.stopPrank();

        // Router's marketBondCallback pulls the bond from the proposer via transferFrom.
        vm.prank(proposerAddr);
        mUSD.approve(address(router), BOND_VALUE);
    }

    function _proposeAndDispute() internal returns (uint256 requestId) {
        vm.warp(block.timestamp + MARKET_DURATION + 1);

        vm.prank(proposerAddr);
        router.proposerOutcome(market, 1);

        vm.recordLogs();
        router.dispute(market);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == keccak256("DisputeResolverRequested(uint256)")) {
                requestId = uint256(entries[i].topics[1]); // indexed param lives in topics, not data
            }
        }
    }

    function test_DisputeTriggersVRFRequestAndSelectsResolver() public {
        uint256 requestId = _proposeAndDispute();

        coordinator.fulfillRandomWords(requestId, address(disputeResolver));

        address selected = LvrMarket(market).disputeResolverSelected();
        assertTrue(
            selected == resolverA || selected == resolverB || selected == resolverC,
            "Selected resolver should be from the registered pool"
        );
    }

    function test_SelectedResolverCanFinalize() public {
        uint256 requestId = _proposeAndDispute();
        coordinator.fulfillRandomWords(requestId, address(disputeResolver));

        address selected = LvrMarket(market).disputeResolverSelected();

        vm.prank(selected);
        LvrMarket(market).finalizeDisputedOutcome(1);

        (LvrMarket.MarketState state,, uint256 outcome,,,,,) = LvrMarket(market).getMarketDetails();
        assertEq(uint256(state), 4, "Should be RESOLVED");
        assertEq(outcome, 1, "Should resolve YES");
    }

    function test_NonSelectedResolverCannotFinalize() public {
        uint256 requestId = _proposeAndDispute();
        coordinator.fulfillRandomWords(requestId, address(disputeResolver));

        address selected = LvrMarket(market).disputeResolverSelected();
        address notSelected = selected == resolverA ? resolverB : resolverA;

        vm.prank(notSelected);
        vm.expectRevert(bytes("Not the selected resolver"));
        LvrMarket(market).finalizeDisputedOutcome(1);
    }

    function test_WithoutDisputeResolverConfiguredDisputeIsJustAStateChange() public {
        // A Router with no VRF dispute resolver behaves exactly as before.
        Router plainRouter = new Router(address(mUSD), address(0));
        mUSD.mint(creator, INITIAL_LIQUIDITY);

        vm.startPrank(creator);
        mUSD.approve(address(plainRouter), INITIAL_LIQUIDITY);
        plainRouter.create(
            "No VRF here", "desc", "manual", false, MARKET_DURATION, INITIAL_LIQUIDITY, address(0), 0, false
        );
        (address plainMarket,) = plainRouter.getMarketAtIndex(0);
        vm.stopPrank();

        vm.warp(block.timestamp + MARKET_DURATION + 1);
        vm.prank(proposerAddr);
        mUSD.approve(address(plainRouter), BOND_VALUE);
        vm.prank(proposerAddr);
        plainRouter.proposerOutcome(plainMarket, 1);

        plainRouter.dispute(plainMarket);

        (LvrMarket.MarketState state,,,,,,,) = LvrMarket(plainMarket).getMarketDetails();
        assertEq(uint256(state), 3, "Should be DISPUTED, with no automatic path forward");
        assertEq(LvrMarket(plainMarket).disputeResolverSelected(), address(0));
    }
}
