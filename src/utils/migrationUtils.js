
import { prismaQuery } from '../lib/prisma.js';



/**
 * Validate that all users have at least one wallet
 */
export const validateUserWallets = async () => {
  try {
    const usersWithoutWallets = await prismaQuery.user.findMany({
      where: {
        wallets: {
          none: {}
        }
      }
    });
    
    if (usersWithoutWallets.length > 0) {
      console.warn(`Found ${usersWithoutWallets.length} users without wallets:`, usersWithoutWallets.map(u => u.id));
      return false;
    }
    
    console.log('All users have at least one wallet');
    return true;
  } catch (error) {
    console.error('Validation error:', error);
    return false;
  }
};

/**
 * Ensure all users have a primary wallet set
 */
export const ensurePrimaryWallets = async () => {
  try {
    const users = await prismaQuery.user.findMany({
      include: {
        wallets: true
      }
    });
    
    const updates = [];
    
    for (const user of users) {
      const primaryWallet = user.wallets.find(w => w.isPrimary);
      
      if (!primaryWallet && user.wallets.length > 0) {
        // Set first wallet as primary
        updates.push(
          prismaQuery.userWallet.update({
            where: { id: user.wallets[0].id },
            data: { isPrimary: true }
          })
        );
      }
    }
    
    if (updates.length > 0) {
      await prismaQuery.$transaction(updates);
      console.log(`Set primary wallet for ${updates.length} users`);
    }
    
    return true;
  } catch (error) {
    console.error('Error ensuring primary wallets:', error);
    return false;
  }
};