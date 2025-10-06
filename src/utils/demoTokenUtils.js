// eslint-disable-next-line no-unused-vars
import { NetworkChain } from "@prisma/client";
import { prismaQuery } from "../lib/prisma.js";

// Queue system for throttling airdrop requests
const airdropQueue = [];
let isProcessing = false;
const AIRDROP_DELAY = 1000; // 1 second delay between airdrops

const processQueue = async () => {
  if (isProcessing || airdropQueue.length === 0) return;

  isProcessing = true;

  while (airdropQueue.length > 0) {
    const { userId, chain, resolve, reject } = airdropQueue.shift();

    try {
      const result = await executeDemoTokenSend({ userId, chain });
      resolve(result);
    } catch (error) {
      reject(error);
    }

    // Wait before processing next item to avoid rate limits
    if (airdropQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, AIRDROP_DELAY));
    }
  }

  isProcessing = false;
};

/**
 * @param {Object} params
 * @param {string} params.userId
 * @param {NetworkChain} params.chain
 */
export const sendDemoTokenToUser = async ({ userId, chain }) => {
  return new Promise((resolve, reject) => {
    airdropQueue.push({ userId, chain, resolve, reject });
    processQueue();
  });
};

/**
 * Internal function that executes the actual demo token send
 * @param {Object} params
 * @param {string} params.userId
 * @param {NetworkChain} params.chain
 */
const executeDemoTokenSend = async ({ userId, chain }) => {
  const user = await prismaQuery.user.findUnique({
    where: {
      id: userId
    },
    include: {
      wallets: true
    }
  });

  if (!user) {
    throw new Error("User not found");
  }

  if (chain === "APTOS_MAINNET" || chain === "APTOS_TESTNET") {
    // TODO: Implement Aptos demo token airdrop
    // This would need:
    // 1. Aptos airdropper wallet configuration
    // 2. Aptos demo token address
    // 3. Aptos SDK transaction building
    // 4. Aptos stealth payment logic
    throw new Error("Aptos demo token airdrop not yet implemented");
  }

  throw new Error(`Chain ${chain} not supported for demo token airdrop`);
};