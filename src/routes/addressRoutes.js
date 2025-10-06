import { prismaQuery } from "../lib/prisma.js";
import { handleError, handleNotFoundError } from "../utils/errorHandler.js";
import { getPublicLinkForChain } from "../utils/linkUtils.js";
import { searchANSByDomain, getPrimaryANSForAddress, validateAptosAddress, normalizeAptosAddress } from "../utils/aptosNsUtils.js";

/**
 * Map NetworkChain to WalletChain
 * @param {string} networkChain - NetworkChain value (APTOS_MAINNET, APTOS_TESTNET)
 * @returns {string} WalletChain value (APTOS)
 */
const mapNetworkChainToWalletChain = (networkChain) => {
  switch (networkChain) {
    case 'APTOS_MAINNET':
    case 'APTOS_TESTNET':
      return 'APTOS';
    default:
      throw new Error(`Unsupported network chain: ${networkChain}`);
  }
};

// View count throttle cache - tracks last view increment time for each link
const viewCountThrottleCache = new Map();
const THROTTLE_DURATION = 3 * 1000; // 3 seconds in milliseconds

/**
 * Check if view count can be incremented for a given link
 * @param {string} linkId - The link ID to check
 * @returns {boolean} - True if view count can be incremented, false otherwise
 */
const canIncrementViewCount = (linkId) => {
  const lastIncrementTime = viewCountThrottleCache.get(linkId);
  const now = Date.now();

  if (!lastIncrementTime || (now - lastIncrementTime) >= THROTTLE_DURATION) {
    viewCountThrottleCache.set(linkId, now);
    return true;
  }

  return false;
};

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const addressRoutes = (app, _, done) => {
  
  // Shared function to handle link data retrieval by linkId
  const getLinkDataById = async (linkId) => {
    const link = await prismaQuery.link.findUnique({
      where: {
        id: linkId,
        status: 'ACTIVE'
      },
      select: {
        id: true,
        tag: true,
        label: true,
        description: true,
        emoji: true,
        backgroundColor: true,
        specialTheme: true,
        type: true,
        amountType: true,
        viewCount: true,
        supportedChains: true,
        template: true,
        goalAmount: true,
        collectInfo: true,
        collectFields: true,
        isStable: true,
        stableToken: true,
        chainConfigs: {
          where: {
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
        },
        user: {
          select: {
            id: true,
            username: true,
            profileImageType: true,
            profileImageData: true,
            wallets: {
              where: {
                isActive: true
              },
              select: {
                chain: true,
                metaSpendPub: true,
                metaViewPub: true,
                isPrimary: true
              }
            }
          }
        }
      }
    });

    if (!link) {
      throw new Error("LINK_NOT_FOUND");
    }

    const user = link.user;

    if (!user) {
      throw new Error("USER_NOT_FOUND");
    }

      // Get chain-specific data for each supported chain
  const chains = {};
  const chainPromises = link.supportedChains.map(async (chain) => {
    const chainSpecificData = await getPublicLinkForChain(user.username, link.tag, chain);
    if (chainSpecificData) {
      // Get the appropriate wallet for this specific chain
      const walletChain = mapNetworkChainToWalletChain(chain);
      const chainWallet = user.wallets.find(w => w.chain === walletChain);
      
      // Base chain data
      const chainData = {
        amount: chainSpecificData.linkData.amount,
        mint: chainSpecificData.linkData.mint,
        chainAmount: chainSpecificData.linkData.chainAmount,
        metaSpendPub: chainWallet?.metaSpendPub || null,
        metaViewPub: chainWallet?.metaViewPub || null,
        isEnabled: true
      };

      // Add fundraising-specific data if it's a fundraising template
      if (link.template === 'fundraiser') {
        // Get chain-specific goal amount from chainConfigs
        const chainConfig = link.chainConfigs.find(config => config.chain === chain && config.isEnabled);
        
        // Include goal amounts (both from link and chain config)
        chainData.goalAmount = chainConfig?.goalAmount || link.goalAmount || null;
        
        // Calculate current collected amount from payments
        const collectedPayments = await prismaQuery.payment.findMany({
          where: {
            linkId: link.id,
            chain: chain
          },
          include: {
            mint: true
          }
        });

        // Aggregate collected amounts by token
        let totalCollectedRaw = BigInt(0);
        let totalCollectedUi = 0;
        let totalCollectedUsd = 0;
        
        if (collectedPayments.length > 0) {
          // Group payments by mint to handle multiple tokens
          const paymentsByMint = collectedPayments.reduce((acc, payment) => {
            const mintAddress = payment.mint.mintAddress;
            if (!acc[mintAddress]) {
              acc[mintAddress] = {
                mint: payment.mint,
                totalAmount: BigInt(0)
              };
            }
            acc[mintAddress].totalAmount += payment.amount;
            return acc;
          }, {});

          // For fundraising, we typically expect one token type, but handle multiple
          Object.values(paymentsByMint).forEach(({ mint, totalAmount }) => {
            totalCollectedRaw += totalAmount;
            const uiAmount = Number(totalAmount) / Math.pow(10, mint.decimals);
            totalCollectedUi += uiAmount;
            totalCollectedUsd += mint.priceUsd ? uiAmount * mint.priceUsd : 0;
          });
        }

        // Add collected amount data
        if (chainSpecificData.linkData.mint) {
          const mint = chainSpecificData.linkData.mint;
          chainData.collectedAmount = {
            raw: totalCollectedRaw.toString(), // Raw collected amount in smallest unit
            ui: totalCollectedUi, // Human-readable collected amount
            usdValue: totalCollectedUsd, // USD value of collected amount
            token: {
              symbol: mint.symbol,
              name: mint.name,
              decimals: mint.decimals,
              imageUrl: mint.imageUrl,
              mintAddress: mint.mintAddress,
              priceUsd: mint.priceUsd || 0
            }
          };

          // Calculate progress percentage
          if (chainData.goalAmount && chainData.goalAmount > 0) {
            chainData.progressPercentage = Math.min((totalCollectedUi / chainData.goalAmount) * 100, 100);
          } else {
            chainData.progressPercentage = 0;
          }
        }
        
        // Add formatted token amounts with UI amounts and USD values
        if (chainSpecificData.linkData.mint && chainData.amount) {
          const mint = chainSpecificData.linkData.mint;
          chainData.tokenAmount = {
            raw: chainData.chainAmount, // Raw amount in smallest unit
            ui: chainData.amount, // Human-readable amount
            usdValue: mint.priceUsd ? chainData.amount * mint.priceUsd : 0,
            token: {
              symbol: mint.symbol,
              name: mint.name,
              decimals: mint.decimals,
              imageUrl: mint.imageUrl,
              mintAddress: mint.mintAddress,
              priceUsd: mint.priceUsd || 0
            }
          };
        }

        // Add formatted goal amount with UI amounts and USD values
        if (chainData.goalAmount && chainSpecificData.linkData.mint) {
          const mint = chainSpecificData.linkData.mint;
          const goalChainAmount = BigInt(chainData.goalAmount * (10 ** mint.decimals)).toString();
          
          chainData.goalTokenAmount = {
            raw: goalChainAmount, // Raw goal amount in smallest unit
            ui: chainData.goalAmount, // Human-readable goal amount
            usdValue: mint.priceUsd ? chainData.goalAmount * mint.priceUsd : 0,
            token: {
              symbol: mint.symbol,
              name: mint.name,
              decimals: mint.decimals,
              imageUrl: mint.imageUrl,
              mintAddress: mint.mintAddress,
              priceUsd: mint.priceUsd || 0
            }
          };
        }
      }
      
      chains[chain] = chainData;
    }
  });

    // Wait for all chain data to be fetched
    await Promise.all(chainPromises);

    // Clean link data - remove internal fields and redundant data
    // Organize files by type for easy access
    const organizedFiles = {
      thumbnail: link.files.find(f => f.type === 'THUMBNAIL') || null,
      deliverables: link.files.filter(f => f.type === 'DELIVERABLE') || []
    };

    const cleanLinkData = {
      id: link.id,
      tag: link.tag,
      label: link.label,
      description: link.description,
      emoji: link.emoji,
      backgroundColor: link.backgroundColor,
      specialTheme: link.specialTheme,
      type: link.type,
      amountType: link.amountType,
      viewCount: link.viewCount,
      template: link.template,
      goalAmount: link.goalAmount,
      collectInfo: link.collectInfo,
      collectFields: link.collectFields,
      files: organizedFiles,
      isStable: link.isStable,
      stableToken: link.stableToken
    };

    // Add collected data for fundraiser templates
    if (link.template === 'fundraiser') {
      // Calculate total collected across all chains
      const collectedPayments = await prismaQuery.payment.findMany({
        where: {
          linkId: link.id
        },
        include: {
          mint: true
        }
      });

      // Aggregate collected amounts by token across all chains
      const collectedByToken = {};
      let totalCollectedUsd = 0;

      collectedPayments.forEach(payment => {
        const mintAddress = payment.mint.mintAddress;
        if (!collectedByToken[mintAddress]) {
          collectedByToken[mintAddress] = {
            mint: payment.mint,
            totalAmount: BigInt(0),
            chains: new Set()
          };
        }
        collectedByToken[mintAddress].totalAmount += payment.amount;
        collectedByToken[mintAddress].chains.add(payment.chain);
      });

      // Format collected data
      const collectedTokens = Object.values(collectedByToken).map(({ mint, totalAmount, chains }) => {
        const uiAmount = Number(totalAmount) / Math.pow(10, mint.decimals);
        const usdValue = mint.priceUsd ? uiAmount * mint.priceUsd : 0;
        totalCollectedUsd += usdValue;

        return {
          raw: totalAmount.toString(),
          ui: uiAmount,
          usdValue: usdValue,
          token: {
            symbol: mint.symbol,
            name: mint.name,
            decimals: mint.decimals,
            imageUrl: mint.imageUrl,
            mintAddress: mint.mintAddress,
            priceUsd: mint.priceUsd || 0
          },
          chains: Array.from(chains)
        };
      });

      cleanLinkData.collectedData = {
        totalUsdValue: totalCollectedUsd,
        tokens: collectedTokens,
        totalPayments: collectedPayments.length
      };
    }

    // Clean user data
    const userData = {
      username: user.username,
      profileImageType: user.profileImageType,
      profileImageData: user.profileImageData
    };

    return {
      userData: userData,
      linkData: cleanLinkData,
      supportedChains: link.supportedChains,
      chains: chains,
      linkId: link.id
    };
  };

  // Shared function to handle link data retrieval
  const getLinkData = async (username, tag = "") => {
    const user = await prismaQuery.user.findUnique({
      where: {
        username: username
      },
      select: {
        id: true,
        username: true,
        profileImageType: true,
        profileImageData: true,
        wallets: {
          where: {
            isActive: true
          },
          select: {
            chain: true,
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
          select: {
            id: true,
            tag: true,
            label: true,
            description: true,
            emoji: true,
            backgroundColor: true,
            specialTheme: true,
            type: true,
            amountType: true,
            viewCount: true,
            supportedChains: true,
            template: true,
            goalAmount: true,
            collectInfo: true,
            collectFields: true,
            isStable: true,
            stableToken: true,
            chainConfigs: {
              where: {
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

    if (!user) {
      throw new Error("USER_NOT_FOUND");
    }

    const link = user.links[0];

    if (!link) {
      throw new Error("LINK_NOT_FOUND");
    }

      // Get chain-specific data for each supported chain
  const chains = {};
  const chainPromises = link.supportedChains.map(async (chain) => {
    const chainSpecificData = await getPublicLinkForChain(username, tag, chain);
    if (chainSpecificData) {
      // Get the appropriate wallet for this specific chain
      const walletChain = mapNetworkChainToWalletChain(chain);
      const chainWallet = user.wallets.find(w => w.chain === walletChain);
      
      // Base chain data
      const chainData = {
        amount: chainSpecificData.linkData.amount,
        mint: chainSpecificData.linkData.mint,
        chainAmount: chainSpecificData.linkData.chainAmount,
        metaSpendPub: chainWallet?.metaSpendPub || null,
        metaViewPub: chainWallet?.metaViewPub || null,
        isEnabled: true
      };

      // Add fundraising-specific data if it's a fundraising template
      if (link.template === 'fundraiser') {
        // Get chain-specific goal amount from chainConfigs
        const chainConfig = link.chainConfigs.find(config => config.chain === chain && config.isEnabled);
        
        // Include goal amounts (both from link and chain config)
        chainData.goalAmount = chainConfig?.goalAmount || link.goalAmount || null;
        
        // Calculate current collected amount from payments
        const collectedPayments = await prismaQuery.payment.findMany({
          where: {
            linkId: link.id,
            chain: chain
          },
          include: {
            mint: true
          }
        });

        // Aggregate collected amounts by token
        let totalCollectedRaw = BigInt(0);
        let totalCollectedUi = 0;
        let totalCollectedUsd = 0;
        
        if (collectedPayments.length > 0) {
          // Group payments by mint to handle multiple tokens
          const paymentsByMint = collectedPayments.reduce((acc, payment) => {
            const mintAddress = payment.mint.mintAddress;
            if (!acc[mintAddress]) {
              acc[mintAddress] = {
                mint: payment.mint,
                totalAmount: BigInt(0)
              };
            }
            acc[mintAddress].totalAmount += payment.amount;
            return acc;
          }, {});

          // For fundraising, we typically expect one token type, but handle multiple
          Object.values(paymentsByMint).forEach(({ mint, totalAmount }) => {
            totalCollectedRaw += totalAmount;
            const uiAmount = Number(totalAmount) / Math.pow(10, mint.decimals);
            totalCollectedUi += uiAmount;
            totalCollectedUsd += mint.priceUsd ? uiAmount * mint.priceUsd : 0;
          });
        }

        // Add collected amount data
        if (chainSpecificData.linkData.mint) {
          const mint = chainSpecificData.linkData.mint;
          chainData.collectedAmount = {
            raw: totalCollectedRaw.toString(), // Raw collected amount in smallest unit
            ui: totalCollectedUi, // Human-readable collected amount
            usdValue: totalCollectedUsd, // USD value of collected amount
            token: {
              symbol: mint.symbol,
              name: mint.name,
              decimals: mint.decimals,
              imageUrl: mint.imageUrl,
              mintAddress: mint.mintAddress,
              priceUsd: mint.priceUsd || 0
            }
          };

          // Calculate progress percentage
          if (chainData.goalAmount && chainData.goalAmount > 0) {
            chainData.progressPercentage = Math.min((totalCollectedUi / chainData.goalAmount) * 100, 100);
          } else {
            chainData.progressPercentage = 0;
          }
        }
        
        // Add formatted token amounts with UI amounts and USD values
        if (chainSpecificData.linkData.mint && chainData.amount) {
          const mint = chainSpecificData.linkData.mint;
          chainData.tokenAmount = {
            raw: chainData.chainAmount, // Raw amount in smallest unit
            ui: chainData.amount, // Human-readable amount
            usdValue: mint.priceUsd ? chainData.amount * mint.priceUsd : 0,
            token: {
              symbol: mint.symbol,
              name: mint.name,
              decimals: mint.decimals,
              imageUrl: mint.imageUrl,
              mintAddress: mint.mintAddress,
              priceUsd: mint.priceUsd || 0
            }
          };
        }

        // Add formatted goal amount with UI amounts and USD values
        if (chainData.goalAmount && chainSpecificData.linkData.mint) {
          const mint = chainSpecificData.linkData.mint;
          const goalChainAmount = BigInt(chainData.goalAmount * (10 ** mint.decimals)).toString();
          
          chainData.goalTokenAmount = {
            raw: goalChainAmount, // Raw goal amount in smallest unit
            ui: chainData.goalAmount, // Human-readable goal amount
            usdValue: mint.priceUsd ? chainData.goalAmount * mint.priceUsd : 0,
            token: {
              symbol: mint.symbol,
              name: mint.name,
              decimals: mint.decimals,
              imageUrl: mint.imageUrl,
              mintAddress: mint.mintAddress,
              priceUsd: mint.priceUsd || 0
            }
          };
        }
      }
      
      chains[chain] = chainData;
    }
  });

    // Wait for all chain data to be fetched
    await Promise.all(chainPromises);

    // Clean link data - remove internal fields and redundant data
    // Organize files by type for easy access
    const organizedFiles = {
      thumbnail: link.files.find(f => f.type === 'THUMBNAIL') || null,
      deliverables: link.files.filter(f => f.type === 'DELIVERABLE') || []
    };

    const cleanLinkData = {
      id: link.id,
      tag: link.tag,
      label: link.label,
      description: link.description,
      emoji: link.emoji,
      backgroundColor: link.backgroundColor,
      specialTheme: link.specialTheme,
      type: link.type,
      amountType: link.amountType,
      viewCount: link.viewCount,
      template: link.template,
      goalAmount: link.goalAmount,
      collectInfo: link.collectInfo,
      collectFields: link.collectFields,
      files: organizedFiles,
      isStable: link.isStable,
      stableToken: link.stableToken
    };

    // Add collected data for fundraiser templates
    if (link.template === 'fundraiser') {
      // Calculate total collected across all chains
      const collectedPayments = await prismaQuery.payment.findMany({
        where: {
          linkId: link.id
        },
        include: {
          mint: true
        }
      });

      // Aggregate collected amounts by token across all chains
      const collectedByToken = {};
      let totalCollectedUsd = 0;

      collectedPayments.forEach(payment => {
        const mintAddress = payment.mint.mintAddress;
        if (!collectedByToken[mintAddress]) {
          collectedByToken[mintAddress] = {
            mint: payment.mint,
            totalAmount: BigInt(0),
            chains: new Set()
          };
        }
        collectedByToken[mintAddress].totalAmount += payment.amount;
        collectedByToken[mintAddress].chains.add(payment.chain);
      });

      // Format collected data
      const collectedTokens = Object.values(collectedByToken).map(({ mint, totalAmount, chains }) => {
        const uiAmount = Number(totalAmount) / Math.pow(10, mint.decimals);
        const usdValue = mint.priceUsd ? uiAmount * mint.priceUsd : 0;
        totalCollectedUsd += usdValue;

        return {
          raw: totalAmount.toString(),
          ui: uiAmount,
          usdValue: usdValue,
          token: {
            symbol: mint.symbol,
            name: mint.name,
            decimals: mint.decimals,
            imageUrl: mint.imageUrl,
            mintAddress: mint.mintAddress,
            priceUsd: mint.priceUsd || 0
          },
          chains: Array.from(chains)
        };
      });

      cleanLinkData.collectedData = {
        totalUsdValue: totalCollectedUsd,
        tokens: collectedTokens,
        totalPayments: collectedPayments.length
      };
    }

    // Clean user data
    const userData = {
      username: user.username,
      profileImageType: user.profileImageType,
      profileImageData: user.profileImageData
    };

    return {
      userData: userData,
      linkData: cleanLinkData,
      supportedChains: link.supportedChains,
      chains: chains,
      linkId: link.id
    };
  };

  // Rate limit link data requests by linkId - generous for public access
  app.get('/link/:linkId', {
    config: {
      rateLimit: {
        max: 100, // Allow up to 60 requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { linkId } = request.params;

      const data = await getLinkDataById(linkId);

      // Only increment view count if throttle allows it (max once per 3 seconds)
      if (canIncrementViewCount(data.linkId)) {
        console.log('Incrementing view count for link', data.linkId);
        await prismaQuery.link.update({
          where: {
            id: data.linkId
          },
          data: {
            viewCount: { increment: 1 }
          }
        });
      } else {
        console.log('Skipping view count increment for link', data.linkId);
      }

      // Remove linkId from response (internal use only)
      delete data.linkId;

      return reply.status(200).send(data);
    } catch (error) {
      if (error.message === "USER_NOT_FOUND") {
        return handleNotFoundError(reply, "User");
      }
      if (error.message === "LINK_NOT_FOUND") {
        return handleNotFoundError(reply, "Link");
      }
      return handleError(reply, 500, "Error getting link by ID", 'GET_LINK_BY_ID_ERROR', error);
    }
  })

  // Rate limit chain-specific link data requests - generous for public access
  app.get('/:username/:tag/:chain', {
    config: {
      rateLimit: {
        max: 60, // Allow up to 60 requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { username, chain } = request.params;
      const tag = request.params.tag ?? "";

      // Validate chain parameter
      if (!['APTOS_MAINNET', 'APTOS_TESTNET'].includes(chain)) {
        return handleError(reply, 400, "Invalid chain parameter", 'INVALID_CHAIN', null, { validChains: ['APTOS_MAINNET', 'APTOS_TESTNET'] });
      }

      const data = await getPublicLinkForChain(username, tag, chain);

      if (!data) {
        return handleNotFoundError(reply, "Link or chain configuration");
      }

      // Add fundraising-specific data if it's a fundraising template
      if (data.linkData.template === 'fundraiser') {
        // Get the full link data to access goalAmount and chainConfigs
        const fullLinkData = await prismaQuery.link.findFirst({
          where: {
            user: {
              username: username
            },
            tag: tag || '',
            status: 'ACTIVE'
          },
          include: {
            chainConfigs: {
              where: {
                chain: chain,
                isEnabled: true
              },
              include: {
                mint: true
              }
            }
          }
        });

        if (fullLinkData) {
          const chainConfig = fullLinkData.chainConfigs[0];
          
          // Add goal amount (prioritize chain-specific, fallback to link-level)
          data.linkData.goalAmount = chainConfig?.goalAmount || fullLinkData.goalAmount || null;
          
          // Calculate current collected amount from payments
          const collectedPayments = await prismaQuery.payment.findMany({
            where: {
              linkId: fullLinkData.id,
              chain: chain
            },
            include: {
              mint: true
            }
          });

          // Aggregate collected amounts by token
          let totalCollectedRaw = BigInt(0);
          let totalCollectedUi = 0;
          let totalCollectedUsd = 0;
          
          if (collectedPayments.length > 0) {
            // Group payments by mint to handle multiple tokens
            const paymentsByMint = collectedPayments.reduce((acc, payment) => {
              const mintAddress = payment.mint.mintAddress;
              if (!acc[mintAddress]) {
                acc[mintAddress] = {
                  mint: payment.mint,
                  totalAmount: BigInt(0)
                };
              }
              acc[mintAddress].totalAmount += payment.amount;
              return acc;
            }, {});

            // For fundraising, we typically expect one token type, but handle multiple
            Object.values(paymentsByMint).forEach(({ mint, totalAmount }) => {
              totalCollectedRaw += totalAmount;
              const uiAmount = Number(totalAmount) / Math.pow(10, mint.decimals);
              totalCollectedUi += uiAmount;
              totalCollectedUsd += mint.priceUsd ? uiAmount * mint.priceUsd : 0;
            });
          }

          // Add collected amount data
          if (data.linkData.mint) {
            const mint = data.linkData.mint;
            data.linkData.collectedAmount = {
              raw: totalCollectedRaw.toString(), // Raw collected amount in smallest unit
              ui: totalCollectedUi, // Human-readable collected amount
              usdValue: totalCollectedUsd, // USD value of collected amount
              token: {
                symbol: mint.symbol,
                name: mint.name,
                decimals: mint.decimals,
                imageUrl: mint.imageUrl,
                mintAddress: mint.mintAddress,
                priceUsd: mint.priceUsd || 0
              }
            };

            // Calculate progress percentage
            if (data.linkData.goalAmount && data.linkData.goalAmount > 0) {
              data.linkData.progressPercentage = Math.min((totalCollectedUi / data.linkData.goalAmount) * 100, 100);
            } else {
              data.linkData.progressPercentage = 0;
            }
          }
          
          // Add formatted token amounts with UI amounts and USD values
          if (data.linkData.mint && data.linkData.amount) {
            const mint = data.linkData.mint;
            data.linkData.tokenAmount = {
              raw: data.linkData.chainAmount, // Raw amount in smallest unit
              ui: data.linkData.amount, // Human-readable amount
              usdValue: mint.priceUsd ? data.linkData.amount * mint.priceUsd : 0,
              token: {
                symbol: mint.symbol,
                name: mint.name,
                decimals: mint.decimals,
                imageUrl: mint.imageUrl,
                mintAddress: mint.mintAddress,
                priceUsd: mint.priceUsd || 0
              }
            };
          }

          // Add formatted goal amount with UI amounts and USD values
          if (data.linkData.goalAmount && data.linkData.mint) {
            const mint = data.linkData.mint;
            const goalChainAmount = BigInt(data.linkData.goalAmount * (10 ** mint.decimals)).toString();
            
            data.linkData.goalTokenAmount = {
              raw: goalChainAmount, // Raw goal amount in smallest unit
              ui: data.linkData.goalAmount, // Human-readable goal amount
              usdValue: mint.priceUsd ? data.linkData.goalAmount * mint.priceUsd : 0,
              token: {
                symbol: mint.symbol,
                name: mint.name,
                decimals: mint.decimals,
                imageUrl: mint.imageUrl,
                mintAddress: mint.mintAddress,
                priceUsd: mint.priceUsd || 0
              }
            };
          }
        }
      }

      // Only increment view count if throttle allows it (max once per 3 seconds)
      if (canIncrementViewCount(data.linkData.id)) {
        console.log('Incrementing view count for link', data.linkData.id);
        await prismaQuery.link.update({
          where: {
            id: data.linkData.id
          },
          data: {
            viewCount: { increment: 1 }
          }
        });
      } else {
        console.log('Skipping view count increment for link', data.linkData.id);
      }

      return reply.status(200).send(data);
    } catch (error) {
      return handleError(reply, 500, "Error getting chain-specific address", 'GET_CHAIN_ADDRESS_ERROR', error);
    }
  })

  // Rate limit link data requests with all chains - generous for public access
  app.get('/:username/:tag', {
    config: {
      rateLimit: {
        max: 60, // Allow up to 60 requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { username } = request.params;
      const tag = request.params.tag ?? "";

      const data = await getLinkData(username, tag);

      // Only increment view count if throttle allows it (max once per 3 seconds)
      if (canIncrementViewCount(data.linkId)) {
        console.log('Incrementing view count for link', data.linkId);
        await prismaQuery.link.update({
          where: {
            id: data.linkId
          },
          data: {
            viewCount: { increment: 1 }
          }
        });
      } else {
        console.log('Skipping view count increment for link', data.linkId);
      }

      // Remove linkId from response (internal use only)
      delete data.linkId;

      return reply.status(200).send(data);
    } catch (error) {
      if (error.message === "USER_NOT_FOUND") {
        return handleNotFoundError(reply, "User");
      }
      if (error.message === "LINK_NOT_FOUND") {
        return handleNotFoundError(reply, "Link");
      }
      return handleError(reply, 500, "Error getting address", 'GET_ADDRESS_ERROR', error);
    }
  })

  // Rate limit link data requests for username only - generous for public access
  app.get('/:username', {
    config: {
      rateLimit: {
        max: 60, // Allow up to 60 requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { username } = request.params;
      
      const data = await getLinkData(username, "");

      // Only increment view count if throttle allows it (max once per 3 seconds)
      if (canIncrementViewCount(data.linkId)) {
        console.log('Incrementing view count for link', data.linkId);
        await prismaQuery.link.update({
          where: {
            id: data.linkId
          },
          data: {
            viewCount: { increment: 1 }
          }
        });
      } else {
        console.log('Skipping view count increment for link', data.linkId);
      }

      // Remove linkId from response (internal use only)
      delete data.linkId;

      return reply.status(200).send(data);
    } catch (error) {
      if (error.message === "USER_NOT_FOUND") {
        return handleNotFoundError(reply, "User");
      }
      if (error.message === "LINK_NOT_FOUND") {
        return handleNotFoundError(reply, "Link");
      }
      return handleError(reply, 500, "Error getting address", 'GET_ADDRESS_ERROR', error);
    }
  })

  // Destination search endpoint
  app.get('/destination-search', {
    config: {
      rateLimit: {
        max: 30, // Allow up to 30 requests per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      let { q: query, chain= 'APTOS_TESTNET' } = request.query;

      // Validate required parameters
      if (!query || !chain) {
        return handleError(reply, 400, "Missing required parameters: q and chain", 'MISSING_PARAMETERS', null, {
          required: ['q', 'chain']
        });
      }

      // Extract username from pivy.me URLs
      // First decode the query in case it's URL encoded
      let decodedQuery = query;
      let isFromPivyUrl = false; // Flag to track if query came from pivy.me URL
      
      try {
        decodedQuery = decodeURIComponent(query);
      } catch (decodeError) {
        // If decoding fails, use original query
        decodedQuery = query;
      }

      if (decodedQuery.includes('pivy.me/')) {
        try {
          // Handle both http/https and without protocol
          let url = decodedQuery;
          if (!url.startsWith('http')) {
            url = 'https://' + url;
          }
          
          const urlObj = new URL(url);
          if (urlObj.hostname === 'pivy.me' && urlObj.pathname.length > 1) {
            // Extract the first path segment as username (remove leading slash)
            const pathSegments = urlObj.pathname.split('/').filter(segment => segment.length > 0);
            if (pathSegments.length > 0) {
              query = pathSegments[0]; // Take only the first segment (username)
              isFromPivyUrl = true; // Mark that this came from a pivy.me URL
            }
          }
        } catch (urlError) {
          // If URL parsing fails, try simple string extraction on decoded query
          const pivyMeIndex = decodedQuery.indexOf('pivy.me/');
          if (pivyMeIndex !== -1) {
            const afterPivyMe = decodedQuery.substring(pivyMeIndex + 'pivy.me/'.length);
            const firstSegment = afterPivyMe.split('/')[0];
            if (firstSegment) {
              query = firstSegment;
              isFromPivyUrl = true; // Mark that this came from a pivy.me URL
            }
          }
        }
      }

      // Convert query to lowercase for case-insensitive search
      query = query.toLowerCase();

      // Validate chain parameter
      const validChains = ['APTOS_MAINNET', 'APTOS_TESTNET'];
      if (!validChains.includes(chain)) {
        return handleError(reply, 400, "Invalid chain parameter", 'INVALID_CHAIN', null, {
          validChains: validChains
        });
      }

      const results = [];

      // Handle different chain types
      if (chain === 'APTOS_MAINNET' || chain === 'APTOS_TESTNET') {
        // 1. Search for exact matching Pivy username FIRST (highest priority)
        const shouldSearchUsername = query.length >= 1 && query.length <= 50;
        if (shouldSearchUsername) {
          try {
            const user = await prismaQuery.user.findUnique({
              where: {
                username: query
              },
              select: {
                id: true,
                username: true,
                profileImageType: true,
                profileImageData: true,
                wallets: {
                  where: {
                    chain: 'APTOS',
                    isActive: true
                  },
                  select: {
                    metaSpendPub: true
                  }
                }
              }
            });

            if (user && user.wallets.length > 0) {
              results.push({
                type: 'username',
                username: user.username,
                displayName: `@${user.username}`,
                displayType: 'USERNAME',
                profileImageType: user.profileImageType,
                profileImageData: user.profileImageData
              });
            }
          } catch (error) {
            console.log('User search error:', error.message);
          }
        }

        // If query came from pivy.me URL, only search for username and skip other searches
        if (isFromPivyUrl) {
          // Skip ANS and address searches when query is from pivy.me URL
        } else {
          // 2. Check for ANS domain search
          // ANS always queries mainnet regardless of chain parameter
          // ANS domains are stored without .apt suffix, so strip it if present
          const shouldSearchANS = query.length >= 3 && query.length <= 50;
          if (shouldSearchANS) {
            try {
              // Remove .apt suffix if present before searching
              const domainQuery = query.endsWith('.apt') ? query.slice(0, -4) : query;
              const ansResult = await searchANSByDomain(domainQuery, false); // Always use mainnet for ANS
              if (ansResult) {
                const fullName = ansResult.subdomain
                  ? `${ansResult.subdomain}.${ansResult.domain}.apt`
                  : `${ansResult.domain}.apt`;
                results.push({
                  type: 'ans',
                  name: fullName,
                  targetAddress: normalizeAptosAddress(ansResult.registered_address),
                  displayName: fullName,
                  displayType: 'ANS'
                });
              }
            } catch (error) {
              console.log('ANS search error:', error.message);
            }
          }

          // 3. Check if it's a valid Aptos address - lowest priority
          const shouldValidateAddress = query.length >= 3; // Aptos addresses can be short
          if (shouldValidateAddress) {
            const isValidAddress = validateAptosAddress(query);
            if (isValidAddress) {
              const normalizedAddress = normalizeAptosAddress(query);

              // First check if this address has an ANS name
              const addressANS = await getPrimaryANSForAddress(normalizedAddress, false);
              if (addressANS) {
                // If address has ANS, return the ANS result
                const fullName = addressANS.subdomain
                  ? `${addressANS.subdomain}.${addressANS.domain}.apt`
                  : `${addressANS.domain}.apt`;
                results.push({
                  type: 'ans',
                  name: fullName,
                  targetAddress: normalizedAddress,
                  displayName: fullName,
                  displayType: 'ANS'
                });
              } else {
                // If no ANS, return the address result
                results.push({
                  type: 'address',
                  address: normalizedAddress,
                  displayName: normalizedAddress,
                  displayType: 'ADDRESS'
                });
              }
            }
          }
        }
      }

      return reply.status(200).send({
        query: query,
        chain: chain,
        results: results,
        count: results.length
      });

    } catch (error) {
      return handleError(reply, 500, "Error performing destination search", 'DESTINATION_SEARCH_ERROR', error);
    }
  })

  done();
}