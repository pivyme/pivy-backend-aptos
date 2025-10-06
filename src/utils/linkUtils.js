import { prismaQuery } from '../lib/prisma.js';
import { isTestnet, CHAINS } from '../config.js';
import { getAlphanumericId } from './miscUtils.js';

/**
 * Map NetworkChain to WalletChain
 * @param {string} networkChain - NetworkChain value (APTOS_MAINNET, APTOS_TESTNET)
 * @returns {string} WalletChain value (APTOS)
 */
export const mapNetworkChainToWalletChain = (networkChain) => {
  switch (networkChain) {
    case 'APTOS_MAINNET':
    case 'APTOS_TESTNET':
      return 'APTOS';
    default:
      throw new Error(`Unsupported network chain: ${networkChain}`);
  }
};

/**
 * Map WalletChain to NetworkChain based on environment
 * @param {string} walletChain - WalletChain value (APTOS)
 * @returns {string} NetworkChain value (APTOS_MAINNET, APTOS_TESTNET)
 */
export const mapWalletChainToNetworkChain = (walletChain) => {
  switch (walletChain) {
    case 'APTOS':
      return isTestnet ? 'APTOS_TESTNET' : 'APTOS_MAINNET';
    default:
      throw new Error(`Unsupported wallet chain: ${walletChain}`);
  }
};

/**
 * Create a link with multi-chain configuration
 * @param {Object} linkData - Basic link data
 * @param {Array} chainConfigs - Array of chain configurations
 * @returns {Promise<Object>} Created link with chain configs
 */
export const createMultiChainLink = async (linkData, chainConfigs, tx = prismaQuery) => {
  const {
    userId,
    tag,
    label,
    description,
    type,
    amountType,
    emoji,
    backgroundColor,
    specialTheme,
    template,
    collectInfo,
    collectFields
  } = linkData;

  // Prevent duplicate personal links
  if (tag === '' && label === 'personal') {
    const existingPersonalLink = await tx.link.findFirst({
      where: {
        userId,
        tag: '',
        label: 'personal',
        status: 'ACTIVE'
      }
    });

    if (existingPersonalLink) {
      // Update the existing personal link instead of creating a duplicate
      return await tx.link.update({
        where: { id: existingPersonalLink.id },
        data: {
          emoji: emoji || existingPersonalLink.emoji,
          backgroundColor: backgroundColor || existingPersonalLink.backgroundColor,
          description,
          specialTheme,
          template,
          collectInfo,
          collectFields
        },
        include: {
          chainConfigs: {
            include: {
              mint: true
            }
          },
          files: {
            select: {
              id: true,
              type: true,
              category: true,
              filename: true,
              originalName: true,
              size: true,
              contentType: true,
              url: true,
              createdAt: true
            }
          },
          user: {
            select: {
              id: true,
              username: true
            }
          }
        }
      });
    }
  }

  // Map WalletChain values to NetworkChain values for supportedChains
  const supportedChains = chainConfigs.map(config => 
    mapWalletChainToNetworkChain(config.chain)
  );

  // Map chain configurations to use NetworkChain values
  const mappedChainConfigs = chainConfigs.map(config => ({
    chain: mapWalletChainToNetworkChain(config.chain),
    amount: config.amount,
    mintId: config.mintId,
    isEnabled: config.isEnabled !== false // default to true
  }));

  const link = await tx.link.create({
    data: {
      id: getAlphanumericId(8),
      userId,
      tag: tag || '',
      label,
      description,
      type,
      amountType,
      emoji: emoji || 'link',
      backgroundColor: backgroundColor || 'gray',
      specialTheme: specialTheme || 'default',
      template: template || 'simple-payment',
      collectInfo: collectInfo || false,
      collectFields: collectFields || null,
      supportedChains,
      chainConfigs: {
        create: mappedChainConfigs
      }
    },
    include: {
      chainConfigs: {
        include: {
          mint: true
        }
      },
      files: {
        select: {
          id: true,
          type: true,
          category: true,
          filename: true,
          originalName: true,
          size: true,
          contentType: true,
          url: true,
          createdAt: true
        }
      },
      user: {
        select: {
          id: true,
          username: true
        }
      }
    }
  });

  return link;
};

/**
 * Update chain configuration for a link
 * @param {string} linkId - Link ID
 * @param {string} chain - Chain to update
 * @param {Object} chainConfig - New chain configuration
 * @returns {Promise<Object>} Updated chain config
 */
export const updateLinkChainConfig = async (linkId, chain, chainConfig) => {
  const { amount, mintId, isEnabled } = chainConfig;

  const updatedConfig = await prismaQuery.linkChainConfig.upsert({
    where: {
      linkId_chain: {
        linkId,
        chain
      }
    },
    update: {
      amount,
      mintId,
      isEnabled
    },
    create: {
      linkId,
      chain,
      amount,
      mintId,
      isEnabled: isEnabled !== false
    },
    include: {
      mint: true
    }
  });

  // Update the link's supportedChains array
  const link = await prismaQuery.link.findUnique({
    where: { id: linkId },
    include: { chainConfigs: true }
  });

  const supportedChains = link.chainConfigs
    .filter(config => config.isEnabled)
    .map(config => config.chain);

  await prismaQuery.link.update({
    where: { id: linkId },
    data: { supportedChains }
  });

  return updatedConfig;
};

/**
 * Get link with chain-specific configuration
 * @param {string} linkId - Link ID
 * @param {string} chain - Specific chain to get config for (optional)
 * @returns {Promise<Object>} Link with chain configs
 */
export const getLinkWithChainConfig = async (linkId, chain = null) => {
  const link = await prismaQuery.link.findUnique({
    where: { id: linkId },
    include: {
      chainConfigs: {
        include: {
          mint: true
        },
        ...(chain && { where: { chain } }),
        orderBy: [
          { chain: 'desc' }
        ]
      },
      files: {
        select: {
          id: true,
          type: true,
          category: true,
          filename: true,
          size: true,
          contentType: true
        }
      },
      user: {
        select: {
          id: true,
          username: true
        }
      }
    }
  });


  return link;
};

/**
 * Get link configuration for a specific chain
 * @param {string} linkId - Link ID
 * @param {string} chain - Chain to get config for
 * @returns {Promise<Object|null>} Chain config or null if not supported
 */
export const getLinkChainConfig = async (linkId, chain) => {
  const chainConfig = await prismaQuery.linkChainConfig.findUnique({
    where: {
      linkId_chain: {
        linkId,
        chain
      }
    },
    include: {
      mint: true,
      link: {
        select: {
          id: true,
          tag: true,
          label: true,
          type: true,
          amountType: true,
          supportedChains: true
        }
      }
    }
  });

  return chainConfig;
};

/**
 * Check if a link supports a specific chain
 * @param {string} linkId - Link ID
 * @param {string} chain - Chain to check
 * @returns {Promise<boolean>} True if chain is supported and enabled
 */
export const isChainSupported = async (linkId, chain) => {
  const chainConfig = await prismaQuery.linkChainConfig.findUnique({
    where: {
      linkId_chain: {
        linkId,
        chain
      }
    }
  });

  return chainConfig && chainConfig.isEnabled;
};

/**
 * Get formatted link data for a specific chain (for public API)
 * @param {string} username - Username
 * @param {string} tag - Link tag
 * @param {string} chain - Chain to get data for
 * @returns {Promise<Object|null>} Formatted link data for the chain
 */
export const getPublicLinkForChain = async (username, tag, chain) => {
  const user = await prismaQuery.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      wallets: {
        where: {
          chain: mapNetworkChainToWalletChain(chain),
          isActive: true
        },
        select: {
          metaSpendPub: true,
          metaViewPub: true,
          isPrimary: true
        }
      },
      links: {
        where: {
          tag: tag || '',
          status: 'ACTIVE'
        },
        include: {
          chainConfigs: {
            where: {
              chain,
              isEnabled: true
            },
            include: {
              mint: true
            }
          },
          files: {
            select: {
              id: true,
              type: true,
              category: true,
              filename: true,
              size: true,
              contentType: true
            }
          }
        }
      }
    }
  });

  if (!user || !user.links[0]) {
    return null;
  }

  const link = user.links[0];
  const chainConfig = link.chainConfigs[0];

  if (!chainConfig) {
    return null; // Chain not supported for this link
  }

  // Get the appropriate wallet for this chain
  // Prefer primary wallet, fallback to first available wallet for the chain
  const wallet = user.wallets.find(w => w.isPrimary) || user.wallets[0];

  if (!wallet) {
    return null; // No wallet found for this chain
  }

  // Organize files by type for easy access
  const organizedFiles = {
    thumbnail: link.files.find(f => f.type === 'THUMBNAIL') || null,
    deliverables: link.files.filter(f => f.type === 'DELIVERABLE') || []
  };

  // Format the link data with chain-specific information
  const linkData = {
    ...link,
    amount: chainConfig.amount,
    mint: chainConfig.mint,
    chainAmount: chainConfig.amount && chainConfig.mint 
      ? BigInt(chainConfig.amount * (10 ** chainConfig.mint.decimals)).toString()
      : null,
    files: organizedFiles
  };

  return {
    username: user.username,
    tag: link.tag,
    metaSpendPub: wallet.metaSpendPub,
    metaViewPub: wallet.metaViewPub,
    linkData,
    sourceChain: chain,
    supportedChains: link.supportedChains
  };
};

/**
 * Add a chain configuration to an existing link
 * @param {string} linkId - Link ID
 * @param {string} chain - Chain to add
 * @param {Object} chainConfig - Chain configuration
 * @returns {Promise<Object>} Created chain config
 */
export const addChainToLink = async (linkId, chain, chainConfig) => {
  const { amount, mintId, isEnabled = true } = chainConfig;

  // Create the chain config
  const newChainConfig = await prismaQuery.linkChainConfig.create({
    data: {
      linkId,
      chain,
      amount,
      mintId,
      isEnabled
    },
    include: {
      mint: true
    }
  });

  // Update the link's supportedChains array
  const link = await prismaQuery.link.findUnique({
    where: { id: linkId },
    include: { chainConfigs: true }
  });

  const supportedChains = [...new Set([...link.supportedChains, chain])];

  await prismaQuery.link.update({
    where: { id: linkId },
    data: { supportedChains }
  });

  return newChainConfig;
};

/**
 * Remove a chain configuration from a link
 * @param {string} linkId - Link ID
 * @param {string} chain - Chain to remove
 * @returns {Promise<boolean>} True if removed successfully
 */
export const removeChainFromLink = async (linkId, chain) => {
  await prismaQuery.linkChainConfig.delete({
    where: {
      linkId_chain: {
        linkId,
        chain
      }
    }
  });

  // Update the link's supportedChains array
  const link = await prismaQuery.link.findUnique({
    where: { id: linkId },
    include: { chainConfigs: true }
  });

  const supportedChains = link.chainConfigs
    .filter(config => config.isEnabled)
    .map(config => config.chain);

  await prismaQuery.link.update({
    where: { id: linkId },
    data: { supportedChains }
  });

  return true;
};

// Helper function to get or create mint data for new multi-chain structure
export async function getOrCreateMintData(chainId, mintAddress, isNative = false) {
  try {
    // Check if mint data exists in cache
    const existingCache = await prismaQuery.mintDataCache.findUnique({
      where: {
        mintAddress_chain: {
          mintAddress: mintAddress,
          chain: chainId
        }
      }
    });

    if (existingCache && !existingCache.isInvalid) {
      // Update isNative flag if it differs from what's stored
      if (existingCache.isNative !== isNative) {
        await prismaQuery.mintDataCache.update({
          where: { id: existingCache.id },
          data: { isNative }
        });
        existingCache.isNative = isNative;
      }
      return existingCache;
    }

    // Check for known tokens using the CHAINS configuration
    let cacheData;
    const chainConfig = CHAINS[chainId];

    if (chainConfig && chainConfig.tokens) {
      const knownToken = chainConfig.tokens.find(token =>
        token.address === mintAddress
      );

      if (knownToken) {
        cacheData = {
          mintAddress: mintAddress,
          chain: chainId,
          name: knownToken.name,
          symbol: knownToken.symbol,
          decimals: knownToken.decimals,
          imageUrl: knownToken.image,
          description: `${knownToken.name} token`,
          uriData: {},
          isInvalid: false,
          isVerified: true,
          isNative: isNative // Use the provided isNative flag from the request
        };
      }
    }


    // Default fallback for unknown tokens
    if (!cacheData) {
      const shortAddr = mintAddress.slice(0, 5).toUpperCase();
      cacheData = {
        mintAddress: mintAddress,
        chain: chainId,
        name: `Token ${shortAddr}`,
        symbol: shortAddr,
        decimals: 6, // Default decimals for unknown tokens
        imageUrl: null,
        description: `Token at address ${mintAddress}`,
        uriData: {},
        isInvalid: false,
        isVerified: false,
        isNative: isNative // Use the provided isNative flag for unknown tokens
      };
    }

    // Create and return the mint data
    return await prismaQuery.mintDataCache.create({
      data: cacheData
    });
  } catch (error) {
    console.error('Error in getOrCreateMintData:', error);
    throw error;
  }
}

// Helper function to get or create token info (legacy - kept for backward compatibility)
export async function getOrCreateTokenInfo(chain, tokenData) {
  try {
    const chainId = CHAINS[chain].id;

    // Check if token exists in cache
    const existingCache = await prismaQuery.mintDataCache.findUnique({
      where: {
        mintAddress_chain: {
          mintAddress: tokenData.address,
          chain: chainId
        }
      }
    });

    if (existingCache && !existingCache.isInvalid) {
      return existingCache;
    }

    // Create fallback data using the mint address
    const shortAddr = tokenData.address.slice(0, 5).toUpperCase();
    const cacheData = {
      mintAddress: tokenData.address,
      chain: chainId,
      name: tokenData.name || `Unknown Token ${shortAddr}`,
      symbol: tokenData.symbol || shortAddr,
      decimals: tokenData.decimals || 0,
      imageUrl: tokenData.image || null,
      description: `Token at address ${tokenData.address}`,
      uriData: {},
      isInvalid: false
    };

    // Create and return the token info
    return await prismaQuery.mintDataCache.create({
      data: cacheData
    });
  } catch (error) {
    console.error('Error in getOrCreateTokenInfo:', error);
    throw error;
  }
}