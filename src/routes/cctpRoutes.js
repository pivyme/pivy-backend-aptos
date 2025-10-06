import axios from 'axios';
import { CHAINS } from '../config.js';
import { prismaQuery } from '../lib/prisma.js';
import { handleError, handleNotFoundError } from '../utils/errorHandler.js';
import { validateRequiredFields } from '../utils/validationUtils.js';
import createTurnstileMiddleware from '../middlewares/turnstileMiddleware.js';





// We'll implement these completion functions by extracting logic from the existing route

// Rate limiter for Circle API calls (max 20 requests per second)
let lastCircleApiCall = 0;
const MIN_INTERVAL_BETWEEN_CALLS = 50; // 50ms = 20 calls per second

async function rateLimitedCircleApiCall(url) {
  const now = Date.now();
  const timeSinceLastCall = now - lastCircleApiCall;
  
  if (timeSinceLastCall < MIN_INTERVAL_BETWEEN_CALLS) {
    const waitTime = MIN_INTERVAL_BETWEEN_CALLS - timeSinceLastCall;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastCircleApiCall = Date.now();
  return axios.get(url);
}

/**
 * Retrieve attestation from Circle API
 * @param {number} srcDomain - Source domain
 * @param {string} burnTxHash - Burn transaction hash
 * @param {string} chain - Chain identifier (e.g., 'APTOS_MAINNET', 'APTOS_TESTNET')
 * @param {number} maxRetries - Maximum retry attempts
 */
export async function retrieveAttestation(srcDomain, burnTxHash, chain, maxRetries = 12) {
  // Determine API endpoint based on chain
  const isMainnet = chain === 'APTOS_MAINNET';
  const baseUrl = isMainnet
    ? 'https://iris-api.circle.com'
    : 'https://iris-api-sandbox.circle.com';
  
  const url = `${baseUrl}/v1/messages/${srcDomain}/${burnTxHash}`;
  console.log('url', url);
  
  console.log(`🔍 Retrieving attestation from ${isMainnet ? 'mainnet' : 'testnet'} Circle API`);
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await rateLimitedCircleApiCall(url);
      const msg = response.data?.messages?.[0];
      if (msg && msg.attestation !== 'PENDING') {
        console.log('✓ attestation ready');
        return msg;
      }
      console.log(`… awaiting attestation (attempt ${i + 1}/${maxRetries})`);
    } catch (e) {
      console.log('iris error', e.message);
      console.log('⚠️  iris error, retrying');
    }
    await new Promise(r => setTimeout(r, 15000));
  }
  throw new Error('attestation not ready after max retries');
}

/**
 * Execute the CCTP completion (extracted from the original process-cctp-tx logic)
 */
export async function executeCctpCompletion(data) {
  const { chain, linkId, attestation, recipientAddress, ephPub, encryptedPayload, encryptedLabel, encryptedNote, paymentInfoId } = data;

  // This contains the same logic as the original process-cctp-tx route
  // but without the validation parts since we've already validated and stored the data

  const chainConfig = CHAINS[chain];
  if (!chainConfig) {
    throw new Error('Invalid chain specified');
  }

  // Get link details
  const link = await prismaQuery.link.findUnique({
    where: { id: linkId }
  });

  if (!link) {
    throw new Error('Link not found');
  }

  // Execute chain-specific completion logic
  if (chainConfig.id === "APTOS_MAINNET" || chainConfig.id === "APTOS_TESTNET") {
    // Import Aptos SDK
    const { Aptos, AptosConfig, Network, MoveVector } = await import('@aptos-labs/ts-sdk');
    const { readFileSync } = await import('fs');
    const { GAS_SPONSORSHIP } = await import('../config.js');

    // Determine network
    const isMainnet = chainConfig.id === 'APTOS_MAINNET';
    const network = isMainnet ? Network.MAINNET : Network.TESTNET;

    // Initialize Aptos client with explicit fullnode URL
    const fullnodeUrl = isMainnet
      ? 'https://fullnode.mainnet.aptoslabs.com/v1'
      : 'https://fullnode.testnet.aptoslabs.com/v1';

    const aptosConfig = new AptosConfig({
      network,
      fullnode: fullnodeUrl,
    });
    const aptosClient = new Aptos(aptosConfig);

    // Get fee payer account
    const feePayerAccount = GAS_SPONSORSHIP.APTOS.wallet;
    if (!feePayerAccount) {
      throw new Error('Fee payer account not configured');
    }

    console.log('🔧 Executing Aptos CCTP completion...');
    console.log('   Recipient:', recipientAddress);
    console.log('   Attestation object:', JSON.stringify(attestation, null, 2));

    // Prepare attestation data
    if (!attestation || !attestation.message || !attestation.attestation) {
      throw new Error(`Invalid attestation data: ${JSON.stringify(attestation)}`);
    }

    // Remove 0x prefix if present
    const messageHex = attestation.message.startsWith('0x')
      ? attestation.message.slice(2)
      : attestation.message;
    const attestationHex = attestation.attestation.startsWith('0x')
      ? attestation.attestation.slice(2)
      : attestation.attestation;

    const messageBytes = Buffer.from(messageHex, 'hex');
    const attestationSignature = Buffer.from(attestationHex, 'hex');

    // Load the handle_receive_message script
    const scriptPath = isMainnet
      ? 'src/lib/cctp-scripts/mainnet/handle_receive_message.mv'
      : 'src/lib/cctp-scripts/testnet/handle_receive_message.mv';

    let bytecode;
    try {
      const buffer = readFileSync(scriptPath);
      bytecode = Uint8Array.from(buffer);
    } catch (error) {
      throw new Error(`Failed to load CCTP script from ${scriptPath}: ${error.message}`);
    }

    // Prepare transaction arguments using MoveVector.U8 as per Aptos tutorial
    // The script expects: vector<u8> message, vector<u8> attestation
    const functionArguments = [
      MoveVector.U8(messageBytes),
      MoveVector.U8(attestationSignature)
    ];

    // Build and submit transaction
    console.log('📤 Building receive_message transaction...');
    console.log('   Message length:', messageBytes.length, 'bytes');
    console.log('   Attestation length:', attestationSignature.length, 'bytes');

    const transaction = await aptosClient.transaction.build.simple({
      sender: feePayerAccount.accountAddress,
      data: {
        bytecode,
        functionArguments,
      },
    });

    console.log('✍️  Signing and submitting transaction...');
    let receiveMessageTx;
    try {
      const pendingTxn = await aptosClient.signAndSubmitTransaction({
        signer: feePayerAccount,
        transaction,
      });

      console.log('⏳ Waiting for transaction confirmation...');
      receiveMessageTx = await aptosClient.waitForTransaction({
        transactionHash: pendingTxn.hash,
      });

      console.log(`✅ CCTP completion successful: ${receiveMessageTx.hash}`);
    } catch (error) {
      // Check if this is a "nonce already used" error (transaction already processed)
      if (error.message && error.message.includes('ENONCE_ALREADY_USED')) {
        console.log('⚠️  Transaction already processed (nonce already used). This is normal for retries.');
        
        // Try to find the existing transaction hash from the error or return a placeholder
        const txHash = error.transaction?.hash || 'already_processed';
        
        // Try to create Payment record if it doesn't exist yet
        if (txHash !== 'already_processed') {
          try {
            console.log('📝 Checking/creating Payment record for already processed CCTP transaction...');
            
            // Check if payment record already exists
            const existingPayment = await prismaQuery.payment.findFirst({
              where: {
                txHash: txHash,
                linkId: linkId
              }
            });

            if (!existingPayment) {
              // Get or create USDC token cache
              const { getOrCreateAptosTokenCache } = await import('../utils/aptosUtils.js');
              const usdcAssetType = chainConfig.tokens?.find(t => t.symbol === 'USDC')?.address;
              const mintAddress = usdcAssetType || data.usdcAddress || '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832';
              
              const tokenCache = await getOrCreateAptosTokenCache(mintAddress, chain, aptosClient);
              
              if (tokenCache && tokenCache.id) {
                const timestamp = Math.floor(Date.now() / 1000);

                // Field mapping for Payment record (see AptosPayButton.tsx):
                // - ephemeralPubkey = ephPub (ephemeral public key, base58)
                // - memo = encryptedPayload (encrypted ephemeral private key, base58)
                // - note = encryptedNote (payment info ID, base58)
                // - label = encryptedLabel (link ID, base58)

                const ephemeralPubkey = ephPub || 'CCTP_BRIDGED';
                const memo = encryptedPayload || 'CCTP Bridge Transfer';

                const serializedLabel = encryptedLabel
                  ? (typeof encryptedLabel === 'string' ? encryptedLabel : JSON.stringify(encryptedLabel))
                  : linkId;
                const serializedNote = encryptedNote
                  ? (typeof encryptedNote === 'string' ? encryptedNote : JSON.stringify(encryptedNote))
                  : null;

                const paymentData = {
                  txHash: txHash,
                  chain: chain,
                  slot: timestamp,
                  timestamp: timestamp,
                  stealthOwnerPubkey: recipientAddress,
                  ephemeralPubkey: ephemeralPubkey, // Ephemeral public key (base58)
                  payerPubKey: 'CCTP_BRIDGE',
                  eventIndex: 0,
                  mintId: tokenCache.id,
                  amount: BigInt(attestation.amount || data.amount || '0'),
                  label: serializedLabel, // Encrypted label (link ID)
                  memo: memo, // Encrypted ephemeral private key (base58)
                  note: serializedNote, // Encrypted payment info ID (base58)
                  announce: true,
                  linkId: linkId,
                  isProcessed: true
                };

                // Link to payment info if provided
                if (paymentInfoId) {
                  paymentData.paymentInfo = {
                    connect: { id: paymentInfoId }
                  };
                }

                await prismaQuery.payment.create({
                  data: paymentData
                });
                console.log('✅ Payment record created for already processed transaction');
              }
            } else {
              console.log('ℹ️  Payment record already exists');
            }
          } catch (paymentError) {
            console.error('❌ Failed to create Payment record for already processed tx:', paymentError);
          }
        }
        
        return {
          transactionDigest: txHash,
          explorerUrl: `${chainConfig.explorerUrl}/txn/${txHash}?network=${isMainnet ? 'mainnet' : 'testnet'}`,
          success: true,
          alreadyProcessed: true
        };
      }
      // Re-throw other errors
      throw error;
    }

    // Build explorer URL
    const explorerUrl = `${chainConfig.explorerUrl}/txn/${receiveMessageTx.hash}?network=${isMainnet ? 'mainnet' : 'testnet'}`;

    // Create Payment record for CCTP transaction to log it as legitimate payment
    try {
      console.log('📝 Creating Payment record for CCTP transaction...');
      
      // Get or create USDC token cache
      const { getOrCreateAptosTokenCache } = await import('../utils/aptosUtils.js');
      
      // USDC asset type for Aptos
      const usdcAssetType = chainConfig.tokens?.find(t => t.symbol === 'USDC')?.address;
      if (!usdcAssetType) {
        console.warn('⚠️  USDC token not found in chain config, using usdcAddress from payload');
      }
      
      const mintAddress = usdcAssetType || data.usdcAddress || '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832';
      
      const tokenCache = await getOrCreateAptosTokenCache(
        mintAddress,
        chain,
        aptosClient
      );

      if (!tokenCache || !tokenCache.id) {
        console.error('❌ Failed to get or create token cache for USDC');
        throw new Error('Failed to get token cache for USDC');
      }

      // Parse encrypted payload to extract stealth payment details
      // For CCTP, recipientAddress is the stealth owner
      const stealthOwnerPubkey = recipientAddress;

      // IMPORTANT: Field mapping for Payment record (see AptosPayButton.tsx for reference):
      // - ephemeralPubkey (Payment table) = ephPub (ephemeral public key, base58)
      // - memo (Payment table) = encryptedPayload (encrypted ephemeral private key, base58)
      // - note (Payment table) = encryptedNote (payment info ID, base58)
      // - label (Payment table) = encryptedLabel (link ID, base58)

      const ephemeralPubkey = ephPub || 'CCTP_BRIDGED'; // Ephemeral public key
      const memo = encryptedPayload || 'CCTP Bridge Transfer'; // Encrypted ephemeral private key
      const payerPubKey = 'CCTP_BRIDGE'; // Default for CCTP transactions

      // Serialize label and note if they're objects (Buffer or Array)
      const label = encryptedLabel
        ? (typeof encryptedLabel === 'string' ? encryptedLabel : JSON.stringify(encryptedLabel))
        : linkId; // Fallback to linkId

      const note = encryptedNote
        ? (typeof encryptedNote === 'string' ? encryptedNote : JSON.stringify(encryptedNote))
        : null;

      // Get transaction details for slot and timestamp
      const txDetails = await aptosClient.getTransactionByHash({
        transactionHash: receiveMessageTx.hash
      });

      const timestamp = txDetails.timestamp 
        ? Math.floor(parseInt(txDetails.timestamp) / 1000000) 
        : Math.floor(Date.now() / 1000);

      // Create the payment record
      const paymentData = {
        txHash: receiveMessageTx.hash,
        chain: chain,
        slot: timestamp, // Using timestamp as slot for Aptos
        timestamp: timestamp,
        stealthOwnerPubkey: stealthOwnerPubkey,
        ephemeralPubkey: ephemeralPubkey, // Ephemeral public key (base58)
        payerPubKey: payerPubKey,
        eventIndex: 0,
        mintId: tokenCache.id,
        amount: BigInt(attestation.amount || data.amount || '0'),
        label: label, // Encrypted label (link ID)
        memo: memo, // Encrypted ephemeral private key (base58)
        note: note, // Encrypted payment info ID (base58)
        announce: true,
        linkId: linkId,
        isProcessed: true // CCTP transactions are immediately processed
      };

      // Link to payment info if provided
      if (paymentInfoId) {
        paymentData.paymentInfo = {
          connect: { id: paymentInfoId }
        };
      }

      const payment = await prismaQuery.payment.create({
        data: paymentData
      });

      console.log('✅ Payment record created:', payment.id);
    } catch (paymentError) {
      // Log the error but don't fail the CCTP transaction
      console.error('❌ Failed to create Payment record:', paymentError);
      console.error('   This does not affect the CCTP transaction completion');
    }

    console.log('✅ CCTP transaction completed successfully');
    console.log('   Destination TX:', receiveMessageTx.hash);
    console.log('   Explorer URL:', explorerUrl);

    return {
      transactionDigest: receiveMessageTx.hash,
      explorerUrl: explorerUrl,
      success: true
    };
  } else {
    throw new Error(`Unsupported chain: ${chain}`);
  }
}

/**
 * CCTP Routes
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */

export const cctpRoutes = (app, _, done) => {

  // Submit CCTP transaction for background processing with Turnstile protection
  app.post('/submit-cctp-tx', {
    preHandler: createTurnstileMiddleware('pay', 10) // 10 requests per minute
  }, async (request, reply) => {
    try {
      const chain = request.query.chain;
      console.log('Submitting CCTP transaction for chain:', chain);

      // Validate required base fields
      const baseRequiredFields = [
        'srcDomain',
        'srcTxHash',
        'amount',
        'attestation',
        'usdcAddress',
        'linkId'
      ];

      const validationResult = await validateRequiredFields(request.body, baseRequiredFields, reply);
      if (validationResult !== true) {
        return validationResult;
      }

      const {
        srcDomain,
        srcTxHash,
        amount,
        attestation,
        usdcAddress,
        linkId,
        paymentInfoId,
        ...chainSpecificData
      } = request.body;

      // Validate link exists
      const link = await prismaQuery.link.findUnique({
        where: { id: linkId }
      });

      if (!link) {
        return handleNotFoundError(reply, 'Link');
      }

      // Validate attestation structure - handle both pending and ready attestations
      if (!attestation || typeof attestation !== 'object') {
        return handleError(reply, 400, 'Invalid attestation structure', 'INVALID_ATTESTATION');
      }

      // For pending attestations, message and eventNonce might not be available yet
      if (attestation.attestation !== 'PENDING') {
        if (!attestation.message || !attestation.eventNonce) {
          return handleError(reply, 400, 'Invalid attestation structure: missing message or eventNonce for non-pending attestation', 'INVALID_ATTESTATION');
        }
      }

      // Validate hex strings
      if (!srcTxHash.startsWith('0x') || srcTxHash.length !== 66) {
        return handleError(reply, 400, 'Invalid source transaction hash format', 'INVALID_HASH_FORMAT');
      }

      // Chain-specific validation
      let chainSpecificFields = [];
      if (chain === 'APTOS_MAINNET' || chain === 'APTOS_TESTNET') {
        // Aptos-specific fields for CCTP
        chainSpecificFields = [
          'recipientAddress', // Aptos address to receive USDC (stealth address)
          'ephPub',           // Ephemeral public key (base58)
          'encryptedPayload', // Encrypted ephemeral private key (base58)
          'encryptedLabel',   // Encrypted label for linking (base58)
          // 'encryptedNote'     // Optional encrypted note (payment info ID, base58)
        ];
      } else {
        return handleError(reply, 400, 'Unsupported chain for CCTP processing', 'UNSUPPORTED_CHAIN');
      }

      // Validate chain-specific fields
      const chainValidationResult = await validateRequiredFields(chainSpecificData, chainSpecificFields, reply);
      if (chainValidationResult !== true) {
        return chainValidationResult;
      }

      // Create CCTP transaction record
      try {
        // Include paymentInfoId in chainSpecificData so it's available during completion
        const dataToStore = {
          ...chainSpecificData,
          paymentInfoId: paymentInfoId || null
        };

        // Get the destination chain's USDC address (not the source EVM address)
        let destUsdcAddress = usdcAddress; // Default to provided address
        
        // For Aptos chains, use the proper Aptos USDC address
        if (chain === 'APTOS_MAINNET' || chain === 'APTOS_TESTNET') {
          destUsdcAddress = '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832';
        }

        const cctpTransaction = await prismaQuery.cctpTransaction.create({
          data: {
            srcDomain: Number(srcDomain),
            srcTxHash: srcTxHash,
            amount: amount,
            attestation: JSON.stringify(attestation),
            usdcAddress: destUsdcAddress, // Store destination chain USDC address
            chain: chain,
            status: 'SUBMITTED',
            chainSpecificData: JSON.stringify(dataToStore),
            submittedAt: new Date(),
            link: {
              connect: { id: linkId }
            }
          }
        });

        console.log('CCTP transaction created:', cctpTransaction.id);

        // Transaction saved to database - CCTP worker will pick it up automatically
        console.log('✅ CCTP transaction saved to database, worker will process it automatically');

        return reply.send({
          success: true,
          message: 'CCTP transaction submitted for processing',
          transactionId: cctpTransaction.id,
          status: 'SUBMITTED'
        });

      } catch (error) {
        if (error.code === 'P2002') {
          // Unique constraint violation, transaction was likely submitted concurrently
          console.warn('CCTP transaction already exists due to race condition, fetching existing one.');
          const existingTransaction = await prismaQuery.cctpTransaction.findFirst({
            where: {
              srcTxHash: srcTxHash,
              linkId: linkId
            }
          });

          return reply.send({
            success: true,
            message: 'Transaction already submitted',
            transactionId: existingTransaction.id,
            status: existingTransaction.status
          });
        }
        // For other errors, re-throw to be caught by the general handler
        throw error;
      }

    } catch (error) {
      console.error('Error submitting CCTP transaction:', error);
      return handleError(reply, 500, 'Failed to submit CCTP transaction', 'CCTP_SUBMIT_ERROR', error);
    }
  });

  // Get CCTP transaction status
  app.get('/cctp-status/:transactionId', async (request, reply) => {
    try {
      const { transactionId } = request.params;

      const transaction = await prismaQuery.cctpTransaction.findUnique({
        where: { id: transactionId },
        include: {
          link: {
            include: {
              user: {
                select: {
                  username: true,
                }
              }
            }
          }
        }
      });

      if (!transaction) {
        return handleNotFoundError(reply, 'CCTP Transaction');
      }

      // Extract explorer URL from completion data if available
      let explorerUrl = null;
      try {
        const chainData = JSON.parse(transaction.chainSpecificData || '{}');
        explorerUrl = chainData.completionResult?.explorerUrl;
      } catch (e) {
        // Ignore parsing errors
      }

      return reply.send({
        success: true,
        transaction: {
          id: transaction.id,
          status: transaction.status,
          srcTxHash: transaction.srcTxHash,
          destTxHash: transaction.destTxHash,
          amount: transaction.amount,
          chain: transaction.chain,
          submittedAt: transaction.submittedAt,
          processedAt: transaction.processedAt,
          completedAt: transaction.completedAt,
          errorMessage: transaction.errorMessage,
          explorerUrl: explorerUrl,
          link: {
            id: transaction.link.id,
            label: transaction.link.label,
            tag: transaction.link.tag,
            user: {
              username: transaction.link.user.username,
            }
          }
        }
      });

    } catch (error) {
      console.error('Error getting CCTP transaction status:', error);
      return handleError(reply, 500, 'Failed to get transaction status', 'CCTP_STATUS_ERROR', error);
    }
  });

  app.post('/process-cctp-tx', async (request, reply) => {
    try {
      const chain = request.query.chain;
      console.log('chain params', chain)
      // Set up connection and provider
      const chainConfig = CHAINS[chain];
      console.log("🔍 Chain config:", chainConfig);
      if (!chainConfig) {
        return handleError(reply, 400, 'Invalid chain specified', 'INVALID_CHAIN');
      }

      // Handle Aptos Mainnet & Testnet
      if (chainConfig.id === "APTOS_MAINNET" || chainConfig.id === "APTOS_TESTNET") {
        // TODO: Implement Aptos CCTP completion logic
        return handleError(reply, 501, 'Aptos CCTP processing not yet implemented', 'NOT_IMPLEMENTED');
      }

      // Reject unsupported chains
      return handleError(reply, 400, 'Unsupported chain for CCTP processing', 'UNSUPPORTED_CHAIN');


    } catch (error) {
      return handleError(reply, 500, 'CCTP transfer failed', 'CCTP_ERROR', error, { logs: error.logs || [] });
    }
  });

  done();
}