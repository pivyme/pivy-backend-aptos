/**
 * Script to fix CCTP transaction records with incorrect USDC addresses
 * 
 * This fixes:
 * 1. Updates usdcAddress from EVM address to Aptos USDC address
 * 2. Updates token cache for USDC with correct decimals (6 instead of 8)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const APTOS_USDC_ADDRESS = '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832';
const EVM_USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

async function fixCctpUsdcAddress() {
  console.log('🔧 Starting CCTP USDC address fix...\n');

  try {
    // 1. Fix CCTP transaction records
    console.log('1️⃣  Fixing CCTP transaction records...');
    const cctpTransactions = await prisma.cctpTransaction.findMany({
      where: {
        chain: {
          in: ['APTOS_MAINNET', 'APTOS_TESTNET']
        },
        usdcAddress: EVM_USDC_ADDRESS
      }
    });

    console.log(`   Found ${cctpTransactions.length} CCTP transactions with incorrect USDC address`);

    for (const tx of cctpTransactions) {
      await prisma.cctpTransaction.update({
        where: { id: tx.id },
        data: {
          usdcAddress: APTOS_USDC_ADDRESS
        }
      });
      console.log(`   ✅ Updated transaction ${tx.id}`);
    }

    // 2. Fix token cache for USDC
    console.log('\n2️⃣  Fixing USDC token cache...');
    
    // Check if EVM USDC address exists in cache for Aptos chains
    const badCaches = await prisma.mintDataCache.findMany({
      where: {
        chain: {
          in: ['APTOS_MAINNET', 'APTOS_TESTNET']
        },
        mintAddress: EVM_USDC_ADDRESS
      }
    });

    console.log(`   Found ${badCaches.length} incorrect USDC token cache entries`);

    for (const cache of badCaches) {
      // Delete the incorrect cache entry
      await prisma.mintDataCache.delete({
        where: {
          mintAddress_chain: {
            mintAddress: cache.mintAddress,
            chain: cache.chain
          }
        }
      });
      console.log(`   🗑️  Deleted incorrect cache for ${cache.chain}`);
    }

    // Create correct USDC token cache entries
    for (const chain of ['APTOS_MAINNET', 'APTOS_TESTNET']) {
      await prisma.mintDataCache.upsert({
        where: {
          mintAddress_chain: {
            mintAddress: APTOS_USDC_ADDRESS,
            chain: chain
          }
        },
        update: {
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6, // Correct decimals for USDC
          imageUrl: '/assets/tokens/usdc.png',
          description: 'USD Coin via CCTP',
          isInvalid: false,
          isNative: false,
          isVerified: true,
          priceUsd: 1
        },
        create: {
          mintAddress: APTOS_USDC_ADDRESS,
          chain: chain,
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6, // Correct decimals for USDC
          imageUrl: '/assets/tokens/usdc.png',
          description: 'USD Coin via CCTP',
          uriData: {},
          isInvalid: false,
          isNative: false,
          isVerified: true,
          priceUsd: 1
        }
      });
      console.log(`   ✅ Created/updated correct USDC cache for ${chain}`);
    }

    console.log('\n✅ CCTP USDC address fix completed successfully!');
    console.log('\n📝 Summary:');
    console.log(`   - Fixed ${cctpTransactions.length} CCTP transaction records`);
    console.log(`   - Removed ${badCaches.length} incorrect token cache entries`);
    console.log(`   - Created/updated correct USDC token cache entries`);
    console.log('\n💡 Note: New CCTP transactions will now automatically use the correct Aptos USDC address');

  } catch (error) {
    console.error('❌ Error fixing CCTP USDC addresses:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

fixCctpUsdcAddress()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
