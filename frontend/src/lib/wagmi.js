import { http, createConfig } from 'wagmi'
import { sepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

// RPC URL - using public Sepolia RPC (bypasses Alchemy app Sepolia block)
const ALCHEMY_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'

export const config = createConfig({
    chains: [sepolia],
    connectors: [
        injected(),
    ],
    transports: {
        [sepolia.id]: http(ALCHEMY_RPC),
    },
})

// Deployed Contract Addresses on Sepolia
export const ROUTER = '0x4293d76eF16B6f947050663298B818d51A0B6DD7'; // redeployed 2026-09-13 with Chainlink resolution
export const MOCK_USD = '0x2296fa2947a3f59d1fbf5d43e97498c0120e1347';
