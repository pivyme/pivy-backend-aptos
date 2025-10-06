import PivyStealthAptos from "../../../lib/pivy-stealth/pivy-stealth-aptos.js";
import { prismaQuery } from "../../../lib/prisma.js";
import { shouldProcess, markProcessComplete, markProcessAttempt, getUnprocessedItems } from "../../../utils/processingLogUtils.js";
import bs58 from 'bs58';

/**
 * Process a payment transaction to identify the owner and link to user
 * @param {Object} params - Parameters
 * @param {string} params.txHash - Transaction hash
 * @param {Array} params.users - Array of users with meta keys
 * @param {Uint8Array|null} params.encryptedNote - Encrypted note bytes
 * @param {string|null} params.encryptedLabel - Encrypted label (base58 or bytes)
 * @param {number|null} params.eventIndex - Event index in transaction
 * @param {string|null} params.stealthOwnerPubkey - Stealth address
 * @param {string|null} params.ephemeralPubkey - Ephemeral public key (base58)
 * @returns {Promise<Object|null>} Processing result with link info
 */
export const processAptosPaymentTx = async ({
  txHash,
  users,
  encryptedNote = null,
  encryptedLabel = null,
  eventIndex = null,
  stealthOwnerPubkey = null,
  ephemeralPubkey = null
}) => {
  try {
    // Basic input validation
    if (!txHash || typeof txHash !== 'string' || txHash.trim().length === 0) {
      return null;
    }

    // Build where condition to find the specific payment
    let whereCondition = { txHash: txHash };

    // If specific identifiers are provided, use them to find the exact payment
    if (eventIndex !== null && stealthOwnerPubkey && ephemeralPubkey) {
      whereCondition = {
        txHash: txHash,
        eventIndex: eventIndex,
        stealthOwnerPubkey: stealthOwnerPubkey,
        ephemeralPubkey: ephemeralPubkey
      };
    }

    const paymentTx = await prismaQuery.payment.findFirst({
      where: whereCondition
    });

    if (!paymentTx) {
      return null;
    }

    // If users not provided, get them from UserWallet table
    if (!users) {
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

      users = userWallets.map(wallet => ({
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
    }

    if (!users || users.length === 0) {
      return null;
    }

    const pivy = new PivyStealthAptos();
    let owner, link, decryptedLabel = null;

    for (const u of users) {
      const wallet = u.activeWallet;
      if (!wallet || !wallet.metaViewPriv || !wallet.metaSpendPub || !wallet.metaViewPub) {
        continue;
      }

      try {
        // Decrypt the ephemeral private key from the memo field
        if (!paymentTx.memo) {
          continue;
        }

        // Safe base58 decoding
        let memoBytes;
        try {
          memoBytes = bs58.decode(paymentTx.memo);
        } catch (error) {
          console.log('Invalid base58 memo for user:', u.id, error.message);
          continue;
        }

        const decryptedEphPriv = await pivy.decryptEphemeralPrivKey(
          memoBytes,
          wallet.metaViewPriv,
          paymentTx.ephemeralPubkey
        );

        // Derive the stealth address
        const stealthPub = await pivy.deriveStealthPub(
          wallet.metaSpendPub,
          wallet.metaViewPub,
          decryptedEphPriv
        );

        if (stealthPub.stealthAptosAddress === paymentTx.stealthOwnerPubkey) {
          owner = u;

          // Try to decrypt encrypted note if it exists
          let decryptedNote = null;
          if (encryptedNote) {
            try {
              const encryptedNoteBytes = encryptedNote instanceof Uint8Array
                ? encryptedNote
                : bs58.decode(encryptedNote);
              decryptedNote = await pivy.decryptNote(
                encryptedNoteBytes,
                paymentTx.ephemeralPubkey,
                wallet.metaViewPriv
              );
              console.log('Decrypted private note:', decryptedNote);
            } catch (noteError) {
              console.log('Failed to decrypt note:', noteError.message);
            }
          }

          // Try to decrypt encrypted label if it exists
          if (encryptedLabel) {
            try {
              const encryptedLabelBytes = encryptedLabel instanceof Uint8Array
                ? encryptedLabel
                : bs58.decode(encryptedLabel);
              decryptedLabel = await pivy.decryptNote(
                encryptedLabelBytes,
                paymentTx.ephemeralPubkey,
                wallet.metaViewPriv
              );
              console.log('Decrypted label:', decryptedLabel);
            } catch (labelError) {
              console.log('Failed to decrypt label:', labelError.message);
              decryptedLabel = paymentTx.label;
            }
          } else {
            decryptedLabel = paymentTx.label;
          }

          // Store the decrypted note and label in the database
          const updateData = {};
          if (decryptedNote) {
            updateData.note = decryptedNote;
          }
          if (decryptedLabel && decryptedLabel !== paymentTx.label) {
            updateData.label = decryptedLabel;
          }

          if (Object.keys(updateData).length > 0) {
            await prismaQuery.payment.update({
              where: { id: paymentTx.id },
              data: updateData
            }).catch(err => {
              console.log('Error storing decrypted data:', err);
            });
          }

          // Check if the decrypted note matches a PaymentInfo ID
          if (decryptedNote) {
            try {
              const paymentInfo = await prismaQuery.paymentInfo.findUnique({
                where: { id: decryptedNote.trim() }
              });

              if (paymentInfo) {
                await prismaQuery.paymentInfo.update({
                  where: { id: decryptedNote.trim() },
                  data: { paymentId: paymentTx.id }
                }).catch(err => {
                  console.log('Error linking PaymentInfo to payment:', err);
                });
                console.log('Successfully linked PaymentInfo', decryptedNote.trim(), 'to payment', paymentTx.id);
              }
            } catch (linkError) {
              console.log('Error checking PaymentInfo linkage:', linkError.message);
            }
          }

          break;
        }
      } catch (error) {
        console.log('Error processing user keys:', error.message);
        continue;
      }
    }

    if (!owner) {
      return null;
    }

    // Try to find link by decrypted label
    if (decryptedLabel) {
      try {
        link = await prismaQuery.link.findUnique({
          where: { id: decryptedLabel }
        });
      } catch (error) {
        console.log('Error finding link by label:', error.message);
      }
    }

    // Update payment with owner information
    await prismaQuery.payment.update({
      where: { id: paymentTx.id },
      data: {
        ...(link && { link: { connect: { id: link.id } } })
      }
    }).catch(err => {
      console.log('Error updating payment with link:', err);
    });

    console.log('Successfully processed payment for user:', owner.id, 'link:', link?.id || 'N/A');
    return { owner, link };

  } catch (error) {
    console.log('Error in processAptosPaymentTx:', error);
    return null;
  }
};

/**
 * Process a withdrawal transaction to identify the user
 * @param {Object} params - Parameters
 * @param {string} params.txHash - Transaction hash
 * @returns {Promise<Object|null>} Processing result with user info
 */
export const processAptosWithdrawalTx = async ({ txHash }) => {
  try {
    if (!txHash || typeof txHash !== 'string' || txHash.trim().length === 0) {
      return null;
    }

    const withdrawals = await prismaQuery.withdrawal.findMany({
      where: { txHash: txHash }
    });

    if (!withdrawals || withdrawals.length === 0) {
      return null;
    }

    // Get all users with Aptos wallets
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

    if (!users || users.length === 0) {
      return null;
    }

    const pivy = new PivyStealthAptos();
    let userId = null;
    let destinationUserId = null;

    for (const withdrawal of withdrawals) {
      const compositeKey = `${withdrawal.txHash}_${withdrawal.stealthOwnerPubkey}_${withdrawal.mintId}`;

      // Check if we should process this withdrawal for user ID
      if (!(await shouldProcess(compositeKey, 'WITHDRAWAL_USER_ID_SCAN'))) {
        continue;
      }

      await markProcessAttempt(compositeKey, 'WITHDRAWAL_USER_ID_SCAN');

      // Find payment for this stealth address to get ephemeral key
      const payment = await prismaQuery.payment.findFirst({
        where: {
          stealthOwnerPubkey: withdrawal.stealthOwnerPubkey,
          chain: withdrawal.chain
        },
        orderBy: { timestamp: 'desc' }
      });

      if (!payment || !payment.memo || !payment.ephemeralPubkey) {
        continue;
      }

      // Try to match with users
      for (const u of users) {
        const wallet = u.activeWallet;
        if (!wallet || !wallet.metaViewPriv || !wallet.metaSpendPub || !wallet.metaViewPub) {
          continue;
        }

        try {
          const memoBytes = bs58.decode(payment.memo);
          const decryptedEphPriv = await pivy.decryptEphemeralPrivKey(
            memoBytes,
            wallet.metaViewPriv,
            payment.ephemeralPubkey
          );

          const stealthPub = await pivy.deriveStealthPub(
            wallet.metaSpendPub,
            wallet.metaViewPub,
            decryptedEphPriv
          );

          if (stealthPub.stealthAptosAddress === withdrawal.stealthOwnerPubkey) {
            userId = u.id;

            // Update withdrawal with user
            await prismaQuery.withdrawal.update({
              where: {
                txHash_stealthOwnerPubkey_mintId: {
                  txHash: withdrawal.txHash,
                  stealthOwnerPubkey: withdrawal.stealthOwnerPubkey,
                  mintId: withdrawal.mintId
                }
              },
              data: {
                user: { connect: { id: userId } },
                isProcessed: true
              }
            }).catch(err => {
              console.log('Error updating withdrawal with user:', err);
            });

            console.log('Linked withdrawal to user:', userId);
            await markProcessComplete(compositeKey, 'WITHDRAWAL_USER_ID_SCAN');
            break;
          }
        } catch (error) {
          console.log('Error matching withdrawal to user:', error.message);
          continue;
        }
      }

      // Process destination user ID
      if (!(await shouldProcess(compositeKey, 'WITHDRAWAL_DESTINATION_USER_ID_SCAN'))) {
        continue;
      }

      await markProcessAttempt(compositeKey, 'WITHDRAWAL_DESTINATION_USER_ID_SCAN');

      // Check if destination is a stealth address
      const destinationPayment = await prismaQuery.payment.findFirst({
        where: {
          stealthOwnerPubkey: withdrawal.destinationPubkey,
          chain: withdrawal.chain
        },
        include: { link: true }
      });

      if (destinationPayment && destinationPayment.link) {
        destinationUserId = destinationPayment.link.userId;

        await prismaQuery.withdrawal.update({
          where: {
            txHash_stealthOwnerPubkey_mintId: {
              txHash: withdrawal.txHash,
              stealthOwnerPubkey: withdrawal.stealthOwnerPubkey,
              mintId: withdrawal.mintId
            }
          },
          data: {
            destinationUser: { connect: { id: destinationUserId } }
          }
        }).catch(err => {
          console.log('Error updating withdrawal with destination user:', err);
        });

        console.log('Linked withdrawal destination to user:', destinationUserId);
      }

      await markProcessComplete(compositeKey, 'WITHDRAWAL_DESTINATION_USER_ID_SCAN');
    }

    return { userId, destinationUserId };

  } catch (error) {
    console.log('Error in processAptosWithdrawalTx:', error);
    return null;
  }
};

/**
 * Reprocess user ID scans for unlinked payments and withdrawals
 */
export const reprocessUserIdScans = async () => {
  try {
    const chainId = process.env.CHAIN === 'MAINNET' ? 'APTOS_MAINNET' : 'APTOS_TESTNET';

    // Get unlinked items (second parameter is limit, not chain)
    const unprocessedPayments = await getUnprocessedItems('PAYMENT_PAYER_USER_ID_SCAN', 50);
    const unprocessedWithdrawals = await getUnprocessedItems('WITHDRAWAL_USER_ID_SCAN', 50);
    const unprocessedDestinations = await getUnprocessedItems('WITHDRAWAL_DESTINATION_USER_ID_SCAN', 50);

    console.log(`Reprocessing ${unprocessedPayments.length} payments, ${unprocessedWithdrawals.length} withdrawals`);

    // Reprocess payments - processId is directly the string, not an object
    for (const processId of unprocessedPayments.slice(0, 20)) {
      const parts = processId.split('_');
      if (parts.length >= 4) {
        const txHash = parts.slice(0, -3).join('_');
        await processAptosPaymentTx({ txHash });
      }
    }

    // Reprocess withdrawals - processId is directly the string, not an object
    for (const processId of unprocessedWithdrawals.slice(0, 20)) {
      const parts = processId.split('_');
      if (parts.length >= 3) {
        const txHash = parts.slice(0, -2).join('_');
        await processAptosWithdrawalTx({ txHash });
      }
    }

  } catch (error) {
    console.error('Error in reprocessUserIdScans:', error);
  }
};
