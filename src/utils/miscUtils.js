import { customAlphabet } from "nanoid";

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const alphanumericNanoid = customAlphabet(alphabet, 16);

// custom alphabet, alphanumeric
export const getAlphanumericId = (length = 16) => {
  return alphanumericNanoid(length);
}

export const shortenAddress = (address, startLength = 6, endLength = 4) => {
  return address.slice(0, startLength) + "..." + address.slice(-endLength);
}

/**
 * Get APTOS explorer transaction link
 * @param {string} txHash - Transaction hash
 * @param {"TESTNET" | "MAINNET"} chain - APTOS chain type
 * @returns {string} Explorer URL
 */
export const getAptosExplorerTxLink = (txHash, chain = "TESTNET") => {
  if (chain === "TESTNET") {
    return `https://explorer.aptoslabs.com/txn/${txHash}?network=testnet`;
  }
  return `https://explorer.aptoslabs.com/txn/${txHash}?network=mainnet`;
};

/**
 * Get explorer transaction link for any supported chain
 * @param {string} txHash - Transaction hash
 * @param {"APTOS_TESTNET" | "APTOS_MAINNET"} chain - Chain type
 * @returns {string} Explorer URL
 */
export const getExplorerTxLink = (txHash, chain) => {
  // Handle APTOS chain
  if (chain === "APTOS_TESTNET" || chain === "APTOS_MAINNET") {
    return getAptosExplorerTxLink(
      txHash,
      chain === "APTOS_TESTNET" ? "TESTNET" : "MAINNET"
    );
  }

  throw new Error(`Unsupported chain: ${chain}`);
};

/**
 * Get APTOS explorer account link
 * @param {string} address - Account address
 * @param {"TESTNET" | "MAINNET"} chain - APTOS chain type
 * @returns {string} Explorer URL
 */
export const getAptosExplorerAccountLink = (address, chain = "TESTNET") => {
  if (chain === "TESTNET") {
    return `https://explorer.aptoslabs.com/account/${address}?network=testnet`;
  }
  return `https://explorer.aptoslabs.com/account/${address}?network=mainnet`;
};

/**
 * Get explorer account link for any supported chain
 * @param {string} address - Account address
 * @param {"APTOS_TESTNET" | "APTOS_MAINNET"} chain - Chain type
 * @returns {string} Explorer URL
 */
export const getExplorerAccountLink = (address, chain) => {
  // Handle APTOS chain
  if (chain === "APTOS_TESTNET" || chain === "APTOS_MAINNET") {
    return getAptosExplorerAccountLink(
      address,
      chain === "APTOS_TESTNET" ? "TESTNET" : "MAINNET"
    );
  }

  throw new Error(`Unsupported chain: ${chain}`);
};
