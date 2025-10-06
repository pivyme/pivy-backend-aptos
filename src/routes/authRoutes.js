import jwt from "jsonwebtoken";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { handleError } from "../utils/errorHandler.js";
import { findOrCreateUserWithWallet } from "../utils/authUtils.js";
import { validateRequiredFields } from "../utils/validationUtils.js";
import createTurnstileMiddleware from "../middlewares/turnstileMiddleware.js";
import { prismaQuery } from "../lib/prisma.js";

// Aptos imports (currently not used but kept for future expansion)

// SIWA (Sign in with Aptos) imports
import {
  deserializeSignInOutput,
  verifySignInSignature,
  generateNonce,
} from "@aptos-labs/siwa";

// In-memory nonce store with expiration (5 minutes)
const nonceStore = new Map();
const NONCE_EXPIRY = 5 * 60 * 1000; // 5 minutes


/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const authRoutes = (app, _, done) => {

  // Clean up expired nonces every minute
  setInterval(() => {
    const now = Date.now();
    for (const [nonce, timestamp] of nonceStore.entries()) {
      if (now - timestamp > NONCE_EXPIRY) {
        nonceStore.delete(nonce);
      }
    }
  }, 60 * 1000);

  // SIWA: Get sign-in input for authentication
  app.get('/siwa/nonce', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute'
      }
    }
  }, async (req, res) => {
    try {
      const nonce = generateNonce();

      const input = {
        nonce,
        domain: process.env.SIWA_DOMAIN || "pivy.app",
        statement: "Sign in to PIVY to access your stealth payment toolkit",
        uri: process.env.SIWA_URI || "https://pivy.app",
        version: "1",
        chainId: process.env.APTOS_NETWORK === 'mainnet' ? 1 : 2, // 1 = mainnet, 2 = testnet
      };

      // Store nonce with timestamp (for expiration check)
      nonceStore.set(nonce, Date.now());

      return res.status(200).send({ data: input });
    } catch (error) {
      return handleError(res, 500, 'Error generating SIWA input', 'SIWA_NONCE_ERROR', error);
    }
  });

  // SIWA: Verify and authenticate with signature
  app.post('/siwa/callback', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute'
      }
    },
    preHandler: createTurnstileMiddleware('login', 10)
  }, async (req, res) => {
    try {
      const { output } = req.body;

      const callbackValidation = await validateRequiredFields(req.body, ['output'], res);
      if (callbackValidation !== true) return;

      console.log("output", output);
      // Handle both serialized string and already parsed object
      let signInOutput = deserializeSignInOutput(output);
      console.log('Processed SIWA output:', signInOutput);

      // Verify the signature
      const signatureVerification = await verifySignInSignature(signInOutput);
      console.log("signatureVerification", signatureVerification);

      if (!signatureVerification.valid) {
        return handleError(
          res,
          401,
          `Signature verification failed: ${signatureVerification.errors.join(", ")}`,
          'SIWA_SIGNATURE_INVALID'
        );
      }
      // Extract wallet address from sign-in output
      const walletAddress = signInOutput.input.address || signInOutput.address;

      if (!walletAddress) {
        return handleError(res, 400, 'Could not extract wallet address from sign-in output', 'INVALID_ADDRESS');
      }

      console.log('Extracted wallet address:', walletAddress);

      // Extract email from request body if provided (for Aptos Connect)
      const email = req.body.email;

      // Authentication successful - find or create user
      const { user, wallet } = await findOrCreateUserWithWallet({
        walletAddress,
        chain: 'APTOS',
        loginMethod: 'WALLET',
        email
      });

      // TODO: Add airdrop test tokens for Aptos testnet when needed
      // if (wallet && wallet.createdAt === wallet.updatedAt) {
      //   await handleAirdropTestAptosTokens(deserializedOutput.address);
      // }

      // Create JWT token
      const token = jwt.sign({
        id: user.id,
        username: user.username,
        email: user.email,
        privyUserId: user.privyUserId,
        walletId: wallet.id,
        walletAddress: wallet.walletAddress,
        chain: wallet.chain,
        loginMethod: wallet.loginMethod
      }, process.env.JWT_SECRET, {
        expiresIn: '30d'
      });

      return res.status(200).send({
        token,
        wallet: {
          id: wallet.id,
          chain: wallet.chain,
          address: wallet.walletAddress,
          privyWalletId: wallet.privyWalletId,
          loginMethod: wallet.loginMethod
        }
      });
    } catch (error) {
      return handleError(res, 500, 'Internal server error during SIWA authentication', 'SIWA_CALLBACK_ERROR', error);
    }
  });



  app.post('/register-meta-keys', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 10, // Allow up to 5 meta key registrations per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { metaKeys } = request.body;

      // Validate required fields
      const validation = await validateRequiredFields(request.body, ['metaKeys'], reply);
      if (validation !== true) return;

      // Validate metaKeys array structure
      if (!Array.isArray(metaKeys) || metaKeys.length === 0) {
        return handleError(reply, 400, "metaKeys must be a non-empty array", 'INVALID_META_KEYS_FORMAT');
      }

      // Validate each meta key entry
      for (const metaKey of metaKeys) {
        const metaKeyValidation = await validateRequiredFields(metaKey, ['chain', 'address', 'metaSpendPriv', 'metaSpendPub', 'metaViewPub', 'metaViewPriv'], reply);
        if (metaKeyValidation !== true) return;

        // Validate chain value
        if (!['APTOS'].includes(metaKey.chain)) {
          return handleError(reply, 400, "Invalid chain. Must be APTOS", 'INVALID_CHAIN');
        }
      }

      // Get all user's wallets
      const userWallets = await prismaQuery.userWallet.findMany({
        where: {
          userId: request.user.id,
          isActive: true
        }
      });

      const updatedWallets = [];
      const notFoundWallets = [];

      // Process each meta key entry
      for (const metaKey of metaKeys) {
        const { chain, address, metaSpendPriv, metaSpendPub, metaViewPub, metaViewPriv } = metaKey;

        // Find the corresponding wallet
        const targetWallet = userWallets.find(w =>
          w.chain === chain &&
          w.walletAddress.toLowerCase() === address.toLowerCase()
        );

        if (!targetWallet) {
          notFoundWallets.push({
            chain,
            address,
            error: `No ${chain} wallet found with address ${address}`
          });
          continue;
        }

        // Update the wallet with meta keys
        const updatedWallet = await prismaQuery.userWallet.update({
          where: {
            id: targetWallet.id
          },
          data: {
            metaSpendPriv,
            metaSpendPub,
            metaViewPub,
            metaViewPriv
          }
        });

        updatedWallets.push({
          id: updatedWallet.id,
          walletAddress: updatedWallet.walletAddress,
          chain: updatedWallet.chain,
          loginMethod: updatedWallet.loginMethod,
          metaSpendPub: updatedWallet.metaSpendPub,
          metaViewPub: updatedWallet.metaViewPub,
          hasMetaKeys: !!(updatedWallet.metaSpendPriv && updatedWallet.metaSpendPub && updatedWallet.metaViewPub && updatedWallet.metaViewPriv)
        });
      }

      // Return results
      const response = {
        message: `Meta keys registered for ${updatedWallets.length} wallet(s)`,
        updatedWallets,
        totalProcessed: metaKeys.length,
        successCount: updatedWallets.length,
        errorCount: notFoundWallets.length
      };

      if (notFoundWallets.length > 0) {
        response.errors = notFoundWallets;
      }


      // If some wallets were not found, return partial success status
      const statusCode = notFoundWallets.length > 0 ? 207 : 200; // 207 = Multi-Status

      return reply.status(statusCode).send(response);
    } catch (error) {
      return handleError(reply, 500, "Error registering meta keys", 'REGISTER_META_KEYS_ERROR', error);
    }
  })


  app.get('/me', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 120, // Allow up to 60 requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const user = await prismaQuery.user.findUnique({
        where: {
          id: request.user.id
        },
        include: {
          wallets: {
            orderBy: [
              { createdAt: 'asc' }
            ]
          },
          nfcTag: true
        }
      });

      // Enhanced wallet information with meta keys
      const walletsWithMetaKeys = user.wallets.map(wallet => ({
        id: wallet.id,
        walletAddress: wallet.walletAddress,
        chain: wallet.chain,
        loginMethod: wallet.loginMethod,
        privyWalletId: wallet.privyWalletId,
        isPrimary: wallet.isPrimary,
        isActive: wallet.isActive,
        hasMetaKeys: !!(wallet.metaSpendPriv && wallet.metaSpendPub && wallet.metaViewPub && wallet.metaViewPriv),
        metaKeys: {
          metaSpendPub: wallet.metaSpendPub,
          metaViewPub: wallet.metaViewPub,
          // metaSpendPriv and metaViewPriv excluded for security
        },
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt
      }));

      return reply.status(200).send({
        id: user.id,
        username: user.username,
        email: user.email,
        privyUserId: user.privyUserId,
        profileImage: user.profileImageType ? {
          type: user.profileImageType,
          data: user.profileImageData
        } : null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        wallets: walletsWithMetaKeys,
        nfcTag: user.nfcTag
      });
    } catch (error) {
      return handleError(reply, 500, "Error getting user", 'GET_USER_ERROR', error);
    }
  })

  app.post('/set-profile-image', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 10, // Allow up to 10 profile updates per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { type, data } = request.body;

      // Validate required fields
      const validation = await validateRequiredFields(request.body, ['type', 'data'], reply);
      if (validation !== true) return;

      // Validate type
      if (type !== 'EMOJI_AND_COLOR') {
        return handleError(reply, 400, "Invalid profile image type. Currently only 'EMOJI_AND_COLOR' is supported", 'INVALID_PROFILE_IMAGE_TYPE');
      }

      // Validate data structure for EMOJI_AND_COLOR type
      if (type === 'EMOJI_AND_COLOR') {
        const emojiValidation = await validateRequiredFields(data, ['emoji', 'backgroundColor'], reply);
        if (emojiValidation !== true) return;

        // Basic validation for emoji (should be a string name like 'link')
        if (!data.emoji || typeof data.emoji !== 'string' || data.emoji.trim().length === 0) {
          return handleError(reply, 400, "Invalid emoji. Must be a non-empty string", 'INVALID_EMOJI');
        }

        // Basic validation for backgroundColor (should be a color name like 'grey')
        if (!data.backgroundColor || typeof data.backgroundColor !== 'string' || data.backgroundColor.trim().length === 0) {
          return handleError(reply, 400, "Invalid backgroundColor. Must be a non-empty color name string", 'INVALID_BACKGROUND_COLOR');
        }
      }

      // Update user's profile image
      const updatedUser = await prismaQuery.user.update({
        where: {
          id: request.user.id
        },
        data: {
          profileImageType: type, // Use type directly since it's already in enum format
          profileImageData: data
        }
      });

      // Sync personal link emoji and backgroundColor with profile image data
      if (type === 'EMOJI_AND_COLOR' && data.emoji && data.backgroundColor) {
        try {
          // Find the user's personal link (empty tag, label: 'personal')
          let personalLink = await prismaQuery.link.findFirst({
            where: {
              userId: request.user.id,
              tag: "",
              label: "personal",
              status: "ACTIVE"
            }
          });

          // Update existing personal link if it exists
          if (personalLink) {
            await prismaQuery.link.update({
              where: {
                id: personalLink.id
              },
              data: {
                emoji: data.emoji,
                backgroundColor: data.backgroundColor
              }
            });
          }
        } catch (personalLinkError) {
          // Log error but don't fail the main request
          console.error('Error syncing personal link with profile image:', personalLinkError);
        }
      }

      return reply.status(200).send({
        message: "Profile image updated successfully",
        profileImage: {
          type: updatedUser.profileImageType,
          data: updatedUser.profileImageData
        }
      });
    } catch (error) {
      return handleError(reply, 500, "Error setting profile image", 'SET_PROFILE_IMAGE_ERROR', error);
    }
  })





  app.post('/me/switch-chain', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 30, // Allow up to 30 chain switches per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { chain } = request.body;

      const chainValidation = await validateRequiredFields(request.body, ['chain'], reply);
      if (chainValidation !== true) return;

      // Validate chain value
      if (!['APTOS'].includes(chain)) {
        return handleError(reply, 400, "Invalid chain. Must be APTOS", 'INVALID_CHAIN');
      }

      // Find user's wallet for the requested chain
      const targetWallet = await prismaQuery.userWallet.findFirst({
        where: {
          userId: request.user.id,
          chain: chain,
          isActive: true
        },
        include: {
          user: {
            include: {
              wallets: true
            }
          }
        }
      });

      if (!targetWallet) {
        return handleError(reply, 404, `No ${chain} wallet found for user`, 'WALLET_NOT_FOUND');
      }

      // Create new JWT with the target wallet context
      const token = jwt.sign({
        id: targetWallet.user.id,
        username: targetWallet.user.username,
        email: targetWallet.user.email,
        privyUserId: targetWallet.user.privyUserId,
        walletId: targetWallet.id,
        walletAddress: targetWallet.walletAddress,
        chain: targetWallet.chain,
        loginMethod: targetWallet.loginMethod,
        // Include available wallets for future switching
        availableWallets: targetWallet.user.wallets.map(w => ({
          id: w.id,
          chain: w.chain,
          loginMethod: w.loginMethod,
          walletAddress: w.walletAddress,
          privyWalletId: w.privyWalletId
        }))
      }, process.env.JWT_SECRET, {
        expiresIn: '30d'
      });

      return reply.status(200).send({
        message: `Switched to ${chain} successfully`,
        token,
        currentWallet: {
          id: targetWallet.id,
          walletAddress: targetWallet.walletAddress,
          chain: targetWallet.chain,
          loginMethod: targetWallet.loginMethod
        }
      });
    } catch (error) {
      return handleError(reply, 500, "Error switching chain", 'SWITCH_CHAIN_ERROR', error);
    }
  })




  done();
}

