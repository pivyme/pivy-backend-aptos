import { CHAINS, GAS_SPONSORSHIP } from "../config.js";
import { handleError } from "../utils/errorHandler.js";
import { validateRequiredFields } from "../utils/validationUtils.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { sleep, getAlphanumericId } from "../utils/miscUtils.js";
import { prismaQuery } from "../lib/prisma.js";
import { validatePaymentInfoData } from "./payRoutes.js";
import bs58 from "bs58";

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const txRoutes = (app, _, done) => {
  // Aptos Withdrawal Endpoint
  app.post("/prepare-aptos-withdrawal", {
    preHandler: [authMiddleware]
  }, async (request, reply) => {
    try {
      const validationResult = await validateRequiredFields(request.body,
        ["chain", "recipient", "token", "withdrawals"], reply);
      if (validationResult !== true) return validationResult;

      const { chain, recipient, token: coinType, withdrawals } = request.body;

      if (!Array.isArray(withdrawals) || withdrawals.length === 0) {
        return handleError(reply, 400, "withdrawals must be a non-empty array", "BAD_ITEMS");
      }
      if (withdrawals.length > 100) {
        return handleError(reply, 400, "withdrawals must be less than 100", "BAD_ITEMS");
      }

      const chainConfig = CHAINS[chain];
      if (!chainConfig) return handleError(reply, 400, "Invalid chain", "INVALID_CHAIN");

      if (chainConfig.id !== "APTOS_MAINNET" && chainConfig.id !== "APTOS_TESTNET") {
        return handleError(reply, 400, "Chain not supported", "CHAIN_UNSUPPORTED");
      }

      const aptosSponsorship = GAS_SPONSORSHIP.APTOS;
      if (!aptosSponsorship.wallet) {
        return handleError(reply, 500, "Aptos fee payer not set", "FEE_PAYER_MISSING");
      }

      const { Aptos, AptosConfig, Network } = await import('@aptos-labs/ts-sdk');
      const network = chain === 'APTOS_TESTNET' ? Network.TESTNET : Network.MAINNET;
      const config = new AptosConfig({ network });
      const aptos = new Aptos(config);

      const sponsoredOutcomes = [];
      const feePayerAddress = aptosSponsorship.wallet.accountAddress.toString();

      for (let i = 0; i < withdrawals.length; i++) {
        const w = withdrawals[i];

        if (!w?.fromStealthAddress || !w?.amount) {
          return handleError(reply, 400, `Invalid withdrawal item at index ${i}`, "BAD_ITEM");
        }

        try {
          const totalWithdrawalAmount = BigInt(w.amount);
          const feeAmount = aptosSponsorship.FEE_BPS > 0
            ? (totalWithdrawalAmount * BigInt(aptosSponsorship.FEE_BPS) + 9999n) / 10000n
            : 0n;
          const recipientAmount = totalWithdrawalAmount - feeAmount;

          // Detect token type (CoinType vs FungibleAsset)
          const isNative = coinType === '0x1::aptos_coin::AptosCoin';

          // Fetch sender account info to get the correct sequence number
          const senderAccount = await aptos.getAccountInfo({ accountAddress: w.fromStealthAddress });

          // Build transaction
          const txBuilder = {
            sender: w.fromStealthAddress,
            withFeePayer: true,
            data: {
              function: isNative
                ? `${chainConfig.pivyStealthProgramId}::pivy_stealth::withdraw_coin`
                : `${chainConfig.pivyStealthProgramId}::pivy_stealth::withdraw`,
              typeArguments: isNative ? [coinType] : [],
              functionArguments: isNative
                ? [recipientAmount.toString(), recipient]
                : [coinType, recipientAmount.toString(), recipient],
            },
            options: {
              accountSequenceNumber: senderAccount.sequence_number,
            },
          };

          const transaction = await aptos.transaction.build.simple(txBuilder);

          // Sign with sponsor (fee payer)
          const feePayerAuth = await aptos.transaction.signAsFeePayer({
            signer: aptosSponsorship.wallet,
            transaction,
          });

          sponsoredOutcomes.push({
            ok: true,
            index: i,
            result: {
              transactionBytes: Buffer.from(transaction.bcsToBytes()).toString('base64'),
              feePayerAuthenticator: Buffer.from(feePayerAuth.bcsToBytes()).toString('base64'),
              feePayerAddress,
            }
          });
        } catch (e) {
          console.error(`Error preparing withdrawal at index ${i}:`, e);
          sponsoredOutcomes.push({
            ok: false,
            index: i,
            error: { code: "BUILD_ERROR", message: e.message }
          });
        }

        // Add small delay to avoid rate limiting
        if (i < withdrawals.length - 1) {
          await sleep(100);
        }
      }

      return reply.send({ chain: chainConfig.id, outcomes: sponsoredOutcomes });
    } catch (error) {
      console.error("Error preparing Aptos withdrawal:", error);
      return handleError(reply, 500, "Internal error", "INTERNAL");
    }
  });

  // Aptos Stealth Payment Endpoint (for username withdrawals)
  app.post("/prepare-aptos-stealth-payment", {
    preHandler: [authMiddleware]
  }, async (request, reply) => {
    try {
      const validationResult = await validateRequiredFields(request.body,
        ["chain", "fromAddress", "recipientUsername", "token", "amount"], reply);
      if (validationResult !== true) return validationResult;

      const { chain, fromAddress, recipientUsername, token: coinType, amount, paymentData = [] } = request.body;

      const chainConfig = CHAINS[chain];
      if (!chainConfig) return handleError(reply, 400, "Invalid chain", "INVALID_CHAIN");

      if (chainConfig.id !== "APTOS_MAINNET" && chainConfig.id !== "APTOS_TESTNET") {
        return handleError(reply, 400, "Chain not supported", "CHAIN_UNSUPPORTED");
      }

      // 1. Validate and save payment data if provided
      let paymentInfoId = null;
      if (paymentData && paymentData.length > 0) {
        const dataValidation = validatePaymentInfoData(paymentData);
        if (!dataValidation.isValid) {
          return handleError(reply, 400, 'Payment data validation failed', 'PAYMENT_DATA_INVALID', { errors: dataValidation.errors });
        }

        paymentInfoId = getAlphanumericId(16);
        const ipAddress = request.ip || request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || 'unknown';
        const userAgent = request.headers['user-agent'] || null;

        await prismaQuery.paymentInfo.create({
          data: {
            id: paymentInfoId,
            collectedData: paymentData,
            ipAddress: Array.isArray(ipAddress) ? ipAddress[0] : ipAddress,
            userAgent: userAgent?.substring(0, 500) || null
          }
        });
      }

      // 2. Fetch recipient user data
      const recipient = await prismaQuery.user.findUnique({
        where: { username: recipientUsername },
        include: { wallets: true }
      });

      if (!recipient) {
        return handleError(reply, 404, "Recipient user not found", "RECIPIENT_NOT_FOUND");
      }

      const recipientWallet = recipient.wallets.find(w => w.chain === 'APTOS' && w.metaSpendPub && w.metaViewPub);
      if (!recipientWallet) {
        return handleError(reply, 404, "Recipient does not have an APTOS wallet configured for stealth payments", "RECIPIENT_WALLET_NOT_FOUND");
      }

      const { metaSpendPub, metaViewPub } = recipientWallet;

      // 3. Perform cryptographic operations
      const PivyStealthAptos = (await import('../lib/pivy-stealth/pivy-stealth-aptos.js')).default;
      const pivy = new PivyStealthAptos();

      const ephemeral = pivy.generateEphemeralKey();
      const stealthAddress = await pivy.deriveStealthPub(metaSpendPub, metaViewPub, ephemeral.privateKey);
      const encryptedMemo = await pivy.encryptEphemeralPrivKey(ephemeral.privateKey, metaViewPub);

      // Encrypt the paymentInfoId as the note (if payment data was provided)
      let encryptedNote = new Uint8Array(0);
      if (paymentInfoId) {
        const noteResult = await pivy.encryptNote(paymentInfoId, ephemeral.privateKey, metaViewPub);
        encryptedNote = new Uint8Array(noteResult);
      }

      const labelStr = "personal"; // or use linkId if provided
      const labelBytes = pivy.pad32(pivy.toBytes(labelStr));

      const ephPubBytes = bs58.decode(ephemeral.publicKeyB58);
      const payloadBytes = bs58.decode(encryptedMemo); // Decode base58 to raw bytes

      if (payloadBytes.length > 121) {
        return handleError(reply, 400, `Payload too long: ${payloadBytes.length} bytes (max 121)`, "PAYLOAD_TOO_LONG");
      }
      if (labelBytes.length > 256) {
        return handleError(reply, 400, `Label too long: ${labelBytes.length} bytes (max 256)`, "LABEL_TOO_LONG");
      }
      if (encryptedNote.length > 256) {
        return handleError(reply, 400, `Note too long: ${encryptedNote.length} bytes (max 256)`, "NOTE_TOO_LONG");
      }

      // 4. Build transaction
      const { Aptos, AptosConfig, Network } = await import('@aptos-labs/ts-sdk');
      const network = chain === 'APTOS_TESTNET' ? Network.TESTNET : Network.MAINNET;
      const config = new AptosConfig({ network });
      const aptos = new Aptos(config);

      const isNative = coinType === '0x1::aptos_coin::AptosCoin';

      // Fetch sender account info to get the correct sequence number
      const senderAccount = await aptos.getAccountInfo({ accountAddress: fromAddress });

      const txBuilder = {
        sender: fromAddress,
        withFeePayer: true,
        data: {
          function: isNative
            ? `${chainConfig.pivyStealthProgramId}::pivy_stealth::pay_coin`
            : `${chainConfig.pivyStealthProgramId}::pivy_stealth::pay`,
          typeArguments: isNative ? [coinType] : [],
          functionArguments: isNative
            ? [
                stealthAddress.stealthAptosAddress,
                amount,
                Array.from(labelBytes),
                Array.from(ephPubBytes),
                Array.from(payloadBytes),
                Array.from(encryptedNote),
              ]
            : [
                stealthAddress.stealthAptosAddress,
                coinType,
                amount,
                Array.from(labelBytes),
                Array.from(ephPubBytes),
                Array.from(payloadBytes),
                Array.from(encryptedNote),
              ],
        },
        options: {
          accountSequenceNumber: senderAccount.sequence_number,
        },
      };

      const transaction = await aptos.transaction.build.simple(txBuilder);

      // 5. Sponsorship
      const aptosSponsorship = GAS_SPONSORSHIP.APTOS;
      if (!aptosSponsorship.wallet) {
        return handleError(reply, 500, "Aptos fee payer not set", "FEE_PAYER_MISSING");
      }

      const feePayerAuth = await aptos.transaction.signAsFeePayer({
        signer: aptosSponsorship.wallet,
        transaction,
      });

      const feePayerAddress = aptosSponsorship.wallet.accountAddress.toString();

      const sponsoredOutcome = {
        ok: true,
        result: {
          transactionBytes: Buffer.from(transaction.bcsToBytes()).toString('base64'),
          feePayerAuthenticator: Buffer.from(feePayerAuth.bcsToBytes()).toString('base64'),
          feePayerAddress,
        }
      };

      return reply.send({ chain: chainConfig.id, outcome: sponsoredOutcome });

    } catch (error) {
      console.error("Error preparing Aptos stealth payment:", error);
      return handleError(reply, 500, "Internal error", "INTERNAL");
    }
  });

  done();
}