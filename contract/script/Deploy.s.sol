// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.19;

import {Script, console} from "forge-std/Script.sol";
import {Router} from "src/Router.sol";
import {MockUSD} from "src/MockUSD.sol";
import {DisputeResolverVRF} from "src/oracle/DisputeResolverVRF.sol";

contract Deploy is Script {
    uint256 constant INITIAL_LIQUIDITY = 10000 ether; // 10,000 mUSD
    uint256 constant SAMPLE_MARKET_DURATION = 7 days;

    // Sepolia testnet — public network constants, not secrets.
    address constant SEPOLIA_VRF_COORDINATOR = 0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B;
    address constant SEPOLIA_ETH_USD_FEED = 0x694AA1769357215DE4FAC081bf1f309aDC325306;
    int256 constant ORACLE_MARKET_STRIKE_PRICE = 3000e8; // $3,000, 8 decimals like the feed

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deploying from:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Reuse existing MockUSD (saves deployment gas)
        address mUSDAddress = 0x2296FA2947a3F59D1fbf5D43e97498c0120E1347;
        MockUSD mUSD = MockUSD(mUSDAddress);
        console.log("Reusing MockUSD at:", mUSDAddress);

        // 2. Deploy the shared Chainlink VRF dispute resolver.
        //    VRF_SUBSCRIPTION_ID and VRF_KEY_HASH must be set in contract/.env — see
        //    .agents/CREDENTIALS_CHECKLIST.md. RESOLVER_POOL defaults to just the
        //    deployer if not set, which works but should be expanded to several real
        //    addresses before the demo to make the "randomly selected" story real.
        uint256 vrfSubscriptionId = vm.envUint("VRF_SUBSCRIPTION_ID");
        bytes32 vrfKeyHash = vm.envBytes32("VRF_KEY_HASH");

        address[] memory defaultPool = new address[](1);
        defaultPool[0] = deployer;
        address[] memory resolverPool = vm.envOr("RESOLVER_POOL", ",", defaultPool);

        DisputeResolverVRF disputeResolver =
            new DisputeResolverVRF(SEPOLIA_VRF_COORDINATOR, vrfSubscriptionId, vrfKeyHash, resolverPool);
        console.log("DisputeResolverVRF deployed at:", address(disputeResolver));
        console.log("  -> add this address as a consumer on your VRF subscription at vrf.chain.link");

        // 3. Deploy Router
        Router router = new Router(mUSDAddress, address(disputeResolver));
        console.log("Router deployed at:", address(router));

        // 4. Mint tokens to deployer for sample markets
        mUSD.mint(deployer, INITIAL_LIQUIDITY * 2);
        console.log("Minted", (INITIAL_LIQUIDITY * 2) / 1e18, "mUSD to deployer");

        // 5. Create the original sample market — admin/optimistic resolution only,
        //    unchanged from the pre-existing (Continuity) behavior.
        mUSD.approve(address(router), INITIAL_LIQUIDITY);
        router.create(
            "Will ETH reach $10,000 by December 2026?",
            "This market resolves YES if ETH/USD spot price reaches or exceeds $10,000 on CoinGecko at any point before December 31, 2026 23:59 UTC.",
            "CoinGecko ETH/USD",
            false, // isDynamic
            SAMPLE_MARKET_DURATION,
            INITIAL_LIQUIDITY,
            address(0), // priceFeed — disabled, same as before this integration
            0,
            false
        );
        (address sampleMarket,) = router.getMarketAtIndex(0);
        console.log("Sample market (admin-resolved) deployed at:", sampleMarket);

        // 6. Create a second sample market that auto-resolves via the Chainlink
        //    Sepolia ETH/USD feed — this is the new Chainlink-track demo market.
        mUSD.approve(address(router), INITIAL_LIQUIDITY);
        router.create(
            "Will ETH exceed $3,000 (Chainlink-resolved)?",
            "Resolves YES if the Chainlink Sepolia ETH/USD feed reports >= $3,000 at or after the deadline. Anyone can call resolveWithChainlink() once the deadline passes.",
            "Chainlink ETH/USD Price Feed",
            false, // isDynamic
            SAMPLE_MARKET_DURATION,
            INITIAL_LIQUIDITY,
            SEPOLIA_ETH_USD_FEED,
            ORACLE_MARKET_STRIKE_PRICE,
            true // resolveYesIfAbove
        );
        (address oracleMarket,) = router.getMarketAtIndex(1);
        console.log("Sample market (Chainlink-resolved) deployed at:", oracleMarket);

        vm.stopBroadcast();

        // Output for frontend consumption
        console.log("\n=== DEPLOYMENT COMPLETE ===");
        console.log("NEXT_PUBLIC_MUSD_ADDRESS=", address(mUSD));
        console.log("NEXT_PUBLIC_ROUTER_ADDRESS=", address(router));
        console.log("NEXT_PUBLIC_DISPUTE_RESOLVER_ADDRESS=", address(disputeResolver));
        console.log("NEXT_PUBLIC_SAMPLE_MARKET=", sampleMarket);
        console.log("NEXT_PUBLIC_ORACLE_SAMPLE_MARKET=", oracleMarket);
    }
}
