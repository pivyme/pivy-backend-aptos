import { CHAINS } from "../config.js";
import { prismaQuery } from "../lib/prisma.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { getAptosPortfolio, createAptosClient } from "../utils/aptosUtils.js";
import { getCacheStats, cleanupOldCacheEntries } from "../utils/balanceCacheUtils.js";
import { getCombinedUserBalance, getBalanceCalculationStats } from "../utils/activityBalanceCalculator.js";
import { RESTRICTED_USERNAME } from "../constants/restricted-username.js";

// Simple in-memory cache implementation
const balanceCache = new Map();
const activitiesCache = new Map();
const CACHE_DURATION = 30 * 1000; // 30 seconds in milliseconds
const ACTIVITIES_CACHE_DURATION = 10 * 1000; // 10 seconds for activities

// Helper function to check if username is restricted
const isUsernameRestricted = (username) => {
  if (!username) return false;
  const normalizedUsername = username.toLowerCase().trim();
  return RESTRICTED_USERNAME.includes(normalizedUsername);
};


const getCachedBalance = (address, chain) => {
  const key = `${chain.id}_${address}`;
  const cached = balanceCache.get(key);
  if (!cached) return null;

  // Check if cache has expired
  if (Date.now() - cached.timestamp > CACHE_DURATION) {
    balanceCache.delete(key);
    return null;
  }

  return cached.data;
};

const setCachedBalance = (address, chain, data) => {
  const key = `${chain.id}_${address}`;
  balanceCache.set(key, {
    data,
    timestamp: Date.now()
  });
};

const getCachedActivities = (userId, chainIds, limit) => {
  const key = `${userId}_${chainIds.join(',')}_${limit}`;
  const cached = activitiesCache.get(key);
  if (!cached) return null;

  // Check if cache has expired
  if (Date.now() - cached.timestamp > ACTIVITIES_CACHE_DURATION) {
    activitiesCache.delete(key);
    return null;
  }

  return cached.data;
};

const setCachedActivities = (userId, chainIds, limit, data) => {
  const key = `${userId}_${chainIds.join(',')}_${limit}`;
  activitiesCache.set(key, {
    data,
    timestamp: Date.now()
  });
};

// Global function to invalidate activities cache for a user
global.invalidateActivitiesCache = (userId) => {
  // Remove all cached entries for this user
  for (const [key] of activitiesCache) {
    if (key.startsWith(`${userId}_`)) {
      activitiesCache.delete(key);
    }
  }
  console.log(`Activities cache invalidated for user: ${userId}`);
};

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const userRoutes = (app, _, done) => {
  app.get('/username/check', {
    config: {
      rateLimit: {
        max: 30, // Allow up to 30 username checks per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    // Check if username is available
    try {
      const { username } = request.query;

      // Validate username input
      if (!username || typeof username !== 'string') {
        return reply.status(400).send({
          message: "Oops! Something's not quite right with that username",
          error: "Please enter a valid username to check availability",
          suggestion: "Make sure your username is not empty and contains only text",
          data: null,
        });
      }

      // Check if username is restricted
      if (isUsernameRestricted(username)) {
        return reply.status(200).send({
          isAvailable: false,
          reason: "Sorry, this username is reserved for system use",
          suggestion: "Try a different username, most creative ones are still available!"
        });
      }

      const user = await prismaQuery.user.findUnique({
        where: {
          username: username.trim()
        }
      })

      return reply.status(200).send({
        isAvailable: !user
      })
    } catch (error) {
      console.log('Error checking username', error);
      return reply.status(500).send({
        message: "We're having trouble checking that username right now",
        error: "Please try again in a moment",
        suggestion: "If the problem persists, feel free to reach out to our support team",
        data: null,
      });
    }
  })

  app.post('/username/set', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 10, // Allow up to 10 username updates per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { username } = request.body;

      // Validate username input
      if (!username || typeof username !== 'string') {
        return reply.status(400).send({
          message: "Oops! Something's not quite right with that username",
          error: "Please provide a valid username to set",
          suggestion: "Make sure your username is not empty and contains only text",
          data: null,
        });
      }

      // Validate username format - only lowercase letters and numbers allowed
      if (!/^[a-z0-9]+$/.test(username.trim())) {
        return reply.status(400).send({
          message: "Username contains invalid characters",
          error: "Only lowercase letters (a-z) and numbers (0-9) are allowed in usernames",
          suggestion: "Please use only lowercase letters and numbers without spaces or special characters",
          data: null,
        });
      }

      // Check if username is restricted
      if (isUsernameRestricted(username)) {
        return reply.status(400).send({
          message: "That username is reserved for system use",
          error: "This username cannot be used as it's needed for platform features",
          suggestion: "Choose something unique and personal - there are plenty of great options available!",
          data: null,
        });
      }

      // 20 characters max
      if (username.trim().length > 20 || username.trim().length < 3) {
        return reply.status(400).send({
          message: "Username is too long or too short",
          error: "Please choose a username that is 3-20 characters",
          suggestion: "Try adding some numbers, your initials, or a fun twist to make it unique!",
          data: null,
        });
      }

      // No space please
      if (username.trim().includes(' ')) {
        return reply.status(400).send({
          message: "Username cannot contain spaces",
          error: "Please choose a username that does not contain spaces",
          suggestion: "Try adding some numbers, your initials, or a fun twist to make it unique!",
          data: null,
        });
      }

      // Check if username is already taken by another user
      const existingUser = await prismaQuery.user.findUnique({
        where: {
          username: username.trim()
        }
      });

      if (existingUser && existingUser.id !== request.user.id) {
        return reply.status(400).send({
          message: "Username is already taken",
          error: "Someone else already chose this username",
          suggestion: "Try adding some numbers, your initials, or a fun twist to make it unique!",
          data: null,
        });
      }

      const user = await prismaQuery.user.update({
        where: {
          id: request.user.id
        },
        data: {
          username: username.trim(),
        }
      })

      return reply.status(200).send(user);
    } catch (error) {
      console.log('Error setting username', error);
      return reply.status(500).send({
        message: "We're having trouble updating your username right now",
        error: "Please try again in a moment",
        suggestion: "If the problem continues, our support team would be happy to help",
        data: null,
      });
    }
  })

  app.get("/balance/:address", {
    config: {
      rateLimit: {
        max: 60, // Allow up to 60 balance requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (req, reply) => {
    try {
      const { address } = req.params;
      const chainQuery = req.query.chain;
      console.log('chainQuery', chainQuery)

      if (!address) {
        return reply.code(400).send({
          message: "Address is required",
        });
      }

      const chain = CHAINS[chainQuery]
      if (!chain?.id) {
        return reply.code(400).send({
          message: "Invalid chain",
        });
      }

      // Check cache first with chain-specific key
      const cachedBalance = getCachedBalance(address, chain);
      if (cachedBalance) {
        return reply.code(200).send(cachedBalance);
      }

      // Aptos
      if (chain.id === "APTOS_MAINNET" || chain.id === "APTOS_TESTNET") {
        const aptosClient = createAptosClient(chain.id);
        const portfolioInfo = await getAptosPortfolio(address, chain.id, aptosClient);

        // Cache the result before sending with chain-specific key
        setCachedBalance(address, chain, portfolioInfo);

        return reply.code(200).send(portfolioInfo);
      }
    } catch (error) {
      console.log("Error getting portfolio info: ", error)
      return reply.code(500).send({
        message: error.message,
        data: null,
      });
    }
  })



  // Balance calculation statistics endpoint (for monitoring)
  app.get('/balance/stats', {
    config: {
      rateLimit: {
        max: 30, // Allow up to 30 stats requests per minute
        timeWindow: '1 minute'
      }
    }
  }, async (req, reply) => {
    try {
      const stats = await getBalanceCalculationStats();
      return reply.code(200).send(stats);
    } catch (error) {
      console.error("Error getting balance stats:", error);
      return reply.code(500).send({
        message: error.message,
        data: null,
      });
    }
  })

  app.get('/activities', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 120, // Allow up to 60 activity requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const chainQuery = request.query.chain;
      const limit = parseInt(request.query.limit) || 100; // Default limit to 100 activities
      let chains = [];

      // Handle comma-separated chains
      if (chainQuery) {
        const chainIds = chainQuery.split(',');
        chains = chainIds.map(id => CHAINS[id.trim()]).filter(Boolean);
        if (chains.length === 0) {
          return reply.code(400).send({
            message: "Invalid chain",
          });
        }
      } else {
        // Default to Aptos testnet if none specified
        chains = [CHAINS.APTOS_TESTNET];
      }

      // Check cache first
      const chainIds = chains.map(c => c.id);
      const cachedActivities = getCachedActivities(request.user.id, chainIds, limit);
      if (cachedActivities) {
        return reply.send(cachedActivities);
      }

      // Process all chains in parallel for better performance
      const chainPromises = chains.map(async (chain) => {
        try {
          // Execute payment, withdrawal, and withdrawal group queries in parallel
          const [payments, withdrawals, withdrawalGroups] = await Promise.all([
            // Get all payments for the user's links
            prismaQuery.payment.findMany({
              where: {
                link: {
                  userId: request.user.id
                },
                chain: chain.id
              },
              include: {
                // Include token data
                mint: {
                  select: {
                    chain: true,
                    mintAddress: true,
                    priceUsd: true,
                    name: true,
                    symbol: true,
                    decimals: true,
                    imageUrl: true
                  }
                },
                // Include link data
                link: {
                  select: {
                    id: true,
                    label: true,
                    emoji: true,
                    backgroundColor: true,
                    tag: true,
                    type: true,
                    amountType: true
                  }
                },
                // Include payer user data
                payerUser: {
                  select: {
                    username: true,
                    profileImageType: true,
                    profileImageData: true
                  }
                },
                // Include payment info data
                paymentInfo: {
                  select: {
                    id: true,
                    collectedData: true
                  }
                }
              },
              orderBy: {
                timestamp: 'desc'
              },
              take: Math.min(limit * 2, 500) // Fetch more than needed to account for filtering
            }),

            // Get all withdrawals for the user
            prismaQuery.withdrawal.findMany({
              where: {
                userId: request.user.id,
                chain: chain.id
              },
              include: {
                mint: {
                  select: {
                    name: true,
                    symbol: true,
                    decimals: true,
                    imageUrl: true,
                    mintAddress: true,
                    priceUsd: true
                  }
                },
                // Include destination user data
                destinationUser: {
                  select: {
                    username: true,
                    profileImageType: true,
                    profileImageData: true
                  }
                }
              },
              orderBy: {
                timestamp: 'desc'
              },
              take: Math.min(limit * 2, 500) // Fetch more than needed to account for filtering
            }),

            // Get all withdrawal groups for the user
            prismaQuery.withdrawalGroup.findMany({
              where: {
                userId: request.user.id,
                chain: chain.id
              },
              orderBy: {
                createdAt: 'desc'
              }
            })
          ]);

          // Transform payment data for frontend consumption
          const paymentActivities = payments.map(payment => ({
            id: payment.id,
            type: 'PAYMENT',
            timestamp: payment.timestamp,
            txHash: payment.txHash,
            amount: payment.amount.toString(),
            uiAmount: Number(payment.amount) / Math.pow(10, payment.mint.decimals),
            token: {
              symbol: payment.mint.symbol,
              name: payment.mint.name,
              decimals: payment.mint.decimals,
              imageUrl: payment.mint.imageUrl,
              mintAddress: payment.mint.mintAddress,
              priceUsd: payment.mint.priceUsd || 0,
              isVerified: payment.mint.isVerified,
              isNative: payment.mint.isNative || false
            },
            usdValue: payment.mint.priceUsd ? (Number(payment.amount) / Math.pow(10, payment.mint.decimals)) * payment.mint.priceUsd : 0,
            link: payment.link ? {
              id: payment.link.id,
              label: payment.link.label,
              emoji: payment.link.emoji,
              backgroundColor: payment.link.backgroundColor,
              tag: payment.link.tag,
              type: payment.link.type,
              amountType: payment.link.amountType
            } : null,
            from: payment.payerPubKey,
            // Add fromUser if payerUser exists
            ...(payment.payerUser && {
              fromUser: {
                username: payment.payerUser.username,
                profileImageType: payment.payerUser.profileImageType,
                profileImageData: payment.payerUser.profileImageData
              }
            }),
            isAnnounce: payment.announce,
            chain: payment.chain,
            // Add payment info if it exists
            ...(payment.paymentInfo && {
              paymentInfo: {
                id: payment.paymentInfo.id,
                collectedData: payment.paymentInfo.collectedData
              }
            })
          }));

          // Create a map of txHash to withdrawal group ID
          const txHashToGroupId = {};
          withdrawalGroups.forEach(group => {
            group.txHashes.forEach(txHash => {
              txHashToGroupId[txHash] = group.id;
            });
          });

          // Group withdrawals by withdrawal group or txHash
          const groupedWithdrawals = withdrawals.reduce((acc, withdrawal) => {
            // Determine the grouping key - use group ID if exists, otherwise use txHash
            const groupKey = txHashToGroupId[withdrawal.txHash] || withdrawal.txHash;
            const isPartOfGroup = !!txHashToGroupId[withdrawal.txHash];

            if (!acc[groupKey]) {
              acc[groupKey] = {
                id: groupKey,
                txHash: isPartOfGroup ? null : withdrawal.txHash, // Only set single txHash if not part of group
                txHashes: isPartOfGroup ? [] : [withdrawal.txHash], // Array of all txHashes in this group
                isGroup: isPartOfGroup,
                type: 'WITHDRAWAL',
                timestamp: withdrawal.timestamp,
                chain: withdrawal.chain,
                destinationPubkey: withdrawal.destinationPubkey,
                // Store destination user info from the first withdrawal
                destinationUser: withdrawal.destinationUser,
                // Group amounts by token
                tokens: {}
              };
            }

            // If it's a group, track all unique txHashes
            if (isPartOfGroup && !acc[groupKey].txHashes.includes(withdrawal.txHash)) {
              acc[groupKey].txHashes.push(withdrawal.txHash);
            }

            // Use the earliest timestamp for the group
            if (withdrawal.timestamp < acc[groupKey].timestamp) {
              acc[groupKey].timestamp = withdrawal.timestamp;
            }

            // Add or update token amount
            const token = withdrawal.mint;
            const tokenKey = token.symbol;
            if (!acc[groupKey].tokens[tokenKey]) {
              acc[groupKey].tokens[tokenKey] = {
                symbol: token.symbol,
                name: token.name,
                decimals: token.decimals,
                imageUrl: token.imageUrl,
                mintAddress: token.mintAddress,
                priceUsd: token.priceUsd || 0,
                isVerified: token.isVerified,
                isNative: token.isNative || false,
                total: "0",
                uiTotal: 0,
                feeAmount: "0",
                uiFeeAmount: 0
              };
            }

            // Add the amounts (they are strings, so we need to convert to BigInt)
            // For activities display, use the original amount (what user requested)
            const currentTotal = BigInt(acc[groupKey].tokens[tokenKey].total);
            const newAmount = BigInt(withdrawal.amount);
            const newTotal = (currentTotal + newAmount).toString();
            acc[groupKey].tokens[tokenKey].total = newTotal;
            acc[groupKey].tokens[tokenKey].uiTotal = Number(newTotal) / Math.pow(10, token.decimals);

            // Calculate fee amount if amountAfterFee is available
            if (withdrawal.amountAfterFee) {
              const feeAmount = BigInt(withdrawal.amountAfterFee) - BigInt(withdrawal.amount);
              if (!acc[groupKey].tokens[tokenKey].feeAmount) {
                acc[groupKey].tokens[tokenKey].feeAmount = "0";
                acc[groupKey].tokens[tokenKey].uiFeeAmount = 0;
              }
              const currentFeeTotal = BigInt(acc[groupKey].tokens[tokenKey].feeAmount);
              const newFeeTotal = (currentFeeTotal + feeAmount).toString();
              acc[groupKey].tokens[tokenKey].feeAmount = newFeeTotal;
              acc[groupKey].tokens[tokenKey].uiFeeAmount = Number(newFeeTotal) / Math.pow(10, token.decimals);
            }

            return acc;
          }, {});

          // Transform withdrawals into the same format as payments
          const withdrawalActivities = Object.values(groupedWithdrawals).map(withdrawal => {
            const [firstToken, ...otherTokens] = Object.values(withdrawal.tokens);
            const usdValue = firstToken.priceUsd ? (Number(firstToken.total) / Math.pow(10, firstToken.decimals)) * firstToken.priceUsd : 0;
            const feeUsdValue = firstToken.priceUsd && firstToken.uiFeeAmount ? firstToken.uiFeeAmount * firstToken.priceUsd : 0;
            return {
              id: withdrawal.id,
              txHash: withdrawal.txHash, // Will be null for grouped withdrawals
              txHashes: withdrawal.txHashes, // Array of all transaction hashes in this group
              isGroup: withdrawal.isGroup, // Whether this is a grouped withdrawal
              withdrawalCount: withdrawal.txHashes.length, // Number of withdrawals in this group
              type: 'WITHDRAWAL',
              timestamp: withdrawal.timestamp,
              chain: withdrawal.chain,
              destinationPubkey: withdrawal.destinationPubkey,
              amount: firstToken.total,
              uiAmount: firstToken.uiTotal,
              feeAmount: firstToken.feeAmount,
              uiFeeAmount: firstToken.uiFeeAmount,
              token: {
                symbol: firstToken.symbol,
                name: firstToken.name,
                decimals: firstToken.decimals,
                imageUrl: firstToken.imageUrl,
                mintAddress: firstToken.mintAddress,
                priceUsd: firstToken.priceUsd || 0,
                isVerified: firstToken.isVerified,
                isNative: firstToken.isNative || false
              },
              usdValue,
              feeUsdValue,
              ...(withdrawal.destinationUser && {
                toUser: {
                  username: withdrawal.destinationUser.username,
                  profileImageType: withdrawal.destinationUser.profileImageType,
                  profileImageData: withdrawal.destinationUser.profileImageData
                }
              }),
              additionalTokens: otherTokens.length > 0 ? otherTokens.map(token => ({
                ...token,
                amount: token.total,
                uiAmount: token.uiTotal
              })) : undefined
            };
          });

          let chainActivities = [...paymentActivities, ...withdrawalActivities];

          // Return chain activities
          return chainActivities;
        } catch (error) {
          console.error(`Error fetching activities for chain ${chain.id}:`, error);
          // Return empty array if chain fails
          return [];
        }
      });

      // Execute all chain promises in parallel and flatten results
      const chainResults = await Promise.all(chainPromises);
      const allActivities = chainResults.flat();

      // Sort all activities by timestamp and apply limit
      allActivities.sort((a, b) => b.timestamp - a.timestamp);

      // Apply limit to final results
      const limitedActivities = allActivities.slice(0, limit);

      // Cache the results
      setCachedActivities(request.user.id, chainIds, limit, limitedActivities);

      return reply.send(limitedActivities);
    } catch (error) {
      console.error('Error fetching activities:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch activities'
      });
    }
  })

  app.get('/balances', {
    preHandler: [
      authMiddleware,
      //  performanceMonitor('GET /balances')
    ],
    config: {
      rateLimit: {
        max: 60, // Allow up to 60 balance requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const chainQuery = request.query.chain;
      const limit = parseInt(request.query.limit) || null;
      let chains = [];

      // Handle comma-separated chains
      if (chainQuery) {
        const chainIds = chainQuery.split(',');
        chains = chainIds.map(id => CHAINS[id.trim()]).filter(Boolean);
        if (chains.length === 0) {
          return reply.code(400).send({
            message: "Invalid chain",
          });
        }
      } else {
        // Default to Aptos testnet if none specified
        chains = [CHAINS.APTOS_TESTNET];
      }

      // Check for high-precision flag for accuracy-critical requests
      const useHighPrecision = request.query.precision === 'high' || request.query.accurate === 'true';
      console.log(`🚀 ${useHighPrecision ? 'High-precision' : 'Fast activity-based'} balances for user ${request.user.id} on chains: ${chains.map(c => c.id).join(', ')}`);

      let allBalances = [];

      // Use new activity-based calculation for lightning-fast responses
      const balancePromises = chains.map(async (chain) => {
        try {
          const balanceData = await getCombinedUserBalance(request.user.id, chain.id);

          return {
            chain: chain.id,
            ...balanceData
          };
        } catch (error) {
          console.error(`Error fetching balances for chain ${chain.id}:`, error);
          // Return empty structure if chain fails
          return {
            chain: chain.id,
            native: { total: 0, usdValue: 0 },
            tokens: [],
            summary: { totalBalanceUsd: 0, tokensCount: 0, stealthAddressCount: 0 }
          };
        }
      });

      // Execute all chain requests in parallel
      allBalances = await Promise.all(balancePromises);

      // If specific single chain was requested, return just that chain's data
      if (chainQuery && !chainQuery.includes(',')) {
        const singleChainData = allBalances[0] || {
          tokens: [],
          native: { total: 0, usdValue: 0 },
          summary: { totalBalanceUsd: 0, tokensCount: 0, stealthAddressCount: 0 }
        };

        // Sort tokens by USD value for single chain response
        if (singleChainData.tokens) {
          // Add isMultichain flag to single-chain tokens for consistency
          singleChainData.tokens = singleChainData.tokens.map(token => ({
            ...token,
            isMultichain: false
          }));

          singleChainData.tokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
          // Apply limit if specified
          if (limit && singleChainData.tokens.length > limit) {
            singleChainData.tokens = singleChainData.tokens.slice(0, limit);
          }
        }

        return reply.send(singleChainData);
      }

      // Merge all balances into a single structure
      let totalNative = 0;
      let totalNativeUsd = 0;
      const tokenMap = new Map(); // Will store tokens grouped by symbol
      let totalStealthAddressCount = 0;

      allBalances.forEach(balance => {
        // 🔧 FIXED: Handle new structure where native tokens are in tokens array
        totalStealthAddressCount += balance.summary?.stealthAddressCount || 0;

        // Find native tokens in the tokens array and separate them
        let nativeTokens = [];
        let otherTokens = [];

        if (balance.tokens) {
          balance.tokens.forEach(token => {
            if (token.isNative) {
              nativeTokens.push(token);
            } else {
              otherTokens.push(token);
            }
          });
        }

        console.log(`🔍 [ROUTE-DEBUG] Chain ${balance.chain}: ${nativeTokens.length} native, ${otherTokens.length} other tokens`);
        if (nativeTokens.length > 0) {
          console.log(`   Native tokens: ${nativeTokens.map(t => `${t.symbol}=${t.total}`).join(', ')}`);
        }

        // Aggregate native token balances
        nativeTokens.forEach(nativeToken => {
          totalNative += nativeToken.total || 0;
          totalNativeUsd += nativeToken.usdValue || 0;
        });

        // Aggregate other tokens from all chains with multichain support
        if (otherTokens.length > 0) {
          otherTokens.forEach(token => {
            // Use symbol + name + mintAddress as the grouping key for multichain detection
            // This ensures that different tokens with same symbol are NOT merged
            const tokenKey = `${token.symbol.toLowerCase()}_${token.name.toLowerCase()}_${token.mintAddress}`;

            if (tokenMap.has(tokenKey)) {
              const existingToken = tokenMap.get(tokenKey);

              // If this is the first time seeing this token on multiple chains
              if (!existingToken.isMultichain) {
                // Convert to multichain structure
                existingToken.isMultichain = true;
                existingToken.chainBalances = [{
                  chain: existingToken.chain,
                  mintAddress: existingToken.mintAddress,
                  imageUrl: existingToken.imageUrl,
                  isVerified: existingToken.isVerified,
                  isNative: existingToken.isNative || false,
                  decimals: existingToken.decimals,
                  total: existingToken.total,
                  usdValue: existingToken.usdValue || 0
                }];
                // Remove single-chain properties and chain-specific properties
                delete existingToken.chain;
                delete existingToken.mintAddress;
                delete existingToken.imageUrl;
                delete existingToken.isVerified;
                delete existingToken.isNative;
                delete existingToken.decimals;
              }

              // Add this chain's balance to the multichain token
              existingToken.chainBalances.push({
                chain: balance.chain,
                mintAddress: token.mintAddress,
                imageUrl: token.imageUrl,
                isVerified: token.isVerified,
                isNative: token.isNative || false,
                decimals: token.decimals,
                total: token.total,
                usdValue: token.usdValue || 0
              });

              // Update totals
              existingToken.total += token.total;
              existingToken.usdValue += token.usdValue || 0;

              // For multichain tokens, we don't update top-level chain-specific properties
              // as they are stored in chainBalances array

            } else {
              // First time seeing this token
              tokenMap.set(tokenKey, {
                ...token,
                isMultichain: false,
                chain: balance.chain
              });
            }
          });
        }

        // Also add native tokens to the token map for complete token listing
        nativeTokens.forEach(nativeToken => {
          const tokenKey = `${nativeToken.symbol.toLowerCase()}_${nativeToken.name.toLowerCase()}_${nativeToken.mintAddress}`;

          if (!tokenMap.has(tokenKey)) {
            tokenMap.set(tokenKey, {
              ...nativeToken,
              isMultichain: false,
              chain: balance.chain
            });
          }
        });
      });

      let mergedTokens = Array.from(tokenMap.values())
        .filter(token => token.total > 0.00001)
        .sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));

      // Apply limit if specified
      if (limit && mergedTokens.length > limit) {
        mergedTokens = mergedTokens.slice(0, limit);
      }

      // Calculate USD values separately for native and non-native tokens to avoid double counting
      const nonNativeTokensUsd = mergedTokens
        .filter(token => !token.isNative)
        .reduce((sum, token) => sum + (token.usdValue || 0), 0);

      const totalBalanceUsd = totalNativeUsd + nonNativeTokensUsd;

      const mergedResult = {
        native: {
          total: totalNative,
          usdValue: totalNativeUsd
        },
        tokens: mergedTokens,
        summary: {
          totalBalanceUsd,
          tokensCount: mergedTokens.length,
          stealthAddressCount: totalStealthAddressCount
        },
        calculationMethod: 'activity_based',
        responseTime: new Date(),
        // Additional metrics automatically added by middleware
        chainsProcessed: chains.length,
        tokensProcessed: mergedTokens.length
      };

      return reply.send(mergedResult);

    } catch (error) {
      console.error('Error fetching balances:', error);
      return reply.status(500).send({
        error: 'Failed to fetch balances'
      });
    }
  })

  // 🔄 FORCE BALANCE RECONCILIATION: For users experiencing discrepancies
  app.post('/balances/reconcile', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 5, // Limit reconciliation attempts
        timeWindow: '10 minutes'
      }
    }
  }, async (request, reply) => {
    try {
      const { chain } = request.body;
      const userId = request.user.id;

      if (!chain) {
        return reply.code(400).send({ error: 'Chain parameter required' });
      }

      const chainConfig = CHAINS[chain];
      if (!chainConfig) {
        return reply.code(400).send({ error: 'Invalid chain' });
      }

      console.log(`🔄 [RECONCILE] Starting balance reconciliation for user ${userId} on ${chain}`);

      // Get user's stealth addresses
      const userAddresses = await prismaQuery.payment.findMany({
        where: { link: { userId }, chain },
        select: { stealthOwnerPubkey: true },
        distinct: ['stealthOwnerPubkey'],
        take: 100 // Limit for performance
      });

      console.log(`🔄 [RECONCILE] Found ${userAddresses.length} addresses to validate`);

      // Get current balance before reconciliation
      const beforeBalance = await getCombinedUserBalance(userId, chain);

      // Force RPC validation for addresses (import processAddress from balanceWorker)
      const { processAddress } = await import('../workers/balanceWorker.js');

      let validatedCount = 0;
      const results = [];

      for (const { stealthOwnerPubkey } of userAddresses.slice(0, 15)) { // Limit to 15 for manual reconciliation
        try {
          const addressData = { address: stealthOwnerPubkey, userId, priority: 'high' };
          await processAddress(addressData, chain, true); // Force validation
          validatedCount++;
          results.push({ address: stealthOwnerPubkey.substring(0, 10) + '...', status: 'validated' });

          // Rate limiting between RPC calls
          await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
          console.error(`Failed to validate ${stealthOwnerPubkey}:`, error.message);
          results.push({ address: stealthOwnerPubkey.substring(0, 10) + '...', status: 'error', error: error.message.substring(0, 50) });
        }
      }

      // Get fresh balance after reconciliation
      const afterBalance = await getCombinedUserBalance(userId, chain);

      const beforeUsd = beforeBalance?.summary?.totalBalanceUsd || 0;
      const afterUsd = afterBalance?.summary?.totalBalanceUsd || 0;
      const difference = afterUsd - beforeUsd;

      console.log(`🔄 [RECONCILE] Completed: ${validatedCount}/${userAddresses.length} addresses. Balance: $${beforeUsd.toFixed(6)} → $${afterUsd.toFixed(6)} (${difference >= 0 ? '+' : ''}${difference.toFixed(6)})`);

      return reply.send({
        success: true,
        reconciliation: {
          beforeBalance: beforeUsd,
          afterBalance: afterUsd,
          difference: difference,
          improvementPercent: beforeUsd > 0 ? ((difference / beforeUsd) * 100).toFixed(2) : '0'
        },
        validation: {
          totalAddresses: userAddresses.length,
          validatedCount,
          successRate: `${((validatedCount / Math.min(userAddresses.length, 15)) * 100).toFixed(1)}%`
        },
        newBalance: afterBalance,
        message: `Reconciled ${validatedCount} addresses. Balance change: ${difference >= 0 ? '+' : ''}$${Math.abs(difference).toFixed(6)}`
      });

    } catch (error) {
      console.error('Balance reconciliation error:', error);
      return reply.code(500).send({ error: 'Reconciliation failed', details: error.message });
    }
  })


  // Cache management endpoints
  app.get('/cache/stats', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 30, // Allow up to 30 cache stats requests per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const stats = await getCacheStats();
      return reply.send(stats);
    } catch (error) {
      console.error('Error getting cache stats:', error);
      return reply.status(500).send({
        error: 'Failed to get cache stats'
      });
    }
  })

  app.post('/cache/cleanup', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 5, // Allow up to 5 cache cleanup operations per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      await cleanupOldCacheEntries();
      return reply.send({ success: true, message: 'Cache cleanup completed' });
    } catch (error) {
      console.error('Error during cache cleanup:', error);
      return reply.status(500).send({
        error: 'Failed to cleanup cache'
      });
    }
  })

  // Save Aptos withdrawal group
  app.post('/aptos/withdrawal-group', {
    preHandler: [authMiddleware]
  }, async (request, reply) => {
    try {
      const { withdrawalId } = request.body;
      const { chain } = request.query;

      if (!withdrawalId) {
        return reply.status(400).send({
          success: false,
          message: 'withdrawalId is required',
          error: 'MISSING_WITHDRAWAL_ID',
          data: null
        });
      }

      if (!chain) {
        return reply.status(400).send({
          success: false,
          message: 'chain query parameter is required',
          error: 'MISSING_CHAIN',
          data: null
        });
      }

      // Validate chain
      const chainConfig = CHAINS[chain];
      if (!chainConfig || (chainConfig.id !== 'APTOS_MAINNET' && chainConfig.id !== 'APTOS_TESTNET')) {
        return reply.status(400).send({
          success: false,
          message: 'Invalid chain',
          error: 'INVALID_CHAIN',
          data: null
        });
      }

      // Parse the withdrawalId which is pipe-separated transaction hashes
      const txHashes = withdrawalId.split('|').filter(hash => hash.trim().length > 0);

      if (txHashes.length === 0) {
        return reply.status(400).send({
          success: false,
          message: 'Invalid withdrawalId format',
          error: 'INVALID_WITHDRAWAL_ID',
          data: null
        });
      }

      // Save the withdrawal group to database
      const withdrawalGroup = await prismaQuery.withdrawalGroup.create({
        data: {
          userId: request.user.id,
          chain: chainConfig.id,
          txHashes: txHashes
        }
      });

      console.log(`Withdrawal group saved: ${withdrawalGroup.id} with ${txHashes.length} transactions on chain ${chain}`);

      return reply.send({
        success: true,
        data: { 
          success: true,
          groupId: withdrawalGroup.id,
          txCount: txHashes.length
        }
      });
    } catch (error) {
      console.error('Error saving Aptos withdrawal group:', error);
      return reply.status(500).send({
        success: false,
        message: 'Failed to save withdrawal group',
        error: 'INTERNAL_ERROR',
        data: null
      });
    }
  });

  done();
}