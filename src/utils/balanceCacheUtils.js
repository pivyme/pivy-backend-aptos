import { prismaQuery } from "../lib/prisma.js";

// Cache duration constants
const FULL_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes
const ADDRESS_CACHE_INTERVAL = 5 * 60 * 1000; // 5 minutes for individual addresses

/**
 * Get the latest payment/withdrawal timestamp for a user on a specific chain
 */
async function getLatestActivityTimestamp(userId, chain) {
  const [latestPayment, latestWithdrawal] = await Promise.all([
    prismaQuery.payment.findFirst({
      where: {
        link: { userId },
        chain
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true }
    }),
    prismaQuery.withdrawal.findFirst({
      where: {
        userId,
        chain
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true }
    })
  ]);

  const paymentTime = latestPayment?.timestamp || 0;
  const withdrawalTime = latestWithdrawal?.timestamp || 0;
  
  return Math.max(paymentTime, withdrawalTime);
}

/**
 * Get the latest payment/withdrawal timestamp for a specific address on a chain
 */
async function getLatestAddressActivityTimestamp(address, chain) {
  const [latestPayment, latestWithdrawal] = await Promise.all([
    prismaQuery.payment.findFirst({
      where: {
        stealthOwnerPubkey: address,
        chain
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true }
    }),
    prismaQuery.withdrawal.findFirst({
      where: {
        stealthOwnerPubkey: address,
        chain
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true }
    })
  ]);

  const paymentTime = latestPayment?.timestamp || 0;
  const withdrawalTime = latestWithdrawal?.timestamp || 0;
  
  return Math.max(paymentTime, withdrawalTime);
}

/**
 * Check if user balance summary needs refresh
 */
async function shouldRefreshUserSummary(userId, chain) {
  const summary = await prismaQuery.userBalanceSummary.findUnique({
    where: {
      userId_chain: { userId, chain }
    }
  });

  if (!summary) return true;

  const now = new Date();
  const timeSinceRefresh = now.getTime() - summary.lastFullRefresh.getTime();
  
  // Force refresh if it's been more than 10 minutes
  if (timeSinceRefresh > FULL_REFRESH_INTERVAL) return true;

  // Check if there's new activity since last refresh - this is the key optimization
  const latestActivityTimestamp = await getLatestActivityTimestamp(userId, chain);
  if (latestActivityTimestamp > (summary.lastPaymentTimestamp || 0)) {
    return true;
  }

  return false;
}

/**
 * Check if address balance needs refresh
 */
async function shouldRefreshAddressBalance(address, chain) {
  const cached = await prismaQuery.addressBalanceCache.findUnique({
    where: {
      address_chain: { address, chain: chain.id }
    }
  });

  if (!cached) return true;

  const now = new Date();
  const timeSinceRefresh = now.getTime() - cached.lastFetched.getTime();
  
  // Force refresh if it's been more than 5 minutes
  if (timeSinceRefresh > ADDRESS_CACHE_INTERVAL) return true;

  // Check if there's new activity since last refresh for this specific address
  const latestActivityTimestamp = await getLatestAddressActivityTimestamp(address, chain.id);
  if (latestActivityTimestamp > (cached.lastPaymentTimestamp || 0)) {
    return true;
  }

  return false;
}

/**
 * Fetch fresh balance for a single address
 */
async function fetchAddressBalance(address, chain) {
  if (chain.id === "APTOS_MAINNET" || chain.id === "APTOS_TESTNET") {
    // TODO: Implement Aptos balance fetching
    // This would need:
    // 1. Aptos SDK client initialization
    // 2. Balance fetching logic for Aptos accounts
    // 3. Token balance formatting
    // 4. USD price calculations
    throw new Error("Aptos balance fetching not yet implemented");
  }

  throw new Error(`Unsupported chain: ${chain.id}`);
}

/**
 * Cache address balance to database
 */
async function cacheAddressBalance(address, chain, balanceData) {
  const latestActivityTimestamp = await getLatestAddressActivityTimestamp(address, chain.id);
  
  await prismaQuery.addressBalanceCache.upsert({
    where: {
      address_chain: { address, chain: chain.id }
    },
    update: {
      nativeBalance: balanceData.native?.total?.toString() || "0",
      nativeUsdValue: balanceData.native?.usdValue || 0,
      tokenBalances: balanceData.tokens || [],
      lastFetched: new Date(),
      lastPaymentTimestamp: latestActivityTimestamp || null,
      updatedAt: new Date()
    },
    create: {
      address,
      chain: chain.id,
      nativeBalance: balanceData.native?.total?.toString() || "0",
      nativeUsdValue: balanceData.native?.usdValue || 0,
      tokenBalances: balanceData.tokens || [],
      lastFetched: new Date(),
      lastPaymentTimestamp: latestActivityTimestamp || null
    }
  });
}

/**
 * Get cached address balance from database
 */
async function getCachedAddressBalance(address, chain) {
  const cached = await prismaQuery.addressBalanceCache.findUnique({
    where: {
      address_chain: { address, chain: chain.id }
    }
  });
  
  if (!cached) return null;
  
  return {
    native: {
      total: parseFloat(cached.nativeBalance),
      usdValue: cached.nativeUsdValue
    },
    tokens: Array.isArray(cached.tokenBalances) ? cached.tokenBalances : []
  };
}

/**
 * Get or refresh address balance with intelligent caching
 */
async function getAddressBalance(address, chain) {
  const needsRefresh = await shouldRefreshAddressBalance(address, chain);

  if (!needsRefresh) {
    const cached = await getCachedAddressBalance(address, chain);
    if (cached) return cached;
  }

  // Fetch fresh data
  const freshBalance = await fetchAddressBalance(address, chain);

  // Cache the result
  await cacheAddressBalance(address, chain, freshBalance);

  return freshBalance;
}

/**
 * Cache user balance summary to database
 */
async function cacheUserBalanceSummary(userId, chain, summary) {
  const latestActivityTimestamp = await getLatestActivityTimestamp(userId, chain.id);
  
  await prismaQuery.userBalanceSummary.upsert({
    where: {
      userId_chain: { userId, chain: chain.id }
    },
    update: {
      totalBalanceUsd: summary.totalBalanceUsd,
      tokensCount: summary.tokensCount,
      stealthAddressCount: summary.stealthAddressCount,
      lastFullRefresh: new Date(),
      lastPaymentTimestamp: latestActivityTimestamp || null,
      updatedAt: new Date()
    },
    create: {
      userId,
      chain: chain.id,
      totalBalanceUsd: summary.totalBalanceUsd,
      tokensCount: summary.tokensCount,
      stealthAddressCount: summary.stealthAddressCount,
      lastFullRefresh: new Date(),
      lastPaymentTimestamp: latestActivityTimestamp || null
    }
  });
}

/**
 * Get cached user balance summary without refresh checks (for immediate response)
 */
async function getCachedUserBalanceSummary(userId, chain) {
  const summary = await prismaQuery.userBalanceSummary.findUnique({
    where: {
      userId_chain: { userId, chain }
    }
  });

  return summary;
}

/**
 * Get user balances from cache immediately, trigger background refresh if needed
 */
export async function getUserBalancesWithCacheImmediate(userId, chain) {
  // First, try to get cached summary
  const cachedSummary = await getCachedUserBalanceSummary(userId, chain.id);
  
  // Get all user addresses for this chain
  const allPayments = await prismaQuery.payment.findMany({
    where: {
      link: { userId },
      chain: chain.id
    },
    select: {
      stealthOwnerPubkey: true,
      ephemeralPubkey: true
    },
    distinct: ['stealthOwnerPubkey']
  });
  
  const allAddresses = allPayments.map(p => p.stealthOwnerPubkey);
  
  if (allAddresses.length === 0) {
    return {
      native: { total: 0, usdValue: 0 },
      tokens: [],
      summary: {
        totalBalanceUsd: 0,
        tokensCount: 0,
        stealthAddressCount: 0
      }
    };
  }

  // Check if we need to refresh in the background
  const needsRefresh = await shouldRefreshUserSummary(userId, chain.id);
  
  // If we have cached data and it's not too old, return it immediately
  if (cachedSummary && !needsRefresh) {
    const cachedAddressData = await getCachedAddressBalances(allAddresses, chain);
    return cachedAddressData;
  }
  
  // If we have cached data but it needs refresh, check if we have sufficient cached address data
  if (cachedSummary && needsRefresh) {
    // Try to get cached address data
    const cachedAddressData = await getCachedAddressBalances(allAddresses, chain);
    
    // Check if we have meaningful cached data (not just empty structure)
    const hasMeaningfulCache = cachedAddressData.summary.totalBalanceUsd > 0 || 
                              cachedAddressData.tokens.length > 0 || 
                              cachedAddressData.native.total > 0;
    
    if (hasMeaningfulCache) {
      // Return cached data and refresh in background
      refreshUserBalancesInBackground(userId, chain, allAddresses);
      return cachedAddressData;
    } else {
      // Cache was invalidated (empty), fetch fresh data immediately for better UX
      return await getUserBalancesWithCache(userId, chain);
    }
  }
  
  // No cached data exists, fetch fresh data (first time user)
  return await getUserBalancesWithCache(userId, chain);
}

/**
 * Get cached address balances and aggregate them
 */
async function getCachedAddressBalances(addresses, chain) {
  const cachedBalances = await prismaQuery.addressBalanceCache.findMany({
    where: {
      address: { in: addresses },
      chain: chain.id
    }
  });
  
  // Create a map for quick lookup
  const cacheMap = new Map(cachedBalances.map(cache => [cache.address, cache]));
  
  let totalNative = 0;
  let totalNativeUsd = 0;
  const tokenMap = new Map();
  let addressesWithData = 0;
  
  // Process cached balances
  for (const address of addresses) {
    const cached = cacheMap.get(address);
    if (cached) {
      addressesWithData++;
      
      // Add native balance
      const nativeBalance = parseFloat(cached.nativeBalance);
      totalNative += nativeBalance;
      totalNativeUsd += cached.nativeUsdValue;
      
      // Add token balances
      const tokenBalances = Array.isArray(cached.tokenBalances) ? cached.tokenBalances : [];
      tokenBalances.forEach(token => {
        const key = token.mintAddress;
        if (tokenMap.has(key)) {
          const existing = tokenMap.get(key);
          existing.total += token.total;
          existing.usdValue += token.usdValue || 0;
        } else {
          tokenMap.set(key, { ...token });
        }
      });
    }
  }
  
  // Calculate the percentage of addresses we have cached data for
  const cacheCompleteness = addresses.length > 0 ? addressesWithData / addresses.length : 0;
  
  // If we have data for at least 50% of addresses, return partial cached data
  // If we have less than 50%, return empty structure to trigger fresh fetch
  if (cacheCompleteness < 0.5) {
    return {
      native: { total: 0, usdValue: 0 },
      tokens: [],
      summary: {
        totalBalanceUsd: 0,
        tokensCount: 0,
        stealthAddressCount: addresses.length
      }
    };
  }
  
  const aggregatedTokens = Array.from(tokenMap.values())
    .filter(token => token.total > 0.00001)
    .sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
  
  const totalTokensUsd = aggregatedTokens.reduce((sum, token) => sum + (token.usdValue || 0), 0);
  const totalBalanceUsd = totalNativeUsd + totalTokensUsd;
  
  return {
    native: {
      total: totalNative,
      usdValue: totalNativeUsd
    },
    tokens: aggregatedTokens,
    summary: {
      totalBalanceUsd,
      tokensCount: aggregatedTokens.length,
      stealthAddressCount: addresses.length
    }
  };
}

/**
 * Refresh user balances in the background (non-blocking)
 */
async function refreshUserBalancesInBackground(userId, chain, allAddresses) {
  try {

    // Get balances for each address (with caching and throttling)
    const addressBalances = [];
    for (let i = 0; i < allAddresses.length; i++) {
      const address = allAddresses[i];
      try {
        const balance = await getAddressBalance(address, chain);
        addressBalances.push(balance);

        // Add delay between address requests to prevent rate limiting (except for the last request)
        if (i < allAddresses.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 150)); // 150ms delay for background refresh
        }
      } catch (error) {
        console.error(`Error fetching balance for address ${address} in background:`, error);
        continue;
      }
    }
    
    // Aggregate all balances
    let totalNative = 0;
    let totalNativeUsd = 0;
    const tokenMap = new Map();
    
    addressBalances.forEach(balance => {
      totalNative += balance.native?.total || 0;
      totalNativeUsd += balance.native?.usdValue || 0;
      
      if (balance.tokens) {
        balance.tokens.forEach(token => {
          const key = token.mintAddress;
          if (tokenMap.has(key)) {
            const existing = tokenMap.get(key);
            existing.total += token.total;
            existing.usdValue += token.usdValue || 0;
          } else {
            tokenMap.set(key, { ...token });
          }
        });
      }
    });
    
    const aggregatedTokens = Array.from(tokenMap.values())
      .filter(token => token.total > 0.00001)
      .sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
    
    const totalTokensUsd = aggregatedTokens.reduce((sum, token) => sum + (token.usdValue || 0), 0);
    const totalBalanceUsd = totalNativeUsd + totalTokensUsd;
    
    const result = {
      native: {
        total: totalNative,
        usdValue: totalNativeUsd
      },
      tokens: aggregatedTokens,
      summary: {
        totalBalanceUsd,
        tokensCount: aggregatedTokens.length,
        stealthAddressCount: allAddresses.length
      }
    };
    
    // Cache the updated summary
    await cacheUserBalanceSummary(userId, chain, result.summary);

  } catch (error) {
    console.error(`Error in background refresh for user ${userId} on ${chain.id}:`, error);
  }
}

/**
 * Get user balances with intelligent caching
 */
export async function getUserBalancesWithCache(userId, chain) {
  const needsRefresh = await shouldRefreshUserSummary(userId, chain.id);

  // Get all user addresses for this chain
  const allPayments = await prismaQuery.payment.findMany({
    where: {
      link: { userId },
      chain: chain.id
    },
    select: {
      stealthOwnerPubkey: true,
      ephemeralPubkey: true
    },
    distinct: ['stealthOwnerPubkey']
  });

  const allAddresses = allPayments.map(p => p.stealthOwnerPubkey);
  
  if (allAddresses.length === 0) {
    return {
      native: { total: 0, usdValue: 0 },
      tokens: [],
      summary: {
        totalBalanceUsd: 0,
        tokensCount: 0,
        stealthAddressCount: 0
      }
    };
  }
  
  // Get balances for each address (with caching and throttling)
  const addressBalances = [];
  for (let i = 0; i < allAddresses.length; i++) {
    const address = allAddresses[i];
    try {
      const balance = await getAddressBalance(address, chain);
      addressBalances.push(balance);

      // Add delay between address requests to prevent rate limiting (except for the last request)
      if (i < allAddresses.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay between addresses
      }
    } catch (error) {
      console.error(`Error fetching balance for address ${address}:`, error);
      // Continue with other addresses if one fails
      continue;
    }
  }
  
  // Aggregate all balances
  let totalNative = 0;
  let totalNativeUsd = 0;
  const tokenMap = new Map();
  
  addressBalances.forEach(balance => {
    // Aggregate native
    totalNative += balance.native?.total || 0;
    totalNativeUsd += balance.native?.usdValue || 0;
    
    // Aggregate tokens
    if (balance.tokens) {
      balance.tokens.forEach(token => {
        const key = token.mintAddress;
        if (tokenMap.has(key)) {
          const existing = tokenMap.get(key);
          existing.total += token.total;
          existing.usdValue += token.usdValue || 0;
        } else {
          tokenMap.set(key, { ...token });
        }
      });
    }
  });
  
  const aggregatedTokens = Array.from(tokenMap.values())
    .filter(token => token.total > 0.00001)
    .sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
  
  const totalTokensUsd = aggregatedTokens.reduce((sum, token) => sum + (token.usdValue || 0), 0);
  const totalBalanceUsd = totalNativeUsd + totalTokensUsd;
  
  const result = {
    native: {
      total: totalNative,
      usdValue: totalNativeUsd
    },
    tokens: aggregatedTokens,
    summary: {
      totalBalanceUsd,
      tokensCount: aggregatedTokens.length,
      stealthAddressCount: allAddresses.length
    }
  };
  
  // Cache the summary if we did a refresh
  if (needsRefresh) {
    await cacheUserBalanceSummary(userId, chain, result.summary);
  }
  
  return result;
}

/**
 * Invalidate cache for specific addresses (call this when new payments/withdrawals are detected)
 */
export async function invalidateAddressCache(addresses, chain) {
  if (addresses.length === 0) return;
  
  await prismaQuery.addressBalanceCache.deleteMany({
    where: {
      address: { in: addresses },
      chain: chain
    }
  });
}

/**
 * Invalidate user balance summary (call this when new payments/withdrawals are detected)
 */
export async function invalidateUserBalanceCache(userId, chain) {
  await prismaQuery.userBalanceSummary.deleteMany({
    where: {
      userId,
      chain
    }
  });
}

/**
 * 🎯 CRITICAL: Efficient cache invalidation for new payment (call this immediately when a payment is processed)
 * 
 * This ensures:
 * 1. Stale RPC cache is deleted (triggers fresh RPC fetch on next balance worker run)
 * 2. User balance summary is marked as needing refresh
 * 3. Any incorrect balance adjustments are cleared (prevents stale adjustments from affecting real-time data)
 * 
 * NOTE: Even though we now prioritize activity data for real-time accuracy, we still need to
 * invalidate RPC cache so it gets refreshed and doesn't show discrepancies in validation logs.
 */
export async function invalidateCacheForNewPayment(payment) {
  const { stealthOwnerPubkey, chain, link } = payment;
  
  try {
    // Invalidate the specific address cache (forces fresh RPC fetch next time)
    await prismaQuery.addressBalanceCache.deleteMany({
      where: {
        address: stealthOwnerPubkey,
        chain: chain
      }
    });
    
    // 🔥 CRITICAL FIX: Delete any stale balance adjustments for this address
    // These adjustments might be based on old RPC data and cause incorrect balances
    await prismaQuery.balanceAdjustment.deleteMany({
      where: {
        stealthOwnerPubkey: stealthOwnerPubkey,
        chain: chain
      }
    });
    
    // If we have link info, invalidate the user's balance summary by updating lastPaymentTimestamp
    // This forces a refresh on next request while keeping summary data for immediate response
    if (link?.userId) {
      const currentTimestamp = Math.floor(Date.now() / 1000);
      await prismaQuery.userBalanceSummary.updateMany({
        where: {
          userId: link.userId,
          chain: chain
        },
        data: {
          lastPaymentTimestamp: currentTimestamp,
          updatedAt: new Date()
        }
      });
      
      // Invalidate activities cache for this user (if available globally)
      if (global.invalidateActivitiesCache) {
        global.invalidateActivitiesCache(link.userId);
      }
    }

  } catch (error) {
    console.error('Error invalidating cache for new payment:', error);
  }
}

/**
 * 🎯 CRITICAL: Efficient cache invalidation for new withdrawal (call this immediately when a withdrawal is processed)
 * 
 * This ensures:
 * 1. Stale RPC cache is deleted (triggers fresh RPC fetch on next balance worker run)
 * 2. User balance summary is marked as needing refresh
 * 3. Any incorrect balance adjustments are cleared (prevents stale adjustments from affecting real-time data)
 */
export async function invalidateCacheForNewWithdrawal(withdrawal) {
  const { stealthOwnerPubkey, chain, userId } = withdrawal;
  
  try {
    // Invalidate the specific address cache (forces fresh RPC fetch next time)
    await prismaQuery.addressBalanceCache.deleteMany({
      where: {
        address: stealthOwnerPubkey,
        chain: chain
      }
    });
    
    // 🔥 CRITICAL FIX: Delete any stale balance adjustments for this address
    // These adjustments might be based on old RPC data and cause incorrect balances
    await prismaQuery.balanceAdjustment.deleteMany({
      where: {
        stealthOwnerPubkey: stealthOwnerPubkey,
        chain: chain
      }
    });
    
    // Invalidate the user's balance summary by updating lastPaymentTimestamp
    // This forces a refresh on next request while keeping summary data for immediate response
    if (userId) {
      const currentTimestamp = Math.floor(Date.now() / 1000);
      await prismaQuery.userBalanceSummary.updateMany({
        where: {
          userId: userId,
          chain: chain
        },
        data: {
          lastPaymentTimestamp: currentTimestamp,
          updatedAt: new Date()
        }
      });
      
      // Invalidate activities cache for this user (if available globally)
      if (global.invalidateActivitiesCache) {
        global.invalidateActivitiesCache(userId);
      }
    }

  } catch (error) {
    console.error('Error invalidating cache for new withdrawal:', error);
  }
}

/**
 * Clean up old cache entries (should be called periodically)
 */
export async function cleanupOldCacheEntries() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  try {
    // Remove address cache entries older than 1 hour
    await prismaQuery.addressBalanceCache.deleteMany({
      where: {
        lastFetched: {
          lt: oneHourAgo
        }
      }
    });

    // Remove user balance summaries older than 1 day
    await prismaQuery.userBalanceSummary.deleteMany({
      where: {
        lastFullRefresh: {
          lt: oneDayAgo
        }
      }
    });

  } catch (error) {
    console.error('Error during cache cleanup:', error);
  }
}

/**
 * Get cache statistics for monitoring
 */
export async function getCacheStats() {
  try {
    const [addressCacheCount, userSummaryCount] = await Promise.all([
      prismaQuery.addressBalanceCache.count(),
      prismaQuery.userBalanceSummary.count()
    ]);
    
    return {
      addressCacheEntries: addressCacheCount,
      userSummaryEntries: userSummaryCount,
      timestamp: new Date()
    };
  } catch (error) {
    console.error('Error getting cache stats:', error);
    return null;
  }
} 