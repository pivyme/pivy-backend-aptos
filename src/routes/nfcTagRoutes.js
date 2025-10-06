import { prismaQuery } from '../lib/prisma.js';
import { authMiddleware } from '../middlewares/authMiddleware.js';
import { handleError } from '../utils/errorHandler.js';
import { getAlphanumericId } from '../utils/miscUtils.js';

// Admin middleware to check admin password
const adminMiddleware = async (request, reply) => {
  try {
    const adminPass = request.query.pass;

    if (!adminPass) {
      return handleError(reply, 401, 'Admin password required', 'ADMIN_PASS_MISSING');
    }

    if (!process.env.ADMIN_PASS) {
      return handleError(reply, 500, 'Admin password not configured', 'ADMIN_PASS_NOT_CONFIGURED');
    }

    if (adminPass !== process.env.ADMIN_PASS) {
      return handleError(reply, 401, 'Invalid admin password', 'ADMIN_PASS_INVALID');
    }

    return true;
  } catch (error) {
    return handleError(reply, 500, 'Internal server error', 'ADMIN_MIDDLEWARE_ERROR', error);
  }
};

// Generate a unique tag ID
const generateTagId = () => {
  return getAlphanumericId(16).toUpperCase();
};

// Create admin routes for NFC tag management
export const nfcTagRoutes = (app, _, done) => {
  // Admin route to create NFC tags
  app.post('/admin/create-tag', {
    preHandler: adminMiddleware
  }, async (request, reply) => {
    try {
      const baseUrl = 'https://pivy.me/tag';

      const tagId = generateTagId();
      const tagUrl = `${baseUrl}/${tagId}`;

      const tag = await prismaQuery.nFCTag.create({
        data: {
          tagId,
          tagUrl,
          status: 'AVAILABLE'
        }
      });

      reply.code(201).send({
        success: true,
        message: 'NFC tag created successfully',
        data: tag
      });

    } catch (error) {
      console.error('Error creating NFC tag:', error);
      return handleError(reply, 500, 'Failed to create NFC tag', 'CREATE_TAG_ERROR', error);
    }
  });

  // Admin route to get all NFC tags with filtering
  app.get('/admin/tags', {
    preHandler: adminMiddleware
  }, async (request, reply) => {
    try {
      const { status, userId, isInjected, limit = 1000, offset = 0 } = request.query;

      const where = {};
      if (status) where.status = status;
      if (userId) where.userId = userId;
      if (isInjected !== undefined) where.isInjected = isInjected === 'true';

      const tags = await prismaQuery.nFCTag.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              email: true
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: parseInt(limit),
        skip: parseInt(offset)
      });

      const total = await prismaQuery.nFCTag.count({ where });

      reply.send({
        success: true,
        data: tags,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      });

    } catch (error) {
      console.error('Error fetching NFC tags:', error);
      return handleError(reply, 500, 'Failed to fetch NFC tags', 'FETCH_TAGS_ERROR', error);
    }
  });

  // Admin route to delete an NFC tag
  app.post('/admin/:tagId/delete', {
    preHandler: adminMiddleware
  }, async (request, reply) => {
    try {
      const { tagId } = request.params;

      const tag = await prismaQuery.nFCTag.findUnique({
        where: { tagId }
      });

      if (!tag) {
        return handleError(reply, 404, 'NFC tag not found', 'TAG_NOT_FOUND');
      }

      await prismaQuery.nFCTag.delete({
        where: { tagId }
      });

      reply.send({
        success: true,
        message: 'NFC tag deleted successfully',
        data: { tagId }
      });

    } catch (error) {
      console.error('Error deleting NFC tag:', error);
      return handleError(reply, 500, 'Failed to delete NFC tag', 'DELETE_TAG_ERROR', error);
    }
  });

  // Admin route to mark an NFC tag as injected
  app.post('/admin/:tagId/inject', {
    preHandler: adminMiddleware
  }, async (request, reply) => {
    try {
      const { tagId } = request.params;
      const { isInjected = true } = request.body || {};

      const tag = await prismaQuery.nFCTag.findUnique({
        where: { tagId }
      });

      if (!tag) {
        return handleError(reply, 404, 'NFC tag not found', 'TAG_NOT_FOUND');
      }

      const updatedTag = await prismaQuery.nFCTag.update({
        where: { tagId },
        data: {
          isInjected: Boolean(isInjected)
        },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              email: true
            }
          }
        }
      });

      reply.send({
        success: true,
        message: `NFC tag ${isInjected ? 'marked as injected' : 'marked as not injected'}`,
        data: updatedTag
      });

    } catch (error) {
      console.error('Error updating NFC tag injection status:', error);
      return handleError(reply, 500, 'Failed to update NFC tag injection status', 'UPDATE_INJECTION_ERROR', error);
    }
  });

  // User route to claim an NFC tag
  app.post('/:tagId/claim', {
    preHandler: authMiddleware
  }, async (request, reply) => {
    try {
      const { tagId } = request.params;
      const userId = request.user.id;

      // Validate tagId length (minimum 20 characters)
      if (!tagId || tagId.length < 20) {
        return handleError(reply, 400, 'ERROR', 'INVALID_TAG_ID');
      }

      // Check if tag exists
      let tag = await prismaQuery.nFCTag.findUnique({
        where: { tagId }
      });

      // Auto-create tag if it doesn't exist (can be disabled via env var for security)
      if (!tag) {
        const autoCreateEnabled = process.env.NFC_AUTO_CREATE_ENABLED !== 'false'; // Default to true

        if (!autoCreateEnabled) {
          return handleError(reply, 404, 'NFC tag not found', 'TAG_NOT_FOUND');
        }

        const baseUrl = 'https://pivy.me/tag';
        const tagUrl = `${baseUrl}/${tagId}`;

        tag = await prismaQuery.nFCTag.create({
          data: {
            tagId,
            tagUrl,
            status: 'AVAILABLE',
            isInjected: true // Mark as injected since it's being used
          }
        });
      }

      if (tag.status !== 'AVAILABLE') {
        return handleError(reply, 409, 'NFC tag is not available for claiming', 'TAG_NOT_AVAILABLE');
      }

      // Check if user already has this tag claimed
      if (tag.userId === userId) {
        return handleError(reply, 409, 'You have already claimed this NFC tag', 'TAG_ALREADY_CLAIMED_BY_USER');
      }

      // Find any existing claimed tag for this user and unclaim it
      const existingUserTag = await prismaQuery.nFCTag.findFirst({
        where: {
          userId,
          status: 'CLAIMED'
        }
      });

      // Unclaim the existing tag for this user (set it back to AVAILABLE)
      if (existingUserTag) {
        await prismaQuery.nFCTag.update({
          where: { id: existingUserTag.id },
          data: {
            userId: null,
            status: 'AVAILABLE',
            claimedAt: null
          }
        });
      }

      // Claim the tag
      const claimedTag = await prismaQuery.nFCTag.update({
        where: { tagId },
        data: {
          userId,
          status: 'CLAIMED',
          claimedAt: new Date()
        },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              email: true
            }
          }
        }
      });

      reply.send({
        success: true,
        message: 'NFC tag claimed successfully',
        data: claimedTag
      });

    } catch (error) {
      console.error('Error claiming NFC tag:', error);
      return handleError(reply, 500, 'Failed to claim NFC tag', 'CLAIM_TAG_ERROR', error);
    }
  });

  // User route to get their claimed NFC tag
  app.get('/my-tag', {
    preHandler: authMiddleware
  }, async (request, reply) => {
    try {
      const userId = request.user.id;

      const tag = await prismaQuery.nFCTag.findFirst({
        where: {
          userId,
          status: 'CLAIMED'
        },
        orderBy: {
          claimedAt: 'desc'
        }
      });

      reply.send({
        success: true,
        data: tag
      });

    } catch (error) {
      console.error('Error fetching user NFC tag:', error);
      return handleError(reply, 500, 'Failed to fetch NFC tag', 'FETCH_USER_TAG_ERROR', error);
    }
  });

  // Public route to get NFC tag info by tagId (for when someone scans the NFC tag)
  app.get('/:tagId', async (request, reply) => {
    try {
      const { tagId } = request.params;

      // Validate tagId length (minimum 20 characters)
      if (!tagId || tagId.length < 20) {
        return handleError(reply, 400, 'Invalid tag ID - must be at least 20 characters', 'INVALID_TAG_ID');
      }

      let tag = await prismaQuery.nFCTag.findUnique({
        where: { tagId },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              email: true,
              profileImageType: true,
              profileImageData: true
            }
          }
        }
      });

      // Auto-create tag if it doesn't exist (can be disabled via env var for security)
      if (!tag) {
        const autoCreateEnabled = process.env.NFC_AUTO_CREATE_ENABLED !== 'false'; // Default to true

        if (!autoCreateEnabled) {
          return handleError(reply, 404, 'NFC tag not found', 'TAG_NOT_FOUND');
        }

        const baseUrl = 'https://pivy.me/tag';
        const tagUrl = `${baseUrl}/${tagId}`;

        tag = await prismaQuery.nFCTag.create({
          data: {
            tagId,
            tagUrl,
            status: 'AVAILABLE',
            isInjected: true // Mark as injected since it's being used
          },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
                profileImageType: true,
                profileImageData: true
              }
            }
          }
        });
      }

      // Increment viewed count
      await prismaQuery.nFCTag.update({
        where: { tagId },
        data: {
          viewedCount: {
            increment: 1
          }
        }
      });

      // If tag is disabled, don't show user info
      if (tag.status === 'DISABLED') {
        return reply.send({
          success: true,
          data: {
            tagId: tag.tagId,
            status: tag.status,
            viewedCount: tag.viewedCount + 1, // Include updated count
            createdAt: tag.createdAt
          }
        });
      }

      reply.send({
        success: true,
        data: {
          ...tag,
          viewedCount: tag.viewedCount + 1 // Include updated count
        }
      });

    } catch (error) {
      console.error('Error fetching NFC tag:', error);
      return handleError(reply, 500, 'Failed to fetch NFC tag', 'FETCH_TAG_ERROR', error);
    }
  });

  done();
};
