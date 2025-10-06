import { Ed25519PrivateKey, Account } from "@aptos-labs/ts-sdk";

// No RPC rotation needed for Aptos (for now)

export const CHAINS = {
  APTOS_MAINNET: {
    id: 'APTOS_MAINNET',
    rpcUrl: process.env.APTOS_RPC_MAINNET,
    publicRpcUrl: 'https://fullnode.mainnet.aptoslabs.com',
    explorerUrl: 'https://explorer.aptoslabs.com',
    pivyStealthProgramId: process.env.PIVY_STEALTH_PROGRAM_ID_APTOS_MAINNET,
    tokens: [
      {
        name: 'APT',
        symbol: 'APT',
        address: '0x1::aptos_coin::AptosCoin',
        decimals: 8,
        image: '/assets/tokens/apt.png',
        isNative: true,
      },
      {
        name: 'USD Coin',
        symbol: 'USDC',
        address: '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832',
        decimals: 6,
        image: '/assets/tokens/usdc.png',
        isNative: false,
      },
    ],
  },
  APTOS_TESTNET: {
    id: 'APTOS_TESTNET',
    rpcUrl: process.env.APTOS_RPC_TESTNET,
    publicRpcUrl: 'https://fullnode.testnet.aptoslabs.com',
    explorerUrl: 'https://explorer.aptoslabs.com',
    pivyStealthProgramId: process.env.PIVY_STEALTH_PROGRAM_ID_APTOS_TESTNET,
    tokens: [
      {
        name: 'APT',
        symbol: 'APT',
        address: '0x1::aptos_coin::AptosCoin',
        decimals: 8,
        image: '/assets/tokens/apt.png',
        isNative: true,
      },
      {
        name: 'USD Coin',
        symbol: 'USDC',
        // address: '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC',
        address: '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832',
        decimals: 6,
        image: '/assets/tokens/usdc.png',
        isNative: false,
      },
    ],
  },
}

export const isTestnet = process.env.CHAIN !== 'MAINNET';

export const FEE_TREASURY_ADDRESS = {
  APTOS: process.env.PIVY_FEE_TREASURY_ADDRESS_APTOS,
}

const aptosFeePayer = () => {
  try {
    const privateKeyHex = process.env.APTOS_FEE_PAYER_PK;
    if (!privateKeyHex) {
      console.warn("APTOS_FEE_PAYER_PK not set");
      return null;
    }
    const privateKey = new Ed25519PrivateKey(privateKeyHex);
    return Account.fromPrivateKey({ privateKey });
  } catch (e) {
    console.warn("Could not load APTOS_FEE_PAYER_PK", e.message);
    return null;
  }
}

export const GAS_SPONSORSHIP = {
  APTOS: {
    wallet: aptosFeePayer(),
    MAX_GAS_AMOUNT: 20000, // Max gas amount for transactions
    GAS_UNIT_PRICE_MULT: 1.15, // 15% buffer on gas price
    FEE_BPS: 0, // 0% withdrawal fee
    ONE_DAY_HARD_LIMIT: 1000000000n, // 10 APT per day limit
  },
}

export const WALLET_CHAINS = {
  APTOS: {
    id: 'APTOS',
    name: 'Aptos',
  },
}