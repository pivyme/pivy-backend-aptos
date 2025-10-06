import { prismaQuery } from './src/lib/prisma.js';

async function debugUserData() {
  try {
    const user = await prismaQuery.user.findUnique({
      where: {
        username: 'kelpin'
      },
      include: {
        links: {
          include: {
            chainConfigs: {
              include: {
                mint: true
              }
            }
          }
        },
        wallets: true
      }
    });

    if (!user) {
      console.log('User kelpin not found');
      return;
    }

    console.log('User:', {
      id: user.id,
      username: user.username,
      email: user.email,
      privyUserId: user.privyUserId
    });

    console.log('\nWallets:');
    user.wallets.forEach(wallet => {
      console.log(`  - ${wallet.chain}: ${wallet.walletAddress} (${wallet.loginMethod})`);
    });

    console.log('\nLinks:');
    user.links.forEach(link => {
      console.log(`  Link ID: ${link.id}`);
      console.log(`  Tag: "${link.tag}"`);
      console.log(`  Label: ${link.label}`);
      console.log(`  Type: ${link.type}`);
      console.log(`  Supported Chains: ${JSON.stringify(link.supportedChains)}`);
      console.log(`  Chain Configs: ${link.chainConfigs.length} configs`);
      link.chainConfigs.forEach(config => {
        console.log(`    - ${config.chain}: enabled=${config.isEnabled}, amount=${config.amount}`);
      });
      console.log('');
    });
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prismaQuery.$disconnect();
  }
}

debugUserData(); 