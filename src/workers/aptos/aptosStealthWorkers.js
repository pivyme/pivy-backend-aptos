import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { CHAINS, isTestnet } from "../../config.js";
import { prismaQuery } from "../../lib/prisma.js";
import bs58 from 'bs58';
import { getOrCreateAptosTokenCache } from "../../utils/aptosUtils.js";
import { processAptosPaymentTx, processAptosWithdrawalTx, reprocessUserIdScans } from "./helpers/aptosActivityHelpers.js";
import cron from "node-cron";
import { invalidateCacheForNewPayment, invalidateCacheForNewWithdrawal } from "../../utils/balanceCacheUtils.js";
import { markProcessComplete } from "../../utils/processingLogUtils.js";
import { getCronSchedule, logIndexerSpeedConfig } from "../../utils/cronUtils.js";

const NATIVE_APT_COINTYPE = '0x1::aptos_coin::AptosCoin';

/**
 * Get or create native APT token cache
 * @param {string} chainId - Chain ID (APTOS_MAINNET or APTOS_TESTNET)
 * @returns {Promise<Object>} Token cache object
 */
const getOrCreateNativeAPTCache = async (chainId) => {
  // Always upsert to ensure correct metadata
  return await prismaQuery.mintDataCache.upsert({
    where: {
      mintAddress_chain: {
        mintAddress: NATIVE_APT_COINTYPE,
        chain: chainId
      }
    },
    update: {
      name: "Aptos Coin",
      symbol: "APT",
      decimals: 8,
      imageUrl: "/assets/tokens/aptos.png",
      description: "Native Aptos token",
      uriData: {},
      isInvalid: false,
      isVerified: true,
      isNative: true,
      priceUsd: 0
    },
    create: {
      mintAddress: NATIVE_APT_COINTYPE,
      chain: chainId,
      name: "Aptos Coin",
      symbol: "APT",
      decimals: 8,
      imageUrl: "/assets/tokens/aptos.png",
      description: "Native Aptos token",
      uriData: {},
      isInvalid: false,
      isVerified: true,
      isNative: true,
      priceUsd: 0
    }
  });
};

/**
 * Helper function to convert byte array or hex string to base58
 */
const bytesToBase58 = (input) => {
  if (!input) return '';
  
  try {
    // If it's a hex string (from REST API)
    if (typeof input === 'string') {
      const hexStr = input.startsWith('0x') ? input.slice(2) : input;
      const buffer = Buffer.from(hexStr, 'hex');
      return bs58.encode(buffer);
    }
    
    // If it's a byte array (from GraphQL indexer)
    if (Array.isArray(input)) {
      const validBytes = input.filter(byte => typeof byte === 'number');
      return bs58.encode(Buffer.from(validBytes));
    }
    
    return '';
  } catch (error) {
    console.log('Error converting to base58:', error.message);
    return '';
  }
};

/**
 * Extract asset type from event data or transaction type argument
 * For new PaymentEvent/WithdrawEvent: use fa_metadata from event data
 * For LegacyPaymentEvent<CoinType>: extract from generic type parameter
 */
const extractAssetType = (tx, eventType, eventData) => {
  try {
    // For new non-generic PaymentEvent/WithdrawEvent, use fa_metadata from event data
    if (eventData && eventData.fa_metadata) {
      return eventData.fa_metadata;
    }

    // For legacy events with generic type parameters
    if (eventType.includes('LegacyPaymentEvent') || eventType.includes('LegacyWithdrawEvent')) {
      const coinTypeMatch = eventType.match(/<(.+?)>/);
      if (coinTypeMatch) {
        return coinTypeMatch[1];
      }
    }

    // Default to native APT if we can't determine
    return NATIVE_APT_COINTYPE;
  } catch (error) {
    console.log('Error extracting asset type:', error.message);
    return NATIVE_APT_COINTYPE;
  }
};

/**
 * Calculate actual balance change for a withdrawal including fees
 * @param {Object} tx - Transaction object with balance changes
 * @param {string} stealthOwnerPubkey - The stealth address that withdrew funds
 * @param {string} assetType - The token asset type
 * @param {string} eventAmount - The amount from the withdrawal event
 * @returns {string|null} - The actual amount withdrawn including fees, or null if cannot calculate
 */
const calculateActualWithdrawalAmount = (tx, stealthOwnerPubkey, assetType, eventAmount) => {
  try {
    // For Aptos, we'll use the event amount as-is since balance changes aren't
    // available in the same way as Aptos. The smart contract should emit the correct amount.
    return eventAmount;
  } catch (error) {
    console.error('Error calculating actual withdrawal amount:', error);
    return null;
  }
};

/**
 * Main Aptos stealth workers
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const aptosStealthWorkers = (app, _, done) => {
  const handleFetchStealthTransactions = async () => {
    try {
      const chain = isTestnet ? CHAINS.APTOS_TESTNET : CHAINS.APTOS_MAINNET;
      const network = isTestnet ? Network.TESTNET : Network.MAINNET;

      // Validate program ID
      if (!chain.pivyStealthProgramId) {
        console.error('ERROR: pivyStealthProgramId is not set in config!');
        console.error('Please set the environment variable:', isTestnet ? 'PIVY_STEALTH_PROGRAM_ID_APTOS_TESTNET' : 'PIVY_STEALTH_PROGRAM_ID_APTOS_MAINNET');
        console.error('Example: 0x917011515afd16b6e03840c5b63590ea44fabee53672f9e3c8df077ee849bb10');
        return;
      }

      // Ensure program ID is a valid hex address (starts with 0x and is 64 hex chars + 0x = 66 chars)
      if (!chain.pivyStealthProgramId.startsWith('0x') || chain.pivyStealthProgramId.length !== 66) {
        console.error('ERROR: Invalid pivyStealthProgramId format:', chain.pivyStealthProgramId);
        console.error('Expected format: 0x followed by 64 hex characters (total 66 chars)');
        console.error('Example: 0x917011515afd16b6e03840c5b63590ea44fabee53672f9e3c8df077ee849bb10');
        return;
      }

      console.log('Using Aptos program ID:', chain.pivyStealthProgramId);

      // Setup Aptos SDK with API key if available
      const aptosApiKey = process.env.APTOS_API_KEY;
      
      if (aptosApiKey) {
        console.log('Using Aptos API key for authenticated requests');
      } else {
        console.log('No Aptos API key found, using public endpoints');
      }
      const configOptions = {
        network,
        fullnode: chain.rpcUrl || chain.publicRpcUrl
      };

      // Add API key to client config if available
      if (aptosApiKey) {
        configOptions.clientConfig = {
          API_KEY: aptosApiKey
        };
      }

      const config = new AptosConfig(configOptions);
      const aptos = new Aptos(config);

      // Get all potential users once at the start
      const userWallets = await prismaQuery.userWallet.findMany({
        where: {
          chain: 'APTOS',
          isActive: true,
          metaViewPriv: { not: null },
          metaSpendPub: { not: null },
          metaViewPub: { not: null }
        },
        include: { user: true }
      });

      const users = userWallets.map(wallet => ({
        ...wallet.user,
        activeWallet: {
          id: wallet.id,
          chain: wallet.chain,
          walletAddress: wallet.walletAddress,
          metaViewPriv: wallet.metaViewPriv,
          metaSpendPub: wallet.metaSpendPub,
          metaViewPub: wallet.metaViewPub
        }
      }));

      // Determine GraphQL indexer URL based on network
      const indexerUrl = isTestnet 
        ? 'https://api.testnet.aptoslabs.com/v1/graphql'
        : 'https://api.mainnet.aptoslabs.com/v1/graphql';

      // Get the highest transaction version we've already processed
      // This prevents re-fetching old transactions we've already seen
      const highestPayment = await prismaQuery.payment.findFirst({
        where: { chain: chain.id },
        orderBy: { txHash: 'desc' },
        select: { txHash: true }
      });

      const highestWithdrawal = await prismaQuery.withdrawal.findFirst({
        where: { chain: chain.id },
        orderBy: { txHash: 'desc' },
        select: { txHash: true }
      });

      // Get the max version from both - txHash is stored as version string
      const maxProcessedVersion = Math.max(
        highestPayment ? parseInt(highestPayment.txHash) : 0,
        highestWithdrawal ? parseInt(highestWithdrawal.txHash) : 0
      );

      if (maxProcessedVersion > 0) {
        console.log(`Resuming from transaction version: ${maxProcessedVersion}`);
      }

      const limit = 20;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        let txVersions = [];
        try {
          // Query transactions using GraphQL indexer to find all txs that interact with the contract
          // Only fetch transactions with version > maxProcessedVersion to avoid re-fetching old txs
          const graphqlQuery = {
            query: `
              query UserTransactions($contractAddress: String!, $limit: Int!, $offset: Int!, $minVersion: bigint!) {
                user_transactions(
                  where: {
                    entry_function_contract_address: {_eq: $contractAddress}
                    version: {_gt: $minVersion}
                  }
                  limit: $limit
                  offset: $offset
                  order_by: {version: desc}
                ) {
                  version
                  sender
                  entry_function_function_name
                  entry_function_module_name
                  timestamp
                  sequence_number
                }
              }
            `,
            variables: {
              contractAddress: chain.pivyStealthProgramId,
              limit: limit,
              offset: offset,
              minVersion: maxProcessedVersion.toString()
            }
          };

          // Setup headers with API key if available
          const headers = {
            'Content-Type': 'application/json',
          };
          
          if (aptosApiKey) {
            headers['Authorization'] = `Bearer ${aptosApiKey}`;
          }

          const graphqlResponse = await fetch(indexerUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(graphqlQuery)
          });

          if (!graphqlResponse.ok) {
            const errorText = await graphqlResponse.text();
            console.error('Failed to fetch from GraphQL indexer:', errorText);
            throw new Error(`GraphQL error! status: ${graphqlResponse.status}`);
          }

          const graphqlData = await graphqlResponse.json();
          
          if (graphqlData.errors) {
            console.error('GraphQL query errors:', graphqlData.errors);
            return;
          }

          const txList = graphqlData.data?.user_transactions || [];
          
          if (txList.length === 0) {
            hasMore = false;
            break;
          }

          console.log(`Found ${txList.length} new transactions (version > ${maxProcessedVersion})`);

          txVersions = txList.map(tx => tx.version);

        } catch (apiError) {
          console.log('API error fetching transactions from indexer, skipping this cycle:', apiError.message);
          return;
        }

        if (txVersions.length === 0) {
          hasMore = false;
          break;
        }

        // Since we're filtering at query level (version > maxProcessedVersion),
        // all these transactions are potentially new - just fetch them all
        const versionsToFetch = txVersions;

        // Fetch full transaction details for each version from REST API
        const txs = [];
        for (let i = 0; i < versionsToFetch.length; i++) {
          const version = versionsToFetch[i];
          
          try {
            const restUrl = `${chain.rpcUrl || chain.publicRpcUrl}/v1/transactions/by_version/${version}`;
            
            // Setup headers with API key if available
            const fetchOptions = {
              headers: {
                'Accept': 'application/json'
              }
            };
            
            if (aptosApiKey) {
              fetchOptions.headers['Authorization'] = `Bearer ${aptosApiKey}`;
            }
            
            console.log('Fetching transaction version:', version);
            const txResponse = await fetch(restUrl, fetchOptions);
            
            if (!txResponse.ok) {
              console.error(`Failed to fetch tx version ${version}, status: ${txResponse.status}`);
              continue;
            }

            const tx = await txResponse.json();
            
            // Only process successful transactions
            if (tx.success === true && tx.type === 'user_transaction') {
              txs.push(tx);
            }

            // Rate limiting: sleep every 5 requests to avoid overloading
            if ((i + 1) % 5 === 0) {
              await new Promise(resolve => setTimeout(resolve, 200));
            }
          } catch (fetchError) {
            console.log(`Error fetching transaction version ${version}:`, fetchError.message);
            continue;
          }
        }

        if (txs.length > 0) {
          console.log(`Fetched ${txs.length} full transaction details from REST API`);
        }

        for (const tx of txs) {
          // Skip malformed transactions
          if (!tx || !tx.version || !tx.timestamp) {
            continue;
          }

          // Use version as transaction hash (more reliable and consistent)
          const txHash = tx.version.toString();

          if (!tx.events || tx.events.length === 0) {
            continue;
          }

          for (let eventIndex = 0; eventIndex < tx.events.length; eventIndex++) {
            const event = tx.events[eventIndex];
            if (!event || !event.type || !event.data) {
              console.log('Skipping malformed event:', txHash, eventIndex);
              continue;
            }

            const eventType = event.type;
            let parsedEvent = null;

            try {
              if (eventType.includes('PaymentEvent')) {
                const eventData = event.data;
                if (!eventData || !eventData.stealth_owner || !eventData.eph_pubkey) {
                  continue;
                }

                const assetType = extractAssetType(tx, eventType, eventData);
                const ephPubkey = bytesToBase58(eventData.eph_pubkey);
                if (!ephPubkey) {
                  console.log('Failed to convert ephemeral pubkey to base58:', txHash);
                  continue;
                }

                const encryptedLabel = bytesToBase58(eventData.label);
                const payload = bytesToBase58(eventData.payload);
                const encryptedNote = bytesToBase58(eventData.note);
                const timestamp = Math.floor(parseInt(tx.timestamp) / 1000000);

                parsedEvent = {
                  signature: txHash,
                  slot: timestamp,
                  type: 'IN',
                  eventIndex: eventIndex,
                  data: {
                    stealthOwner: eventData.stealth_owner,
                    payer: tx.sender || null,
                    assetType: assetType,
                    amount: eventData.amount,
                    encryptedLabel: encryptedLabel,
                    ephemeralPubkey: ephPubkey,
                    timestamp: timestamp,
                    announce: true,
                    memo: payload,
                    encryptedNote: encryptedNote,
                  }
                };
              } else if (eventType.includes('WithdrawEvent')) {
                const eventData = event.data;
                if (!eventData || !eventData.stealth_owner || !eventData.destination) {
                  continue;
                }

                const assetType = extractAssetType(tx, eventType, eventData);
                const timestamp = Math.floor(parseInt(tx.timestamp) / 1000000);

                parsedEvent = {
                  signature: txHash,
                  slot: timestamp,
                  type: 'OUT',
                  eventIndex: eventIndex,
                  data: {
                    stealthOwner: eventData.stealth_owner,
                    destination: eventData.destination,
                    assetType: assetType,
                    amount: eventData.amount,
                    timestamp: timestamp,
                  }
                };
              }
            } catch (eventParseError) {
              console.log('Error parsing event:', eventParseError.message, 'tx:', txHash, 'eventIndex:', eventIndex);
              continue;
            }

            if (!parsedEvent) continue;

            let tokenCache;
            try {
              if (parsedEvent.data.assetType === NATIVE_APT_COINTYPE) {
                tokenCache = await getOrCreateNativeAPTCache(chain.id);
              } else {
                tokenCache = await getOrCreateAptosTokenCache(
                  parsedEvent.data.assetType,
                  chain.id,
                  aptos
                );
              }

              // Skip this event if we couldn't create/get token cache
              if (!tokenCache || !tokenCache.id) {
                console.warn(`Failed to get token cache for asset ${parsedEvent.data.assetType}, skipping event processing`);
                continue;
              }
            } catch (tokenCacheError) {
              console.log('Error getting token cache:', tokenCacheError.message, 'asset:', parsedEvent.data.assetType);
              continue;
            }

            if (parsedEvent.type === 'IN') {
              // Check if this specific payment already exists (using event index for uniqueness)
              const existingPayment = await prismaQuery.payment.findFirst({
                where: {
                  txHash: parsedEvent.signature,
                  stealthOwnerPubkey: parsedEvent.data.stealthOwner,
                  ephemeralPubkey: parsedEvent.data.ephemeralPubkey,
                  eventIndex: parsedEvent.eventIndex,
                  mintId: tokenCache.id
                }
              });

              if (existingPayment) {
                console.log(`Payment already exists for tx ${parsedEvent.signature}`);
                continue;
              }

              const newPayment = await prismaQuery.payment.create({
                data: {
                  txHash: parsedEvent.signature,
                  slot: parsedEvent.slot,
                  timestamp: parsedEvent.data.timestamp,
                  stealthOwnerPubkey: parsedEvent.data.stealthOwner,
                  ephemeralPubkey: parsedEvent.data.ephemeralPubkey,
                  payerPubKey: parsedEvent.data.payer,
                  amount: parsedEvent.data.amount,
                  label: parsedEvent.data.encryptedLabel,
                  memo: parsedEvent.data.memo,
                  eventIndex: parsedEvent.eventIndex,
                  announce: parsedEvent.data.announce,
                  chain: chain.id,
                  mint: {
                    connect: {
                      id: tokenCache.id
                    }
                  }
                }
              }).catch(err => {
                if (err.code !== 'P2002') {
                  console.log('Error creating payment:', err);
                }
                return null;
              });

              if (newPayment) {
                // Only process if not already linked (save RPC calls)
                let paymentProcessResult = null;
                if (!newPayment.linkId) {
                  paymentProcessResult = await processAptosPaymentTx({
                    txHash: newPayment.txHash,
                    users: users,
                    encryptedNote: parsedEvent.data.encryptedNote,
                    encryptedLabel: parsedEvent.data.encryptedLabel,
                    eventIndex: parsedEvent.eventIndex,
                    stealthOwnerPubkey: parsedEvent.data.stealthOwner,
                    ephemeralPubkey: parsedEvent.data.ephemeralPubkey
                  });
                } else {
                  console.log(`Payment ${newPayment.id} already linked, skipping processing`);
                }

                await invalidateCacheForNewPayment({
                  stealthOwnerPubkey: newPayment.stealthOwnerPubkey,
                  chain: newPayment.chain,
                  link: paymentProcessResult?.link || null
                });

                // Check if this is an internal transfer (sender is a known stealth address)
                if (parsedEvent.data.payer) {
                  const isInternalTransfer = await prismaQuery.payment.findFirst({
                    where: {
                      stealthOwnerPubkey: parsedEvent.data.payer,
                      chain: chain.id
                    },
                    include: {
                      link: {
                        select: {
                          userId: true
                        }
                      }
                    }
                  });

                  // Update the payment with payerUserId if it's an internal transfer
                  if (isInternalTransfer && isInternalTransfer.link) {
                    await prismaQuery.payment.update({
                      where: { id: newPayment.id },
                      data: {
                        payerUser: {
                          connect: {
                            id: isInternalTransfer.link.userId
                          }
                        }
                      }
                    });
                  }

                  if (isInternalTransfer) {
                    const payerUserId = isInternalTransfer.link?.userId || null;
                    const destinationUserId = paymentProcessResult?.link?.userId || null;

                    // Create a withdrawal record for the internal transfer
                    const internalWithdrawal = await prismaQuery.withdrawal.create({
                      data: {
                        txHash: parsedEvent.signature,
                        slot: parsedEvent.slot,
                        timestamp: parsedEvent.data.timestamp,
                        stealthOwnerPubkey: parsedEvent.data.payer,
                        destinationPubkey: parsedEvent.data.stealthOwner,
                        amount: parsedEvent.data.amount,
                        chain: chain.id,
                        ...(payerUserId && {
                          user: {
                            connect: {
                              id: payerUserId
                            }
                          }
                        }),
                        ...(destinationUserId && {
                          destinationUser: {
                            connect: {
                              id: destinationUserId
                            }
                          }
                        }),
                        isProcessed: true,
                        isInternalTransfer: true,
                        mint: {
                          connect: {
                            id: tokenCache.id
                          }
                        }
                      }
                    }).catch(err => {
                      if (err.code !== 'P2002') {
                        console.log('Error creating internal transfer withdrawal:', err);
                      }
                      return null;
                    });

                    if (internalWithdrawal) {
                      const withdrawalCompositeKey = `${parsedEvent.signature}_${parsedEvent.data.payer}_${tokenCache.id}`;
                      await markProcessComplete(withdrawalCompositeKey, 'WITHDRAWAL_USER_ID_SCAN');
                      await markProcessComplete(withdrawalCompositeKey, 'WITHDRAWAL_DESTINATION_USER_ID_SCAN');
                    }
                  }
                }
              }
            } else if (parsedEvent.type === 'OUT') {
              // Check if this specific withdrawal already exists
              const existingWithdrawal = await prismaQuery.withdrawal.findUnique({
                where: {
                  txHash_stealthOwnerPubkey_mintId: {
                    txHash: parsedEvent.signature,
                    stealthOwnerPubkey: parsedEvent.data.stealthOwner,
                    mintId: tokenCache.id
                  }
                }
              });

              if (existingWithdrawal) {
                console.log(`Withdrawal already exists for tx ${parsedEvent.signature}`);
                continue;
              }

              // Calculate actual withdrawal amount including fees
              const actualAmount = calculateActualWithdrawalAmount(
                tx,
                parsedEvent.data.stealthOwner,
                parsedEvent.data.assetType,
                parsedEvent.data.amount
              );

              const newWithdrawal = await prismaQuery.withdrawal.create({
                data: {
                  txHash: parsedEvent.signature,
                  slot: parsedEvent.slot,
                  timestamp: parsedEvent.data.timestamp,
                  stealthOwnerPubkey: parsedEvent.data.stealthOwner,
                  destinationPubkey: parsedEvent.data.destination,
                  amount: parsedEvent.data.amount,
                  amountAfterFee: actualAmount,
                  chain: chain.id,
                  mint: {
                    connect: {
                      id: tokenCache.id
                    }
                  }
                }
              }).catch(err => {
                if (err.code !== 'P2002') {
                  console.log('Error creating withdrawal:', err);
                }
                return null;
              });

              if (newWithdrawal) {
                // Only process if not already linked to user (save RPC calls)
                let withdrawalProcessResult = null;
                if (!newWithdrawal.userId || !newWithdrawal.isProcessed) {
                  withdrawalProcessResult = await processAptosWithdrawalTx({
                    txHash: newWithdrawal.txHash
                  });
                } else {
                  console.log(`Withdrawal ${newWithdrawal.txHash} already processed, skipping processing`);
                }

                await invalidateCacheForNewWithdrawal({
                  stealthOwnerPubkey: newWithdrawal.stealthOwnerPubkey,
                  chain: newWithdrawal.chain,
                  userId: withdrawalProcessResult?.userId || null
                });
              }
            }
          }
        }

        // Update offset for next batch
        offset += limit;

        // Check if we got fewer results than the limit (reached the end)
        if (txVersions.length < limit) {
          hasMore = false;
        } else {
          // Sleep between batches to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } catch (error) {
      console.log('error in handleFetchStealthTransactions', error);
    }
  };

  const reprocessUnlinkedWithdrawals = async () => {
    try {
      const chain = isTestnet ? CHAINS.APTOS_TESTNET : CHAINS.APTOS_MAINNET;
      const unlinkedWithdrawals = await prismaQuery.withdrawal.findMany({
        where: {
          userId: null,
          isProcessed: false,
          chain: chain.id,
        },
        distinct: ['txHash'],
        take: 50,
      });

      if (unlinkedWithdrawals.length > 0) {
        console.log(`Found ${unlinkedWithdrawals.length} transaction hashes with unlinked withdrawals to re-process.`);
        for (const withdrawal of unlinkedWithdrawals) {
          await processAptosWithdrawalTx({ txHash: withdrawal.txHash });
        }
      }
    } catch (error) {
      console.error('Error in reprocessUnlinkedWithdrawals:', error);
    }
  };

  // Log indexer speed configuration
  logIndexerSpeedConfig();

  handleFetchStealthTransactions();
  reprocessUnlinkedWithdrawals();

  // Schedule based on INDEXER_SPEED environment variable
  const threeSecSchedule = getCronSchedule('everyTenSeconds');
  const thirtySecSchedule = getCronSchedule('everyThirtySeconds');
  const twoMinSchedule = getCronSchedule('everyTwoMinutes');

  console.log(`= APTOS Stealth worker schedules:`);
  console.log(`   - Fetch transactions: ${threeSecSchedule}`);
  console.log(`   - Reprocess withdrawals: ${thirtySecSchedule}`);
  console.log(`   - Reprocess user scans: ${twoMinSchedule}`);

  cron.schedule(threeSecSchedule, () => {
    handleFetchStealthTransactions();
  });

  cron.schedule(thirtySecSchedule, () => {
    reprocessUnlinkedWithdrawals();
  });

  cron.schedule(twoMinSchedule, () => {
    reprocessUserIdScans();
  });

  done();
};
