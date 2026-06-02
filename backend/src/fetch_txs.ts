import { Alchemy, Network } from "alchemy-sdk";

const alchemy = new Alchemy({
  apiKey: process.env.ALCHEMY_API_KEY || "KArKrm6cqHCOaHJyXLEiv",
  network: Network.ETH_SEPOLIA,
});

async function main() {
  const marketAddress = "0x73B537F9E2fe2bfe30437e9e60A979eFBaFa353f";
  console.log("Fetching asset transfers for market:", marketAddress);

  try {
    const response = await alchemy.core.getAssetTransfers({
      fromBlock: "0x0",
      toBlock: "latest",
      toAddress: marketAddress,
      category: ["external", "internal", "erc20", "erc721", "erc1155"] as any,
    });

    console.log(`Found ${response.transfers.length} transfers`);
    for (const transfer of response.transfers) {
      console.log(`Tx: ${transfer.hash}, From: ${transfer.from}, Value: ${transfer.value}, Asset: ${transfer.asset}`);
    }
  } catch (err) {
    console.error("Error fetching transfers:", err);
  }
}

main();
