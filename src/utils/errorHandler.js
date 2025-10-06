import { prismaQuery } from '../lib/prisma.js';

export const handleError = async (reply, statusCode, message, errorCode, originalError = null, context = null) => {
  try {
    const request = reply.request;
    const userId = request.user?.id || null;
    
    // Extract request information
    const requestInfo = {
      method: request.method,
      path: request.url,
      userAgent: request.headers['user-agent'] || null,
      ip: request.ip || request.headers['x-forwarded-for'] || request.socket.remoteAddress || null,
    };

    // Prepare error log data
    const errorLogData = {
      errorCode,
      message,
      statusCode,
      stack: originalError?.stack || null,
      context: context ? JSON.stringify(context) : null,
      userId,
      ...requestInfo
    };

    // Log to database (non-blocking)
    prismaQuery.errorLog.create({
      data: errorLogData
    }).catch(dbError => {
      console.error('Failed to log error to database:', dbError);
    });

    // Log to console for development
    console.error(`[${errorCode}] ${message}`, {
      statusCode,
      userId,
      path: requestInfo.path,
      method: requestInfo.method,
      originalError: originalError?.message,
      stack: originalError?.stack
    });

    // Send standardized error response
    return reply.code(statusCode).send({
      success: false,
      error: {
        code: errorCode,
        message,
        ...(process.env.NODE_ENV === 'development' && originalError && {
          details: originalError.message,
          stack: originalError.stack
        })
      },
      data: null,
      timestamp: new Date().toISOString()
    });
  } catch (handlerError) {
    console.error('Error in error handler:', handlerError);
    
    // Fallback response if error handler fails
    return reply.code(statusCode).send({
      success: false,
      error: {
        code: errorCode,
        message
      },
      data: null
    });
  }
};

export const handleValidationError = (reply, missingFields) => {
  return handleError(
    reply,
    400,
    `Missing required fields: ${missingFields.join(', ')}`,
    'VALIDATION_ERROR',
    null,
    { missingFields }
  );
};

export const handleNotFoundError = (reply, resource) => {
  return handleError(
    reply,
    404,
    `${resource} not found`,
    'NOT_FOUND',
    null,
    { resource }
  );
};

export const handleUnauthorizedError = (reply, reason = 'Unauthorized') => {
  return handleError(
    reply,
    401,
    reason,
    'UNAUTHORIZED'
  );
};

export const handleForbiddenError = (reply, reason = 'Forbidden') => {
  return handleError(
    reply,
    403,
    reason,
    'FORBIDDEN'
  );
};

export const handleDatabaseError = (reply, operation, originalError) => {
  return handleError(
    reply,
    500,
    `Database error during ${operation}`,
    'DATABASE_ERROR',
    originalError,
    { operation }
  );
};