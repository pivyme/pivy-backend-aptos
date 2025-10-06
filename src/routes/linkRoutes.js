import { CHAINS } from "../config.js";
import { prismaQuery } from "../lib/prisma.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { handleError, handleNotFoundError } from "../utils/errorHandler.js";
import {
  getLinkWithChainConfig,
} from "../utils/linkUtils.js";
import { deleteLinkFiles } from '../lib/s3Service.js';
import { handleCreateLink, handleUpdateLink } from "../utils/linkCreator.js";

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const linkRoutes = (app, _, done) => {
  app.post('/create-link', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 5, // Allow up to 5 link creations per minute
        timeWindow: '1 minute'
      }
    }
  }, handleCreateLink);



  app.post('/update-link/:linkId', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 15, // Allow up to 15 link updates per minute
        timeWindow: '1 minute'
      }
    }
  }, handleUpdateLink);

  app.get('/:linkId', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 60, // Allow up to 60 requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { linkId } = request.params;
      const limit = parseInt(request.query.limit) || 100; // Default limit to 100 activities

      const link = await getLinkWithChainConfig(linkId);

      if (!link || link.userId !== request.user.id) {
        return handleNotFoundError(reply, 'Link');
      }

      // Organize files by type for easy access
      const organizedFiles = {
        thumbnail: link.files.find(f => f.type === 'THUMBNAIL') || null,
        deliverables: link.files.filter(f => f.type === 'DELIVERABLE') || []
      };

      // Get all chains that this link supports
      const supportedChains = link.chainConfigs?.map(config => {
        const chain = Object.values(CHAINS).find(c => c.id === config.chain);
        return chain;
      }).filter(Boolean).sort((a, b) => {
        // Prioritize APTOS chains
        if (a.id === 'APTOS_MAINNET' || a.id === 'APTOS_TESTNET') return -1;
        if (b.id === 'APTOS_MAINNET' || b.id === 'APTOS_TESTNET') return 1;
        return 0;
      }) || [];

      // Fetch activities (payments) for this specific link across all supported chains
      let linkActivities = [];
      
      if (supportedChains.length > 0) {
        const chainPromises = supportedChains.map(async (chain) => {
          try {
            // Get payments for this specific link on this chain
            const payments = await prismaQuery.payment.findMany({
              where: {
                linkId: linkId,
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
                    imageUrl: true,
                    isVerified: true
                  }
                },
                // Include link data (though we already have it)
                link: {
                  select: {
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
            });

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
                id: payment.linkId,
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

            return paymentActivities;
          } catch (error) {
            console.error(`Error fetching activities for link ${linkId} on chain ${chain.id}:`, error);
            // Return empty array if chain fails
            return [];
          }
        });

        // Execute all chain promises in parallel and flatten results
        const chainResults = await Promise.all(chainPromises);
        linkActivities = chainResults.flat();

        // Sort all activities by timestamp and apply limit
        linkActivities.sort((a, b) => b.timestamp - a.timestamp);
        linkActivities = linkActivities.slice(0, limit);
      }

      // Create link preview URL
      const linkPreview = link.tag === ""
        ? `/${link.user.username}`
        : `/${link.user.username}/${link.tag}`;

      return reply.status(200).send({
        ...link,
        linkPreview,
        files: organizedFiles,
        activities: linkActivities
      });

    } catch (error) {
      return handleError(reply, 500, 'Error getting link', 'GET_LINK_ERROR', error);
    }
  });

  app.get('/:linkId/activities', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 60, // Allow up to 60 requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { linkId } = request.params;
      const limit = parseInt(request.query.limit) || 20; // Default to 20 for infinite scroll
      const skip = parseInt(request.query.skip) || 0;
      const maxLimit = 100; // Prevent excessive data requests

      // Validate limit
      if (limit > maxLimit) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Limit cannot exceed ${maxLimit}`,
          data: null
        });
      }

      // First, verify the link exists and belongs to the user
      const link = await prismaQuery.link.findUnique({
        where: {
          id: linkId,
          status: 'ACTIVE'
        },
        include: {
          chainConfigs: {
            where: { isEnabled: true },
            select: { chain: true }
          }
        }
      });

      if (!link || link.userId !== request.user.id) {
        return handleNotFoundError(reply, 'Link');
      }

      // Get all chains that this link supports
      const supportedChains = link.chainConfigs?.map(config => {
        const chain = Object.values(CHAINS).find(c => c.id === config.chain);
        return chain;
      }).filter(Boolean).sort((a, b) => {
        // Prioritize APTOS chains
        if (a.id === 'APTOS_MAINNET' || a.id === 'APTOS_TESTNET') return -1;
        if (b.id === 'APTOS_MAINNET' || b.id === 'APTOS_TESTNET') return 1;
        return 0;
      }) || [];

      if (supportedChains.length === 0) {
        return reply.send({
          activities: [],
          pagination: {
            hasMore: false,
            totalCount: 0,
            currentPage: Math.floor(skip / limit) + 1,
            limit,
            skip
          }
        });
      }

      // Get total count for pagination metadata (across all chains)
      const totalCountPromises = supportedChains.map(chain =>
        prismaQuery.payment.count({
          where: {
            linkId: linkId,
            chain: chain.id
          }
        })
      );
      
      const chainCounts = await Promise.all(totalCountPromises);
      const totalCount = chainCounts.reduce((sum, count) => sum + count, 0);

      // Fetch activities with pagination
      const chainPromises = supportedChains.map(async (chain) => {
        try {
          // Get payments for this specific link on this chain
          const payments = await prismaQuery.payment.findMany({
            where: {
              linkId: linkId,
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
                  imageUrl: true,
                  isVerified: true
                }
              },
              // Include link data for consistency
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
              }
            },
            orderBy: {
              timestamp: 'desc'
            },
            // Fetch extra to ensure we have enough after global sorting
            take: Math.min((limit + skip) * 2, 500)
          });

          // Transform payment data for frontend consumption
          const paymentActivities = payments.map(payment => ({
            id: payment.txHash,
            type: 'PAYMENT',
            timestamp: payment.timestamp,
            amount: payment.amount.toString(),
            uiAmount: Number(payment.amount) / Math.pow(10, payment.mint.decimals),
            token: {
              symbol: payment.mint.symbol,
              name: payment.mint.name,
              decimals: payment.mint.decimals,
              imageUrl: payment.mint.imageUrl,
              mintAddress: payment.mint.mintAddress,
              priceUsd: payment.mint.priceUsd || 0,
              isVerified: payment.mint.isVerified
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
            isAnnounce: payment.announce,
            chain: payment.chain
          }));

          return paymentActivities;
        } catch (error) {
          console.error(`Error fetching activities for link ${linkId} on chain ${chain.id}:`, error);
          // Return empty array if chain fails
          return [];
        }
      });

      // Execute all chain promises in parallel and flatten results
      const chainResults = await Promise.all(chainPromises);
      let allActivities = chainResults.flat();

      // Sort all activities by timestamp globally
      allActivities.sort((a, b) => b.timestamp - a.timestamp);

      // Apply pagination after global sorting
      const paginatedActivities = allActivities.slice(skip, skip + limit);
      const hasMore = (skip + limit) < totalCount;

      return reply.send({
        activities: paginatedActivities,
        pagination: {
          hasMore,
          totalCount,
          currentPage: Math.floor(skip / limit) + 1,
          limit,
          skip,
          nextSkip: hasMore ? skip + limit : null
        },
        meta: {
          chainsProcessed: supportedChains.length,
          linkId: linkId,
          fetchedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error('Error fetching link activities:', error);
      return handleError(reply, 500, 'Error fetching link activities', 'GET_LINK_ACTIVITIES_ERROR', error);
    }
  });

  app.get('/my-links', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 120, // Allow up to 60 requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { type, status } = request.query;
      
      // Build where clause based on query parameters
      let whereClause = {
        userId: request.user.id,
        // status: 'ACTIVE',
      };
      
      if (status) {
        whereClause.status = status.toUpperCase();
      }

      // If type=personal, only return the personal link
      if (type === 'personal') {
        whereClause.tag = "";
        whereClause.label = "personal";
      }

      const links = await prismaQuery.link.findMany({
        where: whereClause,
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
              size: true,
              contentType: true
            }
          },
          user: {
            select: {
              username: true
            }
          },
          payments: {
            include: {
              mint: true
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        }
      });

      const linkObjects = links.map(link => {
        let linkPreview = link.tag === ""
          ? `/${link.user.username}`
          : `/${link.user.username}/${link.tag}`;

        const isPersonalLink = link.tag === "" && link.label === "personal"

        // Process payments to create merged stats
        const paymentStats = {};
        let totalPaymentsCount = 0;

        link.payments.forEach(payment => {
          totalPaymentsCount++;
          const mintAddress = payment.mint.mintAddress;

          if (!paymentStats[mintAddress]) {
            paymentStats[mintAddress] = {
              token: {
                id: payment.mint.id,
                mintAddress: payment.mint.mintAddress,
                name: payment.mint.name,
                symbol: payment.mint.symbol,
                decimals: payment.mint.decimals,
                imageUrl: payment.mint.imageUrl,
                description: payment.mint.description,
                priceUsd: payment.mint.priceUsd,
                isVerified: payment.mint.isVerified
              },
              amount: BigInt(0),
              count: 0
            };
          }

          paymentStats[mintAddress].amount += BigInt(payment.amount);
          paymentStats[mintAddress].count++;
        });

        // Convert to array and format amounts
        const mergedPaymentStats = Object.values(paymentStats).map(stat => ({
          token: stat.token,
          amount: stat.amount.toString(),
          // Convert to human readable amount
          humanReadableAmount: Number(stat.amount) / (10 ** stat.token.decimals),
          count: stat.count
        }));

        // Get chain configs with amounts
        const chainConfigsWithAmounts = link.chainConfigs.map(config => ({
          chain: config.chain,
          amount: config.amount,
          isEnabled: config.isEnabled,
          mint: config.mint ? {
            id: config.mint.id,
            mintAddress: config.mint.mintAddress,
            name: config.mint.name,
            symbol: config.mint.symbol,
            decimals: config.mint.decimals,
            imageUrl: config.mint.imageUrl,
            description: config.mint.description,
            priceUsd: config.mint.priceUsd,
            isVerified: config.mint.isVerified
          } : null,
          chainAmount: config.amount && config.mint ?
            BigInt(config.amount * (10 ** config.mint.decimals)).toString() :
            null
        })).sort((a, b) => {
          // Prioritize APTOS chains
          if (a.chain === 'APTOS_MAINNET' || a.chain === 'APTOS_TESTNET') return -1;
          if (b.chain === 'APTOS_MAINNET' || b.chain === 'APTOS_TESTNET') return 1;
          return 0;
        });

        return {
          ...link,
          linkPreview,
          isPersonalLink,
          chainConfigs: chainConfigsWithAmounts,
          stats: {
            viewCount: link.viewCount,
            totalPayments: totalPaymentsCount,
            paymentStats: mergedPaymentStats
          },
          // Remove payments from the response to keep it clean
          payments: undefined
        };
      });

      // If type=personal, return the personal link as a single object
      if (type === 'personal') {
        return reply.status(200).send(linkObjects[0] || null);
      }

      // Make the personal link the first item in the array
      const personalLink = linkObjects.find(link => link.isPersonalLink);
      if (personalLink) {
        const idx = linkObjects.indexOf(personalLink);
        if (idx > 0) {
          linkObjects.splice(idx, 1);
          linkObjects.unshift(personalLink);
        }
      }

      return reply.status(200).send(linkObjects);
    } catch (error) {
      console.error('Error fetching links:', error);
      return reply.status(500).send({
        message: "Error fetching links",
        error: error.message,
        data: null
      });
    }
  });

    // File endpoints moved to fileRoutes.js for better organization

  app.post('/archive-link/:linkId', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 10, // Allow up to 10 archive operations per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { linkId } = request.params;

      // First check if the link exists and belongs to the user
      const existingLink = await prismaQuery.link.findUnique({
        where: {
          id: linkId,
        },
        select: {
          id: true,
          userId: true,
          tag: true,
          label: true,
          status: true
        }
      });

      if (!existingLink) {
        return handleNotFoundError(reply, 'Link');
      }

      if (existingLink.userId !== request.user.id) {
        return reply.status(403).send({
          message: "Unauthorized",
          error: "You don't have permission to archive this link",
          data: null
        });
      }

      // Check if it's a personal link (which cannot be archived)
      const isPersonalLink = existingLink.tag === "" && existingLink.label === "personal";
      if (isPersonalLink) {
        return reply.status(403).send({
          message: "Cannot archive personal link",
          error: "Personal links cannot be archived",
          data: null
        });
      }

      if (existingLink.status === 'ARCHIVED') {
        return reply.status(400).send({
          message: "Link already archived",
          error: "This link has already been archived",
          data: null
        });
      }

      // Archive the link by setting status to ARCHIVED
      const archivedLink = await prismaQuery.link.update({
        where: { id: linkId },
        data: {
          status: 'ARCHIVED',
          archivedAt: new Date()
        }
      });

      return reply.status(200).send({
        message: "Link archived successfully",
        data: archivedLink
      });
    } catch (error) {
      console.error('Error archiving link:', error);
      return handleError(reply, 500, 'Error archiving link', 'ARCHIVE_LINK_ERROR', error);
    }
  });

  app.post('/unarchive-link/:linkId', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 10, // Allow up to 10 unarchive operations per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { linkId } = request.params;

      // First check if the link exists and belongs to the user
      const existingLink = await prismaQuery.link.findUnique({
        where: {
          id: linkId,
        },
        select: {
          id: true,
          userId: true,
          tag: true,
          label: true,
          status: true
        }
      });

      if (!existingLink) {
        return handleNotFoundError(reply, 'Link');
      }

      if (existingLink.userId !== request.user.id) {
        return reply.status(403).send({
          message: "Unauthorized",
          error: "You don't have permission to unarchive this link",
          data: null
        });
      }

      // Check if it's a personal link (which cannot be unarchived)
      const isPersonalLink = existingLink.tag === "" && existingLink.label === "personal";
      if (isPersonalLink) {
        return reply.status(403).send({
          message: "Cannot unarchive personal link",
          error: "Personal links cannot be unarchived",
          data: null
        });
      }

      if (existingLink.status !== 'ARCHIVED') {
        return reply.status(400).send({
          message: "Link not archived",
          error: "Only archived links can be unarchived",
          data: null
        });
      }

      // Check for tag conflicts - ensure no active link with the same tag exists for this user
      if (existingLink.tag) {
        const conflictingLink = await prismaQuery.link.findFirst({
          where: {
            userId: request.user.id,
            tag: existingLink.tag,
            status: 'ACTIVE',
            id: { not: linkId } // Exclude the current link being unarchived
          },
          select: {
            id: true,
            label: true
          }
        });

        if (conflictingLink) {
          return reply.status(409).send({
            message: "Tag conflict",
            error: `Another active link with tag '${existingLink.tag}' already exists. Please change the tag before unarchiving.`,
            data: {
              conflictingLink: {
                id: conflictingLink.id,
                label: conflictingLink.label
              }
            },
            success: false
          });
        }
      }

      // Unarchive the link by setting status back to ACTIVE and clearing archivedAt
      const unarchivedLink = await prismaQuery.link.update({
        where: { id: linkId },
        data: {
          status: 'ACTIVE',
          archivedAt: null
        }
      });

      return reply.status(200).send({
        message: "Link unarchived successfully",
        data: unarchivedLink,
        success: true
      });
    } catch (error) {
      console.error('Error unarchiving link:', error);
      return handleError(reply, 500, 'Error unarchiving link', 'UNARCHIVE_LINK_ERROR', error);
    }
  });

  app.post('/delete-link/:linkId', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 10, // Allow up to 5 delete operations per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { linkId } = request.params;

      // First check if the link exists and belongs to the user
      const existingLink = await prismaQuery.link.findUnique({
        where: {
          id: linkId
        },
        select: {
          id: true,
          userId: true,
          tag: true,
          label: true,
          status: true
        }
      });

      if (!existingLink) {
        return reply.status(404).send({
          message: "Link not found",
          error: "The specified link does not exist or has been deleted",
          data: null,
          success: false
        });
      }

      // Check if it's a personal link (which cannot be deleted)
      const isPersonalLink = existingLink.tag === "" && existingLink.label === "personal";
      if (isPersonalLink) {
        return reply.status(403).send({
          message: "Cannot delete personal link",
          error: "Personal links cannot be deleted",
          data: null,
          success: false
        });
      }

      if (existingLink.userId !== request.user.id) {
        return reply.status(403).send({
          message: "Unauthorized",
          error: "You don't have permission to delete this link",
          data: null,
          success: false
        });
      }

      // Delete S3 files and File records
      try {
        await deleteLinkFiles(linkId);
      } catch (deleteError) {
        console.error('Error deleting files during link deletion:', deleteError);
        // Don't fail the entire operation if file deletion fails
      }

      // Hard delete the link from the database
      await prismaQuery.link.delete({
        where: { id: linkId }
      });

      return reply.status(200).send({
        message: "Link deleted successfully",
        data: null,
        success: true
      });
    } catch (error) {
      console.error('Error deleting link:', error);
      return reply.status(500).send({
        message: "Error deleting link",
        error: error.message,
        data: null,
        success: false
      });
    }
  });

  done();
}