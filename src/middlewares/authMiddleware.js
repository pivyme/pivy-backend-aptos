import jwt from 'jsonwebtoken';
import { prismaQuery } from '../lib/prisma.js';
import { handleError } from '../utils/errorHandler.js';

export const authMiddleware = async (request, reply) => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return handleError(reply, 401, 'Missing authorization header', 'AUTH_HEADER_MISSING');
    }

    if (!authHeader.startsWith('Bearer ')) {
      return handleError(reply, 401, 'Invalid authorization format', 'AUTH_FORMAT_INVALID');
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return handleError(reply, 401, 'Missing token', 'TOKEN_MISSING');
    }

    if (!process.env.JWT_SECRET) {
      return handleError(reply, 500, 'JWT secret not configured', 'JWT_SECRET_MISSING');
    }

    try {
      const authData = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ['HS256'],
        complete: false,
        clockTimestamp: Math.floor(Date.now() / 1000),
        ignoreExpiration: false,
        ignoreNotBefore: false
      });

      if (!authData.id) {
        return handleError(reply, 401, 'Invalid token payload', 'TOKEN_PAYLOAD_INVALID');
      }
      
      const user = await prismaQuery.user.findUnique({
        where: {
          id: authData.id
        },
        include: {
          wallets: true,
          links: true
        }
      });
      
      if (!user) {
        return reply.code(401).send({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found'
          },
        });
      }

      // Find the specific wallet from the JWT token
      const currentWallet = user.wallets.find(w => w.id === authData.walletId);
      if (!currentWallet) {
        return handleError(reply, 401, 'Wallet not found', 'WALLET_NOT_FOUND');
      }

      request.user = user;
      request.currentWallet = currentWallet;
      return true;
    } catch (jwtError) {
      let errorCode = 'TOKEN_INVALID';
      let errorMessage = 'Invalid or expired token';
      
      if (jwtError.name === 'TokenExpiredError') {
        errorCode = 'TOKEN_EXPIRED';
        errorMessage = 'Token has expired';
      } else if (jwtError.name === 'JsonWebTokenError') {
        errorCode = 'TOKEN_MALFORMED';
        errorMessage = 'Token is malformed';
      } else if (jwtError.name === 'NotBeforeError') {
        errorCode = 'TOKEN_NOT_ACTIVE';
        errorMessage = 'Token is not active yet';
      }
      
      return handleError(reply, 401, errorMessage, errorCode, jwtError);
    }
    
  } catch (error) {
    return handleError(reply, 500, 'Internal server error', 'AUTH_INTERNAL_ERROR', error);
  }
}