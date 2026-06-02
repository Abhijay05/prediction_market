import { Alchemy, Network } from "alchemy-sdk";

const alchemy = new Alchemy({
  apiKey: process.env.ALCHEMY_API_KEY || "KArKrm6cqHCOaHJyXLEiv",
  network: Network.ETH_SEPOLIA,
});

async function main() {
  const routerAddress = "0x9cac07fd1a2196caf7c79932cf473bf0fb72ba9b";
  console.log("Fetching asset transfers for router:", routerAddress);

  try {
    const response = await alchemy.core.getAssetTransfers({
      fromBlock: "0x0",
      toBlock: "latest",
      fromAddress: routerAddress,
      category: ["external", "internal", "erc20", "erc721", "erc1155"] as any,
    });

    console.log(`Found ${response.transfers.length} transfers FROM router`);
    for (const transfer of response.transfers) {
      console.log(`Tx: ${transfer.hash}, To: ${transfer.to}, Value: ${transfer.value}, Asset: ${transfer.asset}`);
    }

    const responseTo = await alchemy.core.getAssetTransfers({
      fromBlock: "0x0",
      toBlock: "latest",
      toAddress: routerAddress,
      category: ["external", "internal", "erc20", "erc721", "erc1155"] as any,
    });

    console.log(`Found ${responseTo.transfers.length} transfers TO router`);
    for (const transfer of responseTo.transfers) {
      console.log(`Tx: ${transfer.hash}, From: ${transfer.from}, Value: ${transfer.value}, Asset: ${transfer.asset}`);
    }
  } catch (err) {
    console.error("Error fetching transfers:", err);
  }
}

main();
