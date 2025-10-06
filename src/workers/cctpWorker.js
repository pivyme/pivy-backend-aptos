import { prismaQuery } from '../lib/prisma.js';
import { retrieveAttestation } from '../routes/cctpRoutes.js';
import { logIndexerSpeedConfig } from '../utils/cronUtils.js';

/**
 * CCTP Background Worker Plugin for Fastify
 * Processes pending CCTP transactions reliably
 * Handles attestation polling and transaction completion
 */

// Get interval based on INDEXER_SPEED environment variable
const getWorkerInterval = () => {
  const indexerSpeed = process.env.INDEXER_SPEED || 'default';
  if (indexerSpeed === 'slow') {
    return 120000; // 2 minutes in slow mode
  }
  return 30000; // 30 seconds in default mode
};

// CCTP attestations typically take 13-20 minutes according to Circle docs
// With 30-second worker intervals, we need ~60-80 retries to cover 30-40 minutes
const MAX_RETRIES = 100; // Allow up to ~50 minutes of retries (100 * 30s)
const ATTESTATION_TIMEOUT_MINUTES = 60; // Hard timeout at 60 minutes

class CctpWorker {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
  }

  start() {
    if (this.isRunning) {
      console.log('CCTP Worker already running');
      return;
    }

    // Log indexer speed configuration
    logIndexerSpeedConfig();
    
    const interval = getWorkerInterval();
    console.log(`🚀 Starting CCTP Worker with ${interval}ms interval...`);
    this.isRunning = true;

    // Process immediately on start
    this.processTransactions();

    // Then process on interval
    this.intervalId = setInterval(() => {
      this.processTransactions();
    }, interval);
  }

  stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('🛑 Stopping CCTP Worker...');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async processTransactions() {
    if (!this.isRunning) return;

    try {
      console.log('🔄 CCTP Worker: Checking for pending transactions...');

      // Find transactions that need processing
      const pendingTransactions = await prismaQuery.cctpTransaction.findMany({
        where: {
          AND: [
            {
              status: {
                in: ['SUBMITTED', 'PROCESSING', 'ATTESTATION_PENDING']
              }
            },
            {
              retryCount: {
                lt: MAX_RETRIES
              }
            },
            {
              // Don't retry transactions that failed recently (exponential backoff)
              OR: [
                { lastRetryAt: null },
                {
                  lastRetryAt: {
                    lt: new Date(Date.now() - this.getBackoffDelay(0))
                  }
                }
              ]
            }
          ]
        },
        include: {
          link: true
        },
        orderBy: {
          submittedAt: 'asc' // Process oldest first
        }
      });

      if (pendingTransactions.length === 0) {
        console.log('✅ No pending CCTP transactions');
        return;
      }

      console.log(`📋 Found ${pendingTransactions.length} pending CCTP transactions`);

      // Process each transaction
      for (const transaction of pendingTransactions) {
        if (!this.isRunning) break; // Stop if worker was stopped

        try {
          await this.processTransaction(transaction);
        } catch (error) {
          console.error(`❌ Failed to process transaction ${transaction.id}:`, error);

          // Check if this is an attestation timeout (normal for CCTP) vs a real error
          const isAttestationTimeout = error.message.includes('expired after');
          const isAttestationPending = error.message.includes('Attestation still pending') || 
                                        error.message.includes('attestation not ready');

          // Only increment retry count for actual errors, not for pending attestations
          const shouldIncrementRetry = !isAttestationPending;

          // Update retry count and error
          await prismaQuery.cctpTransaction.update({
            where: { id: transaction.id },
            data: {
              retryCount: shouldIncrementRetry ? { increment: 1 } : transaction.retryCount,
              lastRetryAt: new Date(),
              errorMessage: error.message,
              // Only mark as FAILED if we hit max retries AND it's not just pending
              status: (transaction.retryCount + 1 >= MAX_RETRIES && !isAttestationPending) || isAttestationTimeout
                ? 'FAILED' 
                : transaction.status
            }
          });
        }
      }

    } catch (error) {
      console.error('💥 CCTP Worker error:', error);
    }
  }

  async processTransaction(transaction) {
    console.log(`🔧 Processing transaction ${transaction.id} (status: ${transaction.status})`);

    // Parse stored data
    const attestation = JSON.parse(transaction.attestation);
    const chainSpecificData = JSON.parse(transaction.chainSpecificData);

    // Check if transaction is too old
    const ageMinutes = (Date.now() - transaction.submittedAt.getTime()) / (1000 * 60);
    if (ageMinutes > ATTESTATION_TIMEOUT_MINUTES) {
      throw new Error(`Transaction expired after ${ATTESTATION_TIMEOUT_MINUTES} minutes`);
    }

    // Handle attestation if still pending
    let finalAttestation = attestation;
    if (attestation.attestation === 'PENDING' || !attestation.message || !attestation.eventNonce) {
      const elapsedMinutes = Math.floor(ageMinutes);
      console.log(`⏳ Transaction ${transaction.id}: Checking for attestation (elapsed: ${elapsedMinutes}/${ATTESTATION_TIMEOUT_MINUTES} minutes, retry: ${transaction.retryCount}/${MAX_RETRIES})`);
      console.log(`   ℹ️  CCTP attestations typically take 13-20 minutes`);

      await prismaQuery.cctpTransaction.update({
        where: { id: transaction.id },
        data: {
          status: 'ATTESTATION_PENDING',
          processedAt: new Date()
        }
      });

      try {
        finalAttestation = await retrieveAttestation(
          transaction.srcDomain,
          transaction.srcTxHash,
          transaction.chain, // Chain parameter (e.g., 'MAINNET', etc.)
          1 // Single attempt per worker cycle
        );

        console.log(`✅ Transaction ${transaction.id}: Attestation obtained after ${elapsedMinutes} minutes`);

        // Update with final attestation
        await prismaQuery.cctpTransaction.update({
          where: { id: transaction.id },
          data: {
            attestation: JSON.stringify(finalAttestation),
            status: 'PROCESSING'
          }
        });

      } catch (attestationError) {
        console.log(`⏳ Transaction ${transaction.id}: Attestation still pending after ${elapsedMinutes} minutes`);
        // Don't throw - just wait for next cycle
        return;
      }
    } else {
      // Attestation already available, move to completion
      console.log(`✅ Transaction ${transaction.id}: Attestation ready, proceeding to completion`);
      await prismaQuery.cctpTransaction.update({
        where: { id: transaction.id },
        data: { status: 'PROCESSING' }
      });
    }

    // Execute completion
    console.log(`🎯 Transaction ${transaction.id}: Executing completion...`);

    const { executeCctpCompletion } = await import('../routes/cctpRoutes.js');

    const processResult = await executeCctpCompletion({
      chain: transaction.chain,
      srcDomain: transaction.srcDomain,
      srcTxHash: transaction.srcTxHash,
      amount: transaction.amount,
      attestation: finalAttestation,
      usdcAddress: transaction.usdcAddress,
      linkId: transaction.linkId,
      ...chainSpecificData
    });

    // Mark as completed with proper result handling
    let destTxHash = null;
    let explorerUrl = null;

    if (processResult.transactionDigest) {
      destTxHash = processResult.transactionDigest;
      explorerUrl = processResult.explorerUrl;
    } else if (processResult.announceSignature) {
      destTxHash = processResult.announceSignature;
      explorerUrl = processResult.explorerUrls?.announce;
    } else if (processResult.receiveSignature) {
      destTxHash = processResult.receiveSignature;
      explorerUrl = processResult.explorerUrls?.receive;
    }

    await prismaQuery.cctpTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'COMPLETED',
        destTxHash: destTxHash,
        completedAt: new Date(),
        // Store explorer URL and other completion details in chainSpecificData if needed
        chainSpecificData: JSON.stringify({
          ...JSON.parse(transaction.chainSpecificData),
          completionResult: {
            explorerUrl,
            processResult: processResult
          }
        })
      }
    });

    console.log(`✅ Transaction ${transaction.id}: Completed successfully with destTxHash: ${destTxHash}`);
  }

  getBackoffDelay(retryCount) {
    // For CCTP attestations, we use minimal backoff since attestations
    // just need time to be processed (13-20 min typical), not exponential delays
    // Only use backoff for actual failures, not pending attestations
    const baseDelay = 5000; // 5 seconds - minimal delay for rate limiting
    const maxDelay = 60000; // Max 1 minute between retries
    const delay = Math.min(baseDelay * Math.pow(1.5, Math.min(retryCount, 10)), maxDelay);
    return delay;
  }
}

// Create singleton instance
const cctpWorker = new CctpWorker();

/**
 * Fastify plugin for CCTP Worker
 */
export const cctpWorkers = async function (fastify, options) {
  console.log('🔧 Registering CCTP Workers...');

  // Start the worker after server is ready
  fastify.addHook('onReady', async () => {
    console.log('🚀 Starting CCTP Worker...');
    cctpWorker.start();
  });

  // Stop the worker when server closes
  fastify.addHook('onClose', async () => {
    console.log('🛑 Stopping CCTP Worker...');
    cctpWorker.stop();
  });

  console.log('✅ CCTP Workers registered');
};