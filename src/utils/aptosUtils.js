import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { CHAINS } from "../config.js";
import { prismaQuery } from "../lib/prisma.js";

/**
 * Get or create token cache for Aptos tokens
 * @param {string} assetType - The asset type (e.g., "0x1::aptos_coin::AptosCoin")
 * @param {string} chainId - The chain ID (APTOS_MAINNET or APTOS_TESTNET)
 * @param {Aptos} aptosClient - The Aptos client instance
 * @returns {Promise<Object>}
 */
export const getOrCreateAptosTokenCache = async (assetType, chainId, aptosClient) => {
  try {
    const existingCache = await prismaQuery.mintDataCache.findUnique({
      where: {
        mintAddress_chain: {
          mintAddress: assetType,
          chain: chainId
        }
      }
    });

    if (existingCache && !existingCache.isInvalid) {
      return existingCache;
    }

    console.log('Getting token info for assetType: ', assetType);

    // Try to get fungible asset metadata using REST API
    let metadata = null;
    try {
      // Check if assetType is a metadata address (0x...) or a coin type (0x...::module::Type)
      const isMetadataAddress = assetType.length === 66 && !assetType.includes('::');
      
      if (isMetadataAddress) {
        // Fetch metadata from the metadata object address
        const chain = CHAINS[chainId];
        const rpcUrl = chain.rpcUrl || chain.publicRpcUrl;
        
        // Setup headers with API key if available
        const fetchOptions = {
          headers: {
            'Accept': 'application/json'
          }
        };
        
        const aptosApiKey = process.env.APTOS_API_KEY;
        if (aptosApiKey) {
          fetchOptions.headers['Authorization'] = `Bearer ${aptosApiKey}`;
        }
        
        const response = await fetch(`${rpcUrl}/v1/accounts/${assetType}/resource/0x1::fungible_asset::Metadata`, fetchOptions);
        
        if (response.ok) {
          const resourceData = await response.json();
          metadata = {
            name: resourceData.data.name,
            symbol: resourceData.data.symbol,
            decimals: resourceData.data.decimals,
            icon_uri: resourceData.data.icon_uri,
            project_uri: resourceData.data.project_uri,
            asset_type: assetType
          };
        }
      } else {
        // For coin types, try GraphQL as fallback
        try {
          const query = `
            query GetFungibleAssetInfo($in: [String!]) {
              fungible_asset_metadata(
                where: { asset_type: { _in: $in } }
                limit: 1
              ) {
                symbol
                name
                decimals
                asset_type
                icon_uri
                project_uri
                __typename
              }
            }
          `;

          const variables = {
            in: [assetType]
          };

          const response = await aptosClient.queryIndexer({
            query: {
              query: query,
              variables: variables
            }
          });

          if (response.fungible_asset_metadata && response.fungible_asset_metadata.length > 0) {
            metadata = response.fungible_asset_metadata[0];
          }
        } catch (indexerError) {
          console.log('GraphQL indexer unavailable, using basic metadata');
        }
      }
    } catch (error) {
      console.log('Error fetching fungible asset metadata:', error.message);
      metadata = null;
    }

    // Special handling for native APT token
    const isNativeAPT = assetType === "0x1::aptos_coin::AptosCoin";
    const isUSDC = assetType === "0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832";
    
    const cacheData = {
      mintAddress: assetType,
      chain: chainId,
      name: isNativeAPT ? "Aptos Coin" : (isUSDC ? "USD Coin" : (metadata?.name || assetType.split("::").pop() || "UNKNOWN")),
      symbol: isNativeAPT ? "APT" : (isUSDC ? "USDC" : (metadata?.symbol || assetType.split("::").pop() || "UNKNOWN")),
      decimals: isUSDC ? 6 : (metadata?.decimals || 8), // USDC has 6 decimals on Aptos
      imageUrl: isNativeAPT ? "/assets/tokens/aptos.png" : (isUSDC ? "/assets/tokens/usdc.png" : (metadata?.icon_uri || null)),
      description: isNativeAPT ? "Native Aptos token" : (isUSDC ? "USD Coin via CCTP" : (metadata?.project_uri || `Asset at ${assetType}`)),
      uriData: metadata ? {
        icon_uri: metadata.icon_uri,
        project_uri: metadata.project_uri
      } : null,
      isInvalid: false,
      isNative: isNativeAPT,
      isVerified: isNativeAPT || isUSDC // Mark USDC as verified
    };

    let priceUsd;
    // If symbol contains USD, EUR, GBP, or USDT, then set priceUsd to 1
    if (cacheData.symbol.includes("USD") || cacheData.symbol.includes("EUR") ||
        cacheData.symbol.includes("GBP") || cacheData.symbol.includes("USDT")) {
      priceUsd = 1;
      cacheData.priceUsd = priceUsd;
    }
    // For APT, don't set priceUsd here - it's managed by the token worker
    // else {
    //   // TODO: integrate with a price oracle for Aptos tokens
    //   priceUsd = 0;
    //   cacheData.priceUsd = priceUsd;
    // }

    const savedCache = await prismaQuery.mintDataCache.upsert({
      where: {
        mintAddress_chain: {
          mintAddress: assetType,
          chain: chainId
        }
      },
      update: cacheData,
      create: cacheData
    });

    console.log('Inserted cache for', assetType, 'with name:', cacheData.name, 'symbol:', cacheData.symbol, 'decimals:', cacheData.decimals);

    return savedCache;
  } catch (error) {
    console.error('Error getting Aptos token info:', error);
    
    // Try to create a basic cache entry even if metadata fetch fails
    const isNativeAPT = assetType === "0x1::aptos_coin::AptosCoin";
    const isUSDC = assetType === "0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832";
    
    const basicCacheData = {
      mintAddress: assetType,
      chain: chainId,
      name: isNativeAPT ? "Aptos Coin" : (isUSDC ? "USD Coin" : (assetType.split("::").pop() || "UNKNOWN")),
      symbol: isNativeAPT ? "APT" : (isUSDC ? "USDC" : (assetType.split("::").pop() || "UNKNOWN")),
      decimals: isUSDC ? 6 : 8, // USDC has 6 decimals on Aptos
      imageUrl: isNativeAPT ? "/assets/tokens/aptos.png" : (isUSDC ? "/assets/tokens/usdc.png" : null),
      description: isNativeAPT ? "Native Aptos token" : (isUSDC ? "USD Coin via CCTP" : `Asset at ${assetType}`),
      uriData: null,
      isInvalid: false,
      isNative: isNativeAPT,
      isVerified: isNativeAPT || isUSDC, // Mark USDC as verified
      ...(isUSDC ? { priceUsd: 1 } : {}) // Only set priceUsd for USDC, let token worker handle APT
    };

    try {
      // Try to save to database even with basic info
      const savedCache = await prismaQuery.mintDataCache.upsert({
        where: {
          mintAddress_chain: {
            mintAddress: assetType,
            chain: chainId
          }
        },
        update: basicCacheData,
        create: basicCacheData
      });
      return savedCache;
    } catch (dbError) {
      console.error('Error saving basic token cache:', dbError);
      // If we can't save to DB, return null so calling code can handle it
      return null;
    }
  }
};

/**
 * Validate and format an Aptos address
 * @param {string} address - The address to validate
 * @returns {Object|null} - Formatted address object if valid, null otherwise
 */
export const validateAptosAddress = (address) => {
  // Early validation - basic checks
  if (!address || typeof address !== 'string') {
    return null;
  }

  // Aptos addresses are typically 64+ characters and start with 0x
  // Can also be shorter if not padded
  if (address.length < 3 || !address.startsWith('0x')) {
    return null;
  }

  // Basic hex validation
  const hexPattern = /^0x[a-fA-F0-9]+$/;
  if (!hexPattern.test(address)) {
    return null;
  }

  // Normalize the address (pad to 66 characters if needed)
  const normalizedAddress = address.length < 66 
    ? '0x' + address.slice(2).padStart(64, '0')
    : address;

  return {
    type: 'address',
    address: normalizedAddress,
    displayName: `${normalizedAddress.slice(0, 6)}...${normalizedAddress.slice(-4)}`,
    displayType: 'ADDRESS'
  };
};

/**
 * Fetch verified tokens from Aptos ecosystem
 * Note: This is a placeholder - you may want to integrate with a specific token list
 * @returns {Promise<Array>} Array of verified token objects
 */
export const fetchAptosVerifiedTokens = async () => {
  // TODO: Integrate with an Aptos token registry or list
  // For now, return the native APT coin
  return [
    {
      assetType: '0x1::aptos_coin::AptosCoin',
      symbol: 'APT',
      name: 'Aptos Coin',
      decimals: 8,
      isVerified: true
    }
  ];
};

/**
 * Create an Aptos client for the specified chain
 * @param {string} chainId - The chain ID (APTOS_MAINNET or APTOS_TESTNET)
 * @returns {Aptos} Aptos client instance
 */
export const createAptosClient = (chainId) => {
  const chain = CHAINS[chainId];
  if (!chain) {
    throw new Error(`Invalid chainId: ${chainId}`);
  }

  // Map chain IDs to Aptos Network enum
  const networkMap = {
    'APTOS_MAINNET': Network.MAINNET,
    'APTOS_TESTNET': Network.TESTNET
  };

  const network = networkMap[chainId];
  if (!network) {
    throw new Error(`Unsupported Aptos chain: ${chainId}`);
  }

  const configOptions = { 
    network,
    fullnode: chain.rpcUrl || chain.publicRpcUrl
  };

  // Add API key to client config if available
  const aptosApiKey = process.env.APTOS_API_KEY;
  if (aptosApiKey) {
    configOptions.clientConfig = {
      API_KEY: aptosApiKey
    };
  }

  const aptosConfig = new AptosConfig(configOptions);
  
  return new Aptos(aptosConfig);
};

/**
 * Gets the portfolio information for an Aptos wallet address
 * @param {string} address - The Aptos wallet address to get portfolio information for
 * @param {string} chainId - The chain ID (APTOS_MAINNET or APTOS_TESTNET)
 * @param {import("@aptos-labs/ts-sdk").Aptos} aptosClient - The Aptos client instance for making RPC calls
 * @returns {Promise<Object>}
 */
export const getAptosPortfolio = async (address, chainId, aptosClient) => {
  console.log("Getting Aptos portfolio for address: ", address);

  try {
    // Get fungible asset balances using GraphQL query
    const query = `
      query GetFungibleAssetBalances($address: String) {
        current_fungible_asset_balances(
          where: {
            owner_address: { _eq: $address }
          }
          order_by: { amount: desc }
        ) {
          asset_type
          amount
          __typename
        }
      }
    `;

    const variables = {
      address: address
    };

    let balances;
    try {
      const response = await aptosClient.queryIndexer({
        query: {
          query: query,
          variables: variables
        }
      });

      balances = response.current_fungible_asset_balances || [];
    } catch (error) {
      console.error('Error querying Aptos indexer:', error);
      balances = [];
    }

    // Initialize native balance with default values
    let nativeBalance = {
      mint: "0x1::aptos_coin::AptosCoin",
      name: "APT",
      symbol: "APT",
      decimals: 8,
      imageUrl: '/assets/tokens/aptos.png',
      amount: 0,
      usdValue: 0
    };

    let tokenBalance = [];

    for (const balance of balances) {
      const tokenInfo = await getOrCreateAptosTokenCache(
        balance.asset_type,
        chainId,
        aptosClient
      );

      // Skip if we couldn't get token info
      if (!tokenInfo) continue;

      const rawAmount = BigInt(balance.amount);
      const uiAmount = Number(rawAmount) / Math.pow(10, tokenInfo.decimals);
      const usdValue = uiAmount * (tokenInfo.priceUsd || 0);

      // If it's the native APT coin, update the native balance
      if (balance.asset_type === "0x1::aptos_coin::AptosCoin") {
        nativeBalance.amount = uiAmount;
        nativeBalance.usdValue = usdValue;
        continue; // Skip adding to tokenBalance
      }

      // Add non-native tokens to tokenBalance
      tokenBalance.push({
        mint: balance.asset_type,
        owner: address,
        tokenAmount: uiAmount,
        usdValue: usdValue,
        token: {
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          decimals: tokenInfo.decimals,
          imageUrl: tokenInfo.imageUrl,
          description: tokenInfo.description,
          priceUsd: tokenInfo.priceUsd || 0
        }
      });
    }

    return {
      nativeBalance,
      tokenBalance
    };
  } catch (error) {
    console.error("Error getting Aptos portfolio:", error);
    
    // Return empty portfolio on error
    return {
      nativeBalance: {
        mint: "0x1::aptos_coin::AptosCoin",
        name: "APT",
        symbol: "APT",
        decimals: 8,
        imageUrl: '/assets/tokens/aptos.png',
        amount: 0,
        usdValue: 0
      },
      tokenBalance: []
    };
  }
};

