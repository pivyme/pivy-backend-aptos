import { prismaQuery } from "../../lib/prisma.js";
import cron from "node-cron";
import { sleep } from "../../utils/miscUtils.js";
import { CHAINS } from "../../config.js";
import { getCronSchedule, logIndexerSpeedConfig } from "../../utils/cronUtils.js";

// Concurrency protection flags
let isFetchingTokenPrices = false;
let isFetchingMainPrice = false;
let isFetchingVerification = false;

/**
 * Get predefined image URL for a token from CHAINS config
 * @param {string} mintAddress - The token's mint address
 * @returns {string|null} The image URL if found, null otherwise
 */
const getPredefinedTokenImage = (mintAddress) => {
  for (const chainKey of Object.keys(CHAINS)) {
    const chain = CHAINS[chainKey];
    if (chain.tokens) {
      const token = chain.tokens.find(t => t.address === mintAddress);
      if (token) {
        return token.image;
      }
    }
  }
  return null;
};

/**
 * Fetch APT price from Pontem API
 * @returns {Promise<number>} The APT price in USD
 */
const fetchAptPrice = async () => {
  try {
    const response = await fetch('https://control.pontem.network/api/integrations/fiat-prices?currencies=apt');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    // The API returns an array with price data
    // Expected format: [{"price": 5.2885245375370395, "date": "...", "coinType": "apt", "currency": "apt"}]
    if (Array.isArray(data) && data.length > 0 && data[0].price) {
      return data[0].price;
    }
    throw new Error('Invalid response format from Pontem API');
  } catch (error) {
    console.log('Error fetching APT price from Pontem API:', error);
    return 0;
  }
};

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const aptosTokenWorker = (app, _, done) => {
  const updateTokenPrices = async () => {
    if (isFetchingTokenPrices) {
      console.log('Aptos token price update already in progress, skipping...');
      return;
    }

    isFetchingTokenPrices = true;

    try {
      // First, update APT price from Pontem API
      console.log('Updating APT price from Pontem API...');
      const aptPrice = await fetchAptPrice();

      // Update APT tokens in both mainnet and testnet
      const aptTokens = await prismaQuery.mintDataCache.findMany({
        where: {
          chain: {
            in: [CHAINS.APTOS_MAINNET.id, CHAINS.APTOS_TESTNET.id]
          },
          mintAddress: '0x1::aptos_coin::AptosCoin'
        }
      });

      for (const token of aptTokens) {
        try {
          await prismaQuery.mintDataCache.update({
            where: { id: token.id },
            data: { priceUsd: aptPrice }
          });
        } catch (error) {
          console.log('Error updating APT price for', token.symbol, ':', error);
        }
      }

      // Handle stablecoins - ensure they are always $1 (especially important for testnet)
      const stableCoins = ["USDC", "USDT", "DAI", "USDC.e", "USDT.e", "DAI.e", "FDUSD", "AUSD"];
      const tokens = await prismaQuery.mintDataCache.findMany({
        where: {
          chain: {
            in: [CHAINS.APTOS_MAINNET.id, CHAINS.APTOS_TESTNET.id]
          }
        },
        orderBy: {
          updatedAt: 'desc'
        }
      });

      const stableCoinTokens = tokens.filter(t =>
        stableCoins.includes(t.symbol) ||
        t.name.toLowerCase().includes('usd') ||
        t.symbol.toLowerCase().includes('usd') ||
        t.symbol.toLowerCase().includes('usdt') ||
        t.symbol.toLowerCase().includes('usdc')
      );

      for (const token of stableCoinTokens) {
        try {
          // Only update if price is significantly different from $1 (more than 5% deviation)
          if (!token.priceUsd || Math.abs(token.priceUsd - 1) > 0.05) {
            await prismaQuery.mintDataCache.update({
              where: { id: token.id },
              data: { priceUsd: 1 }
            });
            console.log(`Updated stablecoin ${token.symbol} to $1 USD`);
          }
        } catch (error) {
          console.log('Error updating stablecoin price for', token.symbol, ':', error);
        }
      }

      console.log('Token price update completed');
    } catch (error) {
      console.log('Error in updateTokenPrices:', error);
    } finally {
      isFetchingTokenPrices = false;
    }
  }

  const updateMainPrice = async () => {
    if (isFetchingMainPrice) {
      console.log('Aptos main price update already in progress, skipping...');
      return;
    }

    isFetchingMainPrice = true;

    try {
      const aptPriceUsd = await fetchAptPrice();

      await prismaQuery.mainPrice.upsert({
        where: {
          symbol: 'APT'
        },
        create: {
          symbol: 'APT',
          priceUsd: aptPriceUsd
        },
        update: {
          priceUsd: aptPriceUsd
        }
      })

      console.log('APT main price updated, APT price:', aptPriceUsd);
    } catch (error) {
      console.log('error updating main price', error);
    } finally {
      isFetchingMainPrice = false;
    }
  }

  const updateTokenVerification = async () => {
    if (isFetchingVerification) {
      console.log('Aptos token verification update already in progress, skipping...');
      return;
    }

    isFetchingVerification = true;

    try {
      console.log('Fetching Aptos verified tokens...');
      // For Aptos, we'll focus on native APT and well-known stablecoins
      const verifiedTokens = [
        {
          assetType: '0x1::aptos_coin::AptosCoin',
          symbol: 'APT',
          name: 'Aptos Coin',
          decimals: 8,
          isVerified: true
        },
        {
          assetType: '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832',
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: 6,
          isVerified: true
        }
      ];

      // Get both mainnet and testnet Aptos tokens from database
      const dbTokens = await prismaQuery.mintDataCache.findMany({
        where: {
          chain: {
            in: [CHAINS.APTOS_MAINNET.id, CHAINS.APTOS_TESTNET.id]
          }
        }
      });

      console.log(`Processing ${verifiedTokens.length} verified tokens, ${dbTokens.length} tokens in database`);

      // Create a map of verified token addresses for quick lookup
      const verifiedTokensMap = new Map();
      verifiedTokens.forEach(token => {
        verifiedTokensMap.set(token.assetType, {
          isVerified: token.isVerified,
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals
        });
      });

      // Update verification status for all tokens
      let updatedCount = 0;
      for (const dbToken of dbTokens) {
        try {
          const verifiedData = verifiedTokensMap.get(dbToken.mintAddress);

          let shouldUpdate = false;
          const updateData = {};

          // Check for predefined image from CHAINS config - ALWAYS do this regardless of verification
          const predefinedImage = getPredefinedTokenImage(dbToken.mintAddress);

          // Always set predefined image if available and token doesn't have one
          if (predefinedImage && !dbToken.imageUrl) {
            updateData.imageUrl = predefinedImage;
            shouldUpdate = true;
            console.log(`Setting predefined image for ${dbToken.symbol} (${dbToken.mintAddress}): ${predefinedImage}`);
          }

          // Only process verification updates if we have verified data from our list
          if (verifiedData) {
            // If token was previously verified, keep it verified but maybe update other data
            if (dbToken.isVerified) {
              // Update name and symbol if they're missing or different
              if (!dbToken.name || dbToken.name !== verifiedData.name) {
                updateData.name = verifiedData.name;
                shouldUpdate = true;
              }
              if (!dbToken.symbol || dbToken.symbol !== verifiedData.symbol) {
                updateData.symbol = verifiedData.symbol;
                shouldUpdate = true;
              }
              if (!dbToken.decimals || dbToken.decimals !== verifiedData.decimals) {
                updateData.decimals = verifiedData.decimals;
                shouldUpdate = true;
              }
            } else {
              // Token wasn't verified before, check if it should be verified now
              if (verifiedData.isVerified) {
                updateData.isVerified = true;
                updateData.name = verifiedData.name;
                updateData.symbol = verifiedData.symbol;
                updateData.decimals = verifiedData.decimals;
                shouldUpdate = true;
              }
            }
          }

          if (shouldUpdate) {
            await prismaQuery.mintDataCache.update({
              where: { id: dbToken.id },
              data: updateData
            });
            updatedCount++;
          }
        } catch (error) {
          console.log('Error updating verification for token', dbToken.symbol, ':', error);
        }
      }

      console.log(`Updated verification status for ${updatedCount} Aptos tokens`);
    } catch (error) {
      console.log('Error in updateTokenVerification:', error);
    } finally {
      isFetchingVerification = false;
    }
  }

  // Log indexer speed configuration
  logIndexerSpeedConfig();

  // Schedule based on INDEXER_SPEED environment variable
  const twoMinSchedule = getCronSchedule('everyTwoMinutes');
  const thirtySecSchedule = getCronSchedule('everyThirtySeconds');
  const hourlySchedule = getCronSchedule('everyHour');

  console.log(`🔄 Aptos Token worker schedules:`);
  console.log(`   - Update prices: ${twoMinSchedule}`);
  console.log(`   - Update main price: ${thirtySecSchedule}`);
  console.log(`   - Token verification: ${hourlySchedule}`);

  // Fetch APT price and update token prices
  updateTokenPrices();
  cron.schedule(twoMinSchedule, async () => {
    try {
      await updateTokenPrices();
    } catch (error) {
      console.log('Error updating token prices:', error);
    }
  });

  // Update APT main price only
  updateMainPrice();
  cron.schedule(thirtySecSchedule, async () => {
    try {
      await updateMainPrice();
    } catch (error) {
      console.log('Error updating main price:', error);
    }
  });

  // Token verification (Aptos verified tokens)
  updateTokenVerification();
  cron.schedule(hourlySchedule, async () => {
    try {
      await updateTokenVerification();
    } catch (error) {
      console.log('Error updating token verification:', error);
    }
  });

  done();
}
