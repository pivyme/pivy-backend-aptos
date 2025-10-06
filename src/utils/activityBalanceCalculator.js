import { prismaQuery } from "../lib/prisma.js";
import BigNumber from 'bignumber.js';

/**
 * Calculate user's total balances from activities across all addresses
 * This is the primary and fastest way to get balance data
 */
export async function calculateUserBalanceFromActivities(userId, chain) {
  try {
    // Get all payments for this user on this chain
    const payments = await prismaQuery.payment.findMany({
      where: {
        link: { userId },
        chain: chain
      },
      include: {
        mint: true
      }
    });

    // Get all withdrawals for this user on this chain
    const withdrawals = await prismaQuery.withdrawal.findMany({
      where: {
        userId,
        chain: chain
      },
      include: {
        mint: true
      }
    });
    
    // 🚀 NEW: Get all balance adjustments for this user on this chain
    const adjustments = await prismaQuery.balanceAdjustment.findMany({
      where: {
        userId,
        chain: chain
      },
      include: {
        mint: true
      }
    });

    // Group balances by mint address AND stealth address to provide detailed breakdown
    const balanceByMintAndStealth = new Map();
    const addressSet = new Set();

    // Process payments (incoming)
    for (const payment of payments) {
      const mintAddress = payment.mint.mintAddress;
      const amount = new BigNumber(payment.amount);
      const stealthKey = payment.stealthOwnerPubkey;
      addressSet.add(stealthKey);

      const key = `${mintAddress}_${stealthKey}`;

      if (balanceByMintAndStealth.has(key)) {
        const existing = balanceByMintAndStealth.get(key);
        existing.total = existing.total.plus(amount);
        // Keep latest payment info for memo/ephemeral display
        if (payment.timestamp > existing.latestPaymentTimestamp) {
          existing.latestPaymentTimestamp = payment.timestamp;
          existing.ephemeralPubkey = payment.ephemeralPubkey;
          existing.memo = payment.memo;
        }
      } else {
        balanceByMintAndStealth.set(key, {
          mint: payment.mint,
          stealthOwnerPubkey: stealthKey,
          total: amount,
          latestPaymentTimestamp: payment.timestamp,
          ephemeralPubkey: payment.ephemeralPubkey,
          memo: payment.memo
        });
      }
    }

    // Process withdrawals (outgoing)
    for (const withdrawal of withdrawals) {
      const mintAddress = withdrawal.mint.mintAddress;
      // Use amountAfterFee if available (includes transaction fees), otherwise fall back to amount
      const withdrawalAmount = withdrawal.amountAfterFee || withdrawal.amount;
      const amount = new BigNumber(withdrawalAmount);
      const stealthKey = withdrawal.stealthOwnerPubkey;
      addressSet.add(stealthKey);

      const key = `${mintAddress}_${stealthKey}`;

      if (balanceByMintAndStealth.has(key)) {
        const existing = balanceByMintAndStealth.get(key);
        existing.total = existing.total.minus(amount);
      } else {
        // This case can happen if a payment is not indexed yet but withdrawal is
        balanceByMintAndStealth.set(key, {
          mint: withdrawal.mint,
          stealthOwnerPubkey: stealthKey,
          total: amount.negated(),
          latestPaymentTimestamp: 0, // No payment info available
          ephemeralPubkey: null,
          memo: null
        });
      }
    }

    // 🚀 NEW: Process adjustments
    for (const adjustment of adjustments) {
      const mintAddress = adjustment.mint.mintAddress;
      const rawAmount = adjustment.adjustmentAmount;
      const amount = new BigNumber(rawAmount); // This is already in the smallest unit
      const stealthKey = adjustment.stealthOwnerPubkey;
      addressSet.add(stealthKey);

      const key = `${mintAddress}_${stealthKey}`;

      if (balanceByMintAndStealth.has(key)) {
        const existing = balanceByMintAndStealth.get(key);
        existing.total = existing.total.plus(amount);
      } else {
        balanceByMintAndStealth.set(key, {
          mint: adjustment.mint,
          stealthOwnerPubkey: stealthKey,
          total: amount,
          latestPaymentTimestamp: 0,
          ephemeralPubkey: null, // Adjustments don't have ephemeral keys
          memo: "Balance Adjustment"
        });
      }
    }

    // 🔧 FIXED: Format results to match frontend expectations (ALL tokens in tokens array, no separate native)
    // Aggregate detailed balances into the final token structure
    const tokenMap = new Map();
    let totalBalanceUsd = new BigNumber(0);

    for (const [, data] of balanceByMintAndStealth.entries()) {
      if (data.total.lte(0)) continue; // Skip zero or negative balances

      const mintAddress = data.mint.mintAddress;
      const decimals = new BigNumber(10).pow(data.mint.decimals);
      const formattedBalance = data.total.div(decimals);
      const priceUsd = new BigNumber(data.mint.priceUsd || 0);
      const usdValue = formattedBalance.times(priceUsd);

      // Get or create the token entry in the map
      if (!tokenMap.has(mintAddress)) {
        tokenMap.set(mintAddress, {
          mintAddress,
          name: data.mint.name,
          symbol: data.mint.symbol,
          decimals: data.mint.decimals,
          imageUrl: data.mint.imageUrl,
          total: new BigNumber(0),
          usdValue: new BigNumber(0),
          priceUsd: data.mint.priceUsd,
          isVerified: data.mint.isVerified || false,
          isNative: data.mint.isNative || false,
          balances: [] // This will be populated with stealth address details
        });
      }

      const tokenData = tokenMap.get(mintAddress);

      // Update token-level totals
      tokenData.total = tokenData.total.plus(formattedBalance);
      tokenData.usdValue = tokenData.usdValue.plus(usdValue);
      totalBalanceUsd = totalBalanceUsd.plus(usdValue); // Update overall total USD value

      // Add the detailed balance for this stealth address
      tokenData.balances.push({
        address: data.stealthOwnerPubkey,
        ephemeralPubkey: data.ephemeralPubkey,
        memo: data.memo,
        amount: formattedBalance.toNumber(), // Convert to number only for display
      });
    }

    const tokens = Array.from(tokenMap.values()).map(token => ({
      ...token,
      total: token.total.toNumber(), // Convert to number for display only
      usdValue: token.usdValue.toNumber() // Convert to number for display only
    }));

    // Sort with native tokens first (APT > others by USD value)
    const sortedTokens = tokens.sort((a, b) => {
      // Priority order: APT > others (by USD value)
      const getSortPriority = (token) => {
        if (token.symbol === 'APT') return 1000000; // Highest priority
        return token.usdValue; // Others sorted by USD value
      };
      return getSortPriority(b) - getSortPriority(a);
    });

    const result = {
      // 🔧 FIXED: Match frontend interface - no separate native field
      tokens: sortedTokens,
      summary: {
        totalBalanceUsd: totalBalanceUsd.toNumber(),
        tokensCount: sortedTokens.length,
        stealthAddressCount: addressSet.size
      },
      calculatedFromActivities: true,
      lastCalculated: new Date(),
      paymentCount: payments.length,
      withdrawalCount: withdrawals.length
    };

    return result;

  } catch (error) {
    console.error('Error calculating balance from activities:', error);
    return null;
  }
}

/**
 * Get cached RPC balance data to supplement activity-based calculations
 */
export async function getCachedRpcBalanceData(userId, chain) {
  try {
    // Get all addresses for this user on this chain
    const payments = await prismaQuery.payment.findMany({
      where: {
        link: { userId },
        chain: chain
      },
      select: {
        stealthOwnerPubkey: true
      },
      distinct: ['stealthOwnerPubkey']
    });

    const addresses = payments.map(p => p.stealthOwnerPubkey);

    if (addresses.length === 0) {
      return null;
    }
    
    // 🔧 FIX: Get latest payment info (memo, ephemeral key) for each address to enrich the output
    const latestPayments = await prismaQuery.payment.findMany({
      where: {
        stealthOwnerPubkey: { in: addresses },
        chain: chain
      },
      orderBy: {
        timestamp: 'desc'
      },
      distinct: ['stealthOwnerPubkey'],
      select: {
        stealthOwnerPubkey: true,
        ephemeralPubkey: true,
        memo: true
      }
    });
    const paymentInfoMap = new Map(latestPayments.map(p => [p.stealthOwnerPubkey, {
      ephemeralPubkey: p.ephemeralPubkey,
      memo: p.memo
    }]));


    // Get cached balance data for these addresses
    const cachedBalances = await prismaQuery.addressBalanceCache.findMany({
      where: {
        address: { in: addresses },
        chain: chain,
        lastFetched: {
          gte: new Date(Date.now() - 6 * 60 * 60 * 1000) // Within last 6 hours
        }
      }
    });

    if (cachedBalances.length === 0) {
      return null;
    }

    // 🔧 FIXED: Aggregate cached data to match frontend interface (all tokens in tokens array)
    const tokenMap = new Map();

    // Collect all unique mint addresses to fetch current verification status
    const allMintAddresses = new Set();
    for (const cache of cachedBalances) {
      const tokenBalances = Array.isArray(cache.tokenBalances) ? cache.tokenBalances : [];
      tokenBalances.forEach(token => allMintAddresses.add(token.mintAddress));
    }

    // Fetch current verification and native status from database
    const mintDataMap = new Map();
    if (allMintAddresses.size > 0) {
      const mints = await prismaQuery.mintDataCache.findMany({
        where: {
          mintAddress: { in: Array.from(allMintAddresses) },
          chain: chain
        },
        select: {
          mintAddress: true,
          isVerified: true,
          isNative: true
        }
      });

      mints.forEach(mint => {
        mintDataMap.set(mint.mintAddress, {
          isVerified: mint.isVerified,
          isNative: mint.isNative
        });
      });
    }

    for (const cache of cachedBalances) {
      // 🔧 FIXED: Add native balance as a token in the tokens array
      const nativeBalance = new BigNumber(cache.nativeBalance);
      const nativeUsdValue = new BigNumber(cache.nativeUsdValue);

      if (nativeBalance.gt(0.00001)) { // Only include if there is a balance
        // APTOS native token details
        const nativeMint = '0x1::aptos_coin::AptosCoin';
        const nativeName = 'Aptos';
        const nativeSymbol = 'APT';
        const nativeDecimals = 8;
        const nativeImage = 'https://assets.coingecko.com/coins/images/26455/standard/aptos_round.png';

        if (!tokenMap.has(nativeMint)) {
          tokenMap.set(nativeMint, {
            mintAddress: nativeMint,
            name: nativeName,
            symbol: nativeSymbol,
            decimals: nativeDecimals,
            imageUrl: nativeImage,
            total: new BigNumber(0), // Will be aggregated
            usdValue: new BigNumber(0), // Will be aggregated
            priceUsd: nativeBalance.gt(0) ? nativeUsdValue.div(nativeBalance).toNumber() : 0,
            isVerified: true,
            isNative: true,
            balances: []
          });
        }

        const nativeToken = tokenMap.get(nativeMint);
        nativeToken.total = nativeToken.total.plus(nativeBalance);
        nativeToken.usdValue = nativeToken.usdValue.plus(nativeUsdValue);
        nativeToken.balances.push({
          address: cache.address,
          amount: nativeBalance.toNumber(),
          ...paymentInfoMap.get(cache.address)
        });
      }

      // Add token balances
      const tokenBalances = Array.isArray(cache.tokenBalances) ? cache.tokenBalances : [];
      for (const token of tokenBalances) {
        const key = token.mintAddress;

        if (new BigNumber(token.total).lte(0.00001)) continue; // Only include if there is a balance

        if (!tokenMap.has(key)) {
          // Ensure the format matches the frontend interface
          // Use current verification and native status from database, or false if not found
          const mintData = mintDataMap.get(token.mintAddress) || { isVerified: false, isNative: false };
          const currentIsVerified = mintData.isVerified;
          const currentIsNative = mintData.isNative;
          tokenMap.set(key, {
            mintAddress: token.mintAddress,
            name: token.tokenInfo?.name,
            symbol: token.tokenInfo?.symbol,
            decimals: token.tokenInfo?.decimals,
            imageUrl: token.tokenInfo?.imageUrl,
            total: new BigNumber(0), // Will be aggregated
            usdValue: new BigNumber(0), // Will be aggregated
            priceUsd: token.tokenInfo?.priceUsd,
            isVerified: currentIsVerified,
            isNative: currentIsNative,
            balances: []
          });
        }

        const existing = tokenMap.get(key);
        existing.total = existing.total.plus(token.total);
        existing.usdValue = existing.usdValue.plus(token.usdValue || 0);
        existing.balances.push({
          address: cache.address,
          amount: parseFloat(token.total),
          ...paymentInfoMap.get(cache.address)
        });
      }
    }

    // Sort with native tokens first (APT > others by USD value)
    const tokens = Array.from(tokenMap.values())
      .filter(token => token.total.gt(0.00001))
      .map(token => ({
        ...token,
        total: token.total.toNumber(),
        usdValue: token.usdValue.toNumber()
      }))
      .sort((a, b) => {
        // Priority order: APT > others (by USD value)
        const getSortPriority = (token) => {
          if (token.symbol === 'APT') return 1000000; // Highest priority
          return token.usdValue; // Others sorted by USD value
        };
        return getSortPriority(b) - getSortPriority(a);
      });
    const totalBalanceUsd = tokens.reduce((sum, token) => sum + (token.usdValue || 0), 0);

    return {
      // 🔧 FIXED: Match frontend interface - no separate native field
      tokens,
      summary: {
        totalBalanceUsd,
        tokensCount: tokens.length,
        stealthAddressCount: addresses.length
      },
      calculatedFromRpcCache: true,
      cacheCompleteness: cachedBalances.length / addresses.length,
      lastRpcCheck: new Date(Math.max(...cachedBalances.map(c => c.lastFetched.getTime())))
    };

  } catch (error) {
    console.error('Error getting cached RPC balance:', error);
    return null;
  }
}

/**
 * 🎯 REAL-TIME ACCURATE: Get combined user balance with activity data as primary source
 * 
 * Priority Logic (FIXED for real-time accuracy):
 * 1. 🥇 Activity data = PRIMARY SOURCE (always accurate, real-time from database)
 * 2. 🥈 High-precision chronological = SECONDARY (for complex cases)
 * 3. 🥉 RPC cache = VALIDATION ONLY (used to detect discrepancies, not as primary)
 * 
 * Why activity first? Activity data is calculated from actual Payment/Withdrawal records
 * in the database and updates INSTANTLY when new transactions are indexed. RPC cache
 * can be stale by 1-2 hours, causing UI delays.
 */
export async function getCombinedUserBalance(userId, chain) {
  try {
    // Get all sources including high-precision calculation
    const [activityBalance, cachedRpcBalance, highPrecisionBalance] = await Promise.all([
      calculateUserBalanceFromActivities(userId, chain),
      getCachedRpcBalanceData(userId, chain),
      getHighPrecisionUserBalance(userId, chain)
    ]);

    let primaryBalance;
    let dataSource;
    let comparisonData = null;

    // 🎯 ALWAYS USE ACTIVITY DATA AS PRIMARY (real-time, accurate)
    if (activityBalance && activityBalance.summary.totalBalanceUsd >= 0) {
      primaryBalance = activityBalance;
      dataSource = 'activity_based_realtime';
      
      // Use RPC for validation/comparison only (not as primary source)
      if (cachedRpcBalance) {
        const activityTotalUsd = new BigNumber(activityBalance.summary.totalBalanceUsd);
        const rpcTotalUsd = new BigNumber(cachedRpcBalance.summary.totalBalanceUsd);
        const difference = Math.abs(activityTotalUsd.minus(rpcTotalUsd).toNumber());
        
        comparisonData = {
          method: 'activity_primary_with_rpc_validation',
          activityTotalUsd: activityTotalUsd.toNumber(),
          rpcTotalUsd: rpcTotalUsd.toNumber(),
          difference: difference,
          discrepancyPercent: activityTotalUsd.gt(0) ?
            Math.abs(activityTotalUsd.minus(rpcTotalUsd).div(activityTotalUsd).times(100).toNumber()) : 0,
          cacheCompleteness: cachedRpcBalance.cacheCompleteness,
          lastRpcCheck: cachedRpcBalance.lastRpcCheck,
          rpcAge: cachedRpcBalance.lastRpcCheck ?
            ((Date.now() - cachedRpcBalance.lastRpcCheck.getTime()) / (60 * 60 * 1000)).toFixed(1) + ' hours' : 'unknown'
        };
        
        // Log significant discrepancies for monitoring
        if (difference > 0.01) { // > $0.01 difference
          console.log(`⚠️ Balance discrepancy detected for user ${userId} on ${chain}:`, {
            activityBalance: activityTotalUsd.toNumber(),
            rpcBalance: rpcTotalUsd.toNumber(),
            difference: difference,
            percentDiff: comparisonData.discrepancyPercent.toFixed(2) + '%',
            cacheAge: comparisonData.rpcAge
          });
        }
      }

    } else if (highPrecisionBalance && highPrecisionBalance.summary.totalBalanceUsd > 0) {
      // 🎯 USE HIGH-PRECISION CALCULATION AS FALLBACK
      primaryBalance = highPrecisionBalance;
      dataSource = 'high_precision_chronological';
      
    } else if (cachedRpcBalance) {
      // 🥉 FALLBACK TO RPC ONLY IF NO ACTIVITY DATA
      primaryBalance = cachedRpcBalance;
      dataSource = 'rpc_cache_fallback';
      
    } else {
      // 🚫 NO DATA AVAILABLE
      return {
        tokens: [],
        summary: {
          totalBalanceUsd: 0,
          tokensCount: 0,
          stealthAddressCount: 0
        },
        _debug: {
          dataSource: 'no_data',
          warning: 'No balance data available',
          calculationTimestamp: new Date()
        }
      };
    }

    const finalResult = {
      ...primaryBalance,
      // 🔧 SAFE: Put all new metadata under _debug so it doesn't break existing API consumers
      _debug: {
        dataSource,
        dataSourcePriority: 'activity_primary', // Always activity first for real-time accuracy
        comparisonData,
        calculationTimestamp: new Date(),
        cacheCompleteness: cachedRpcBalance?.cacheCompleteness,
        lastRpcCheck: cachedRpcBalance?.lastRpcCheck,
        // Add accuracy tracking
        accuracyMetrics: await trackBalanceAccuracy(
          userId, 
          chain,
          cachedRpcBalance?.summary?.totalBalanceUsd,
          activityBalance?.summary?.totalBalanceUsd,
          highPrecisionBalance?.summary?.totalBalanceUsd
        )
      }
    };

    return finalResult;

  } catch (error) {
    console.error('Error getting combined user balance:', error);
    throw error;
  }
}

/**
 * 🎯 HIGH-PRECISION: Consolidate balances with maximum accuracy for stealth addresses
 * This function ensures decimal precision and handles edge cases that cause discrepancies
 */
export async function getHighPrecisionUserBalance(userId, chain) {
  try {
    // Get ALL transactions with proper ordering for deterministic calculation
    const [payments, withdrawals, adjustments] = await Promise.all([
      prismaQuery.payment.findMany({
        where: { link: { userId }, chain },
        include: { mint: true },
        orderBy: [{ timestamp: 'asc' }, { txHash: 'asc' }] // Deterministic ordering
      }),
      prismaQuery.withdrawal.findMany({
        where: { userId, chain },
        include: { mint: true },
        orderBy: [{ timestamp: 'asc' }, { txHash: 'asc' }] // Deterministic ordering  
      }),
      prismaQuery.balanceAdjustment.findMany({
        where: { userId, chain },
        include: { mint: true },
        orderBy: [{ createdAt: 'asc' }, { stealthOwnerPubkey: 'asc' }] // Deterministic ordering
      })
    ]);

    // Use ultra-high precision (up to 30 decimal places)
    BigNumber.config({ DECIMAL_PLACES: 30, ROUNDING_MODE: BigNumber.ROUND_DOWN });
    
    const balanceMap = new Map(); // key: `${mintAddress}_${stealthAddress}`
    const addressSet = new Set();
    
    // Process in chronological order for accuracy
    const allTransactions = [
      ...payments.map(p => ({ ...p, type: 'payment', timestamp: p.timestamp })),
      ...withdrawals.map(w => ({ ...w, type: 'withdrawal', timestamp: w.timestamp })),
      ...adjustments.map(a => ({ ...a, type: 'adjustment', timestamp: a.createdAt?.getTime() || 0 }))
    ].sort((a, b) => a.timestamp - b.timestamp);
    
    // Process each transaction in chronological order
    for (const tx of allTransactions) {
      const mintAddress = tx.mint.mintAddress;
      const stealthKey = tx.stealthOwnerPubkey;
      const key = `${mintAddress}_${stealthKey}`;
      addressSet.add(stealthKey);
      
      if (!balanceMap.has(key)) {
        balanceMap.set(key, {
          mint: tx.mint,
          stealthOwnerPubkey: stealthKey,
          balance: new BigNumber(0),
          ephemeralPubkey: null,
          memo: null,
          lastActivity: tx.timestamp
        });
      }
      
      const entry = balanceMap.get(key);
      
      if (tx.type === 'payment') {
        entry.balance = entry.balance.plus(new BigNumber(tx.amount));
        entry.ephemeralPubkey = tx.ephemeralPubkey;
        entry.memo = tx.memo;
        entry.lastActivity = tx.timestamp;
      } else if (tx.type === 'withdrawal') {
        // Use amountAfterFee if available (includes transaction fees), otherwise fall back to amount
        const withdrawalAmount = tx.amountAfterFee || tx.amount;
        entry.balance = entry.balance.minus(new BigNumber(withdrawalAmount));
        entry.lastActivity = tx.timestamp;
      } else if (tx.type === 'adjustment') {
        entry.balance = entry.balance.plus(new BigNumber(tx.adjustmentAmount));
        entry.lastActivity = tx.timestamp;
      }
    }
    
    // Aggregate by token with maximum precision
    const tokenMap = new Map();
    let totalUsdValue = new BigNumber(0);
    
    for (const [, data] of balanceMap.entries()) {
      if (data.balance.lte(0)) continue;
      
      const mintAddress = data.mint.mintAddress;
      const decimals = new BigNumber(10).pow(data.mint.decimals);
      const formattedBalance = data.balance.div(decimals);
      const priceUsd = new BigNumber(data.mint.priceUsd || 0);
      const usdValue = formattedBalance.times(priceUsd);
      
      if (!tokenMap.has(mintAddress)) {
        tokenMap.set(mintAddress, {
          mintAddress,
          name: data.mint.name,
          symbol: data.mint.symbol,
          decimals: data.mint.decimals,
          imageUrl: data.mint.imageUrl,
          total: new BigNumber(0),
          usdValue: new BigNumber(0),
          priceUsd: data.mint.priceUsd,
          isVerified: data.mint.isVerified || false,
          isNative: data.mint.isNative || false,
          balances: []
        });
      }
      
      const token = tokenMap.get(mintAddress);
      token.total = token.total.plus(formattedBalance);
      token.usdValue = token.usdValue.plus(usdValue);
      totalUsdValue = totalUsdValue.plus(usdValue);
      
      token.balances.push({
        address: data.stealthOwnerPubkey,
        ephemeralPubkey: data.ephemeralPubkey,
        memo: data.memo,
        amount: formattedBalance.toNumber()
      });
    }
    
    const tokens = Array.from(tokenMap.values())
      .map(token => ({
        ...token,
        total: token.total.toNumber(),
        usdValue: token.usdValue.toNumber()
      }))
      .sort((a, b) => {
        if (a.symbol === 'APT') return -1;
        if (b.symbol === 'APT') return 1;
        return b.usdValue - a.usdValue;
      });
    
    const result = {
      tokens,
      summary: {
        totalBalanceUsd: totalUsdValue.toNumber(),
        tokensCount: tokens.length,
        stealthAddressCount: addressSet.size
      },
      calculationMethod: 'high_precision_chronological',
      lastCalculated: new Date(),
      transactionCount: allTransactions.length
    };

    return result;

  } catch (error) {
    console.error('Error in high-precision balance calculation:', error);
    return null;
  }
}

/**
 * Get balance statistics for monitoring
 * Note: Using raw queries here for complex aggregations that are more efficient as SQL
 */
export async function getBalanceCalculationStats() {
  try {
    // These raw queries are justified because:
    // 1. Complex aggregations with GROUP BY and statistical functions
    // 2. Much more efficient than multiple Prisma queries
    // 3. Read-only operations for monitoring/stats
    const stats = await prismaQuery.$queryRaw`
      SELECT 
        chain,
        COUNT(DISTINCT address) as total_addresses,
        COUNT(*) as cached_entries,
        AVG(EXTRACT(EPOCH FROM (NOW() - lastFetched))) as avg_cache_age_seconds,
        MIN(lastFetched) as oldest_cache,
        MAX(lastFetched) as newest_cache
      FROM AddressBalanceCache
      GROUP BY chain
      ORDER BY chain
    `;

    const activityStats = await prismaQuery.$queryRaw`
      SELECT 
        chain,
        COUNT(*) as total_payments,
        COUNT(DISTINCT stealthOwnerPubkey) as unique_addresses,
        MAX(timestamp) as latest_payment_timestamp
      FROM Payment
      GROUP BY chain
      ORDER BY chain
    `;

    return {
      cacheStats: stats.map(row => ({
        chain: row.chain,
        totalAddresses: Number(row.total_addresses),
        cachedEntries: Number(row.cached_entries),
        avgCacheAgeSeconds: Number(row.avg_cache_age_seconds),
        oldestCache: row.oldest_cache,
        newestCache: row.newest_cache
      })),
      activityStats: activityStats.map(row => ({
        chain: row.chain,
        totalPayments: Number(row.total_payments),
        uniqueAddresses: Number(row.unique_addresses),
        latestPaymentTimestamp: Number(row.latest_payment_timestamp)
      }))
    };

  } catch (error) {
    console.error('Error getting balance calculation stats:', error);
    return { cacheStats: [], activityStats: [] };
  }
}

/**
 * 🚀 SMART CACHE: Invalidate balance cache when new activity detected
 */
export async function invalidateUserBalanceCache(userId) {
  try {
    // Update user's lastPaymentTimestamp to trigger cache refresh
    await prismaQuery.user.update({
      where: { id: userId },
      data: { lastPaymentTimestamp: new Date() }
    });

    return true;
  } catch (error) {
    console.error('Error invalidating balance cache:', error);
    return false;
  }
}

/**
 * 📈 ACCURACY MONITOR: Track balance calculation accuracy over time
 */
export async function trackBalanceAccuracy(userId, chain, rpcTotal, activityTotal, highPrecisionTotal) {
  try {
    const accuracy = {
      userId,
      chain,
      rpcTotal: rpcTotal || 0,
      activityTotal: activityTotal || 0,
      highPrecisionTotal: highPrecisionTotal || 0,
      rpcActivityDiff: Math.abs((rpcTotal || 0) - (activityTotal || 0)),
      rpcPrecisionDiff: Math.abs((rpcTotal || 0) - (highPrecisionTotal || 0)),
      activityPrecisionDiff: Math.abs((activityTotal || 0) - (highPrecisionTotal || 0)),
      timestamp: new Date()
    };

    return accuracy;
  } catch (error) {
    console.error('Error tracking balance accuracy:', error);
    return null;
  }
}
