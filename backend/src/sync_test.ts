import { Alchemy, Network } from "alchemy-sdk";
import { ethers } from "ethers";

const alchemy = new Alchemy({
  apiKey: process.env.ALCHEMY_API_KEY || "KArKrm6cqHCOaHJyXLEiv",
  network: Network.ETH_SEPOLIA,
});

const MARKET_ABI = [
  "event TokensPurchased(address indexed buyer, uint8 outcome, uint256 collateralIn, uint256 tokensOut)",
  "event TokensSold(address indexed seller, uint8 outcome, uint256 tokensIn, uint256 collateralOut)",
  "event MarketCreated(address indexed market, address indexed creator, uint256 initialLiquidity)",
  "event MarketResolved(uint8 winningOutcome, address indexed resolver)",
];

const iface = new ethers.Interface(MARKET_ABI);

async function main() {
  const routerAddress = "0x9cac07fd1a2196caf7c79932cf473bf0fb72ba9b";
  console.log("Fetching logs for router:", routerAddress);

  try {
    const logs = await alchemy.core.getLogs({
      address: routerAddress,
      fromBlock: 6000000,
      toBlock: "latest",
    });

    console.log(`Found ${logs.length} logs for router`);
    for (const log of logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed) {
          console.log(`Router Log: ${parsed.name}`, parsed.args);
        }
      } catch (e) {
        // Not our event
      }
    }
  } catch (err) {
    console.error("Error fetching logs:", err);
  }
}

main();
