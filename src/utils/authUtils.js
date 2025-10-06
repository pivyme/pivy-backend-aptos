import { prismaQuery } from '../lib/prisma.js';
import { createMultiChainLink } from './linkUtils.js';

/**
 * Find or create a user with support for multiple wallets and wallet address linking
 * This handles cases where users might login with the same wallet using different methods
 */
export const findOrCreateUserWithWallet = async ({
  walletAddress,
  chain,
  loginMethod,
  email = null,
  createDefaultLink = true
}) => {
  // Try to find by exact wallet match first
  let user = null;
  let wallet = null;

  wallet = await prismaQuery.userWallet.findUnique({
    where: {
      walletAddress_chain_loginMethod: {
        walletAddress,
        chain,
        loginMethod
      }
    },
    include: {
      user: {
        include: {
          wallets: true,
          links: true
        }
      }
    }
  });

  if (wallet) {
    user = wallet.user;
  }

  // ENHANCED LOGIC: If no exact match, look for same wallet with different login method
  if (!user) {
    const existingWallet = await prismaQuery.userWallet.findFirst({
      where: {
        walletAddress,
        chain
        // Note: NOT filtering by loginMethod here - this allows cross-login-method linking
      },
      include: {
        user: {
          include: {
            wallets: true,
            links: true
          }
        }
      }
    });

    if (existingWallet) {
      // Same wallet exists with different login method - link to existing user
      user = existingWallet.user;

      console.log(`Linking wallet ${walletAddress} (${chain}, ${loginMethod}) to existing user ${user.id}`);

      // Create new wallet entry for this login method
      try {
        wallet = await prismaQuery.userWallet.create({
          data: {
            userId: user.id,
            walletAddress,
            chain,
            loginMethod,
            isPrimary: false // Keep existing primary wallet settings
          }
        });
      } catch (error) {
        // If wallet already exists (race condition), fetch it
        if (error.code === 'P2002') {
          wallet = await prismaQuery.userWallet.findUnique({
            where: {
              walletAddress_chain_loginMethod: {
                walletAddress,
                chain,
                loginMethod
              }
            }
          });
        } else {
          throw error;
        }
      }

      // Update email if provided and different
      if (email && user.email !== email && !user.email) {
        await prismaQuery.user.update({
          where: { id: user.id },
          data: { email }
        });
        user.email = email;
      }
    }
  }

  // If no user found, create new user with wallet
  if (!user) {
    try {
      // Use a transaction to ensure user creation and link creation are atomic
      const result = await prismaQuery.$transaction(async (tx) => {
        // Create user with wallet
        const newUser = await tx.user.create({
          data: {
            email,
            wallets: {
              create: {
                walletAddress,
                chain,
                loginMethod,
                isPrimary: true // First wallet is always primary
              }
            },
          },
          include: {
            wallets: true,
            links: true
          }
        });

        // Create default link if requested and user has no personal link
        if (createDefaultLink) {
          // Check if user already has a personal link (should be empty for new user)
          const existingPersonalLink = newUser.links.find(link =>
            link.tag === '' && link.label === 'personal' && link.status === 'ACTIVE'
          );

          if (!existingPersonalLink) {
            // Get user's profile image to use correct emoji/color if available
            let linkData = {
              userId: newUser.id,
              tag: '',
              label: 'personal',
              type: 'SIMPLE',
              amountType: 'OPEN'
            };

            // If user has profile image, use it for the personal link
            if (newUser.profileImageType === 'EMOJI_AND_COLOR' && newUser.profileImageData) {
              linkData.emoji = newUser.profileImageData.emoji;
              linkData.backgroundColor = newUser.profileImageData.backgroundColor;
            }

            // For wallet users, create single-chain link
            await createMultiChainLink(linkData, [
              { chain, isEnabled: true }
            ], tx); // Pass transaction to createMultiChainLink
          }
        }

        return newUser;
      });

      user = result;
      wallet = user.wallets[0];
    } catch (error) {
      // If wallet already exists (race condition or concurrent requests), fetch it
      if (error.code === 'P2002') {
        console.log('Wallet already exists, fetching existing user');
        wallet = await prismaQuery.userWallet.findUnique({
          where: {
            walletAddress_chain_loginMethod: {
              walletAddress,
              chain,
              loginMethod
            }
          },
          include: {
            user: {
              include: {
                wallets: true,
                links: true
              }
            }
          }
        });

        if (wallet) {
          user = wallet.user;
        } else {
          throw new Error('Failed to find wallet after unique constraint error');
        }
      } else {
        throw error;
      }
    }
  }

  // Update email if provided and different
  if (email && user.email !== email) {
    await prismaQuery.user.update({
      where: { id: user.id },
      data: { email }
    });
  }

  return { user, wallet };
};

/**
 * Find user by wallet address, chain, and login method
 * This is used by the auth middleware to find the user from token
 */
export const findUserByWallet = async (walletAddress, chain, loginMethod) => {
  const wallet = await prismaQuery.userWallet.findUnique({
    where: {
      walletAddress_chain_loginMethod: {
        walletAddress,
        chain,
        loginMethod
      }
    },
    include: {
      user: {
        include: {
          wallets: true,
          links: true
        }
      }
    }
  });

  return wallet?.user || null;
};

/**
 * Get user's primary wallet or first wallet if no primary is set
 */
export const getUserPrimaryWallet = (user) => {
  if (!user.wallets || user.wallets.length === 0) {
    return null;
  }

  const primaryWallet = user.wallets.find(w => w.isPrimary);
  return primaryWallet || user.wallets[0];
};

/**
 * Set a wallet as primary for a user
 */
export const setPrimaryWallet = async (userId, walletId) => {
  await prismaQuery.$transaction([
    // Remove primary flag from all user's wallets
    prismaQuery.userWallet.updateMany({
      where: { userId },
      data: { isPrimary: false }
    }),
    // Set the specified wallet as primary
    prismaQuery.userWallet.update({
      where: { id: walletId },
      data: { isPrimary: true }
    })
  ]);
};