import { prismaQuery } from './src/lib/prisma.js';

async function fixSupportedChains() {
  try {
    // Get all links with their chain configs
    const links = await prismaQuery.link.findMany({
      include: {
        chainConfigs: {
          where: {
            isEnabled: true
          }
        }
      }
    });

    console.log(`Found ${links.length} links to check`);

    for (const link of links) {
      // Get the chains from chainConfigs
      const chainsFromConfigs = link.chainConfigs.map(config => config.chain);
      
      // Check if supportedChains matches chainConfigs
      const supportedChainsSet = new Set(link.supportedChains);
      const chainConfigsSet = new Set(chainsFromConfigs);
      
      const isMatching = 
        supportedChainsSet.size === chainConfigsSet.size &&
        [...supportedChainsSet].every(chain => chainConfigsSet.has(chain));

      if (!isMatching) {
        console.log(`\nFixing link ${link.id} (tag: "${link.tag}")`);
        console.log(`  Current supportedChains: ${JSON.stringify(link.supportedChains)}`);
        console.log(`  Should be: ${JSON.stringify(chainsFromConfigs)}`);
        
        // Update the link
        await prismaQuery.link.update({
          where: {
            id: link.id
          },
          data: {
            supportedChains: chainsFromConfigs
          }
        });
        
        console.log(`  ✅ Updated!`);
      } else {
        console.log(`Link ${link.id} (tag: "${link.tag}") is already correct`);
      }
    }

    console.log('\n✅ All links have been checked and fixed!');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prismaQuery.$disconnect();
  }
}

fixSupportedChains(); 