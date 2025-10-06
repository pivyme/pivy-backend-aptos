import { prismaQuery } from "../lib/prisma.js";
import { handleError } from "../utils/errorHandler.js";
import { validateRequiredFields } from "../utils/validationUtils.js";
import { getAlphanumericId } from "../utils/miscUtils.js";
import { turnstilePay } from "../middlewares/turnstileMiddleware.js";

/**
 * Validates payment info data structure and types
 * @param {Array} paymentData - Array of payment info objects
 * @returns {Object} - { isValid: boolean, errors: string[] }
 */
export const validatePaymentInfoData = (paymentData) => {
  const errors = [];
  const allowedTypes = ['email', 'name', 'telegram', 'note'];

  if (!Array.isArray(paymentData)) {
    errors.push('Payment data must be an array');
    return { isValid: false, errors };
  }

  if (paymentData.length === 0) {
    errors.push('At least one payment info item is required');
    return { isValid: false, errors };
  }

  paymentData.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push(`Item at index ${index} must be an object`);
      return;
    }

    if (!item.type || typeof item.type !== 'string') {
      errors.push(`Item at index ${index} must have a valid type`);
      return;
    }

    if (!allowedTypes.includes(item.type)) {
      errors.push(`Item at index ${index} has invalid type "${item.type}". Allowed types: ${allowedTypes.join(', ')}`);
      return;
    }

    if (!item.value || typeof item.value !== 'string' || item.value.trim() === '') {
      errors.push(`Item at index ${index} must have a non-empty value`);
      return;
    }

    // Type-specific validations with appropriate length limits
    if (item.type === 'email') {
      if (item.value.length > 100) {
        errors.push(`Email at index ${index} exceeds maximum length of 100 characters`);
      } else {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(item.value)) {
          errors.push(`Item at index ${index} has invalid email format`);
        }
      }
    }

    if (item.type === 'name') {
      if (item.value.length > 80) {
        errors.push(`Name at index ${index} exceeds maximum length of 80 characters`);
      }
      if (item.value.length < 2) {
        errors.push(`Name at index ${index} must be at least 2 characters long`);
      }
    }

    if (item.type === 'telegram_username') {
      if (item.value.length > 100) {
        errors.push(`Telegram username at index ${index} exceeds maximum length of 100 characters`);
      } else {
        const telegramRegex = /^@?[a-zA-Z0-9_]{5,32}$/;
        if (!telegramRegex.test(item.value)) {
          errors.push(`Telegram username at index ${index} has invalid format (5-32 characters, alphanumeric and underscore only, optional @ prefix)`);
        }
      }
    }

    if (item.type === 'message') {
      if (item.value.length > 300) {
        errors.push(`Message at index ${index} exceeds maximum length of 300 characters`);
      }
      if (item.value.length < 1) {
        errors.push(`Message at index ${index} cannot be empty`);
      }
    }
  });

  // Check for duplicate types
  const types = paymentData.map(item => item.type);
  const uniqueTypes = new Set(types);
  if (types.length !== uniqueTypes.size) {
    errors.push('Duplicate types are not allowed');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
};

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const payRoutes = (app, _, done) => {
  app.post('/payment-info', {
    preHandler: turnstilePay,
    config: {
      rateLimit: {
        max: 20, // Allow up to 20 payment preparations per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { paymentData } = request.body;

      // Validate required fields
      const validationResult = await validateRequiredFields(request.body, ['paymentData'], reply);
      if (validationResult !== true) {
        // validateRequiredFields already sent the error response
        return;
      }

      // Validate the payment data structure and types
      const dataValidation = validatePaymentInfoData(paymentData);
      if (!dataValidation.isValid) {
        return reply.status(400).send({
          success: false,
          message: 'Payment data validation failed',
          errors: dataValidation.errors,
          data: null
        });
      }

      // Generate a custom 16-character alphanumeric ID
      const paymentInfoId = getAlphanumericId(16);

      // Extract request metadata for tracking/spam prevention
      const ipAddress = request.ip || request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || 'unknown';
      const userAgent = request.headers['user-agent'] || null;

      // Save the payment information with tracking data
      const paymentInfo = await prismaQuery.paymentInfo.create({
        data: {
          id: paymentInfoId,
          collectedData: paymentData,
          ipAddress: Array.isArray(ipAddress) ? ipAddress[0] : ipAddress,
          userAgent: userAgent?.substring(0, 500) || null // Limit user agent length
        }
      });

      return reply.status(201).send({
        success: true,
        message: 'Payment information prepared successfully',
        data: {
          paymentInfoId: paymentInfo.id,
          collectedFields: paymentData.map(item => item.type),
          createdAt: paymentInfo.createdAt
        }
      });

    } catch (error) {
      console.error('Error in prepare-payment:', error);
      return handleError(reply, 500, 'Error preparing payment', 'PREPARE_PAYMENT_ERROR', error);
    }
  });

  app.get('/payment-info', {
    config: {
      rateLimit: {
        max: 30, // Allow up to 30 requests per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { limit = 50, offset = 0 } = request.query;

      // Get only valid payment info (ones that have been linked to payments)
      const paymentInfos = await prismaQuery.paymentInfo.findMany({
        where: {
          paymentId: { not: null } // Only get payment info that has been linked to a payment
        },
        select: {
          id: true,
          collectedData: true,
          ipAddress: true,
          userAgent: true,
          paymentId: true,
          createdAt: true,
          updatedAt: true,
          payment: {
            select: {
              txHash: true,
              timestamp: true,
              amount: true,
              chain: true,
              mint: {
                select: {
                  name: true,
                  symbol: true,
                  decimals: true
                }
              }
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: parseInt(limit),
        skip: parseInt(offset)
      });

      // Get total count for pagination
      const totalCount = await prismaQuery.paymentInfo.count({
        where: {
          paymentId: { not: null }
        }
      });

      return reply.status(200).send({
        success: true,
        message: 'Payment information retrieved successfully',
        data: {
          paymentInfos,
          pagination: {
            total: totalCount,
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: parseInt(offset) + parseInt(limit) < totalCount
          }
        }
      });

    } catch (error) {
      console.error('Error getting payment info:', error);
      return handleError(reply, 500, 'Error retrieving payment information', 'GET_PAYMENT_INFO_ERROR', error);
    }
  });

  done();
};
