/**
 * PIVY Stealth Address Helpers (Aptos)
 * ------------------------------------
 * secp256k1-based stealth address utilities for Aptos generalized auth.
 *
 * Key differences vs Sui:
 * - Aptos account address = sha3-256(AnyPublicKey_bytes || SingleKey_scheme)
 * - We instantiate a real Aptos Account (Secp256k1) from the derived stealth private key.
 *
 * Dependencies (package.json):
 * "@aptos-labs/ts-sdk": "^5.1.0",
 * "@noble/ciphers": "^2.0.0",
 * "@noble/hashes": "^1.8.0",
 * "@noble/secp256k1": "^1.7.2",
 * "bs58": "^6.0.0"
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { sha3_256 } from '@noble/hashes/sha3';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from '@noble/hashes/utils';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import bs58 from 'bs58';

import {
  Account,
  Secp256k1PrivateKey,
} from '@aptos-labs/ts-sdk';

// Deterministic Key Derivation Constants
const SPEND_CONTEXT = "PIVY Spend Authority | Deterministic Derivation";
const VIEW_CONTEXT = "PIVY View Authority | Deterministic Derivation";
const APTOS_DOMAIN = "PIVY | Deterministic Meta Keys | Aptos Network";

export default class PivyStealthAptos {
  // Encoding / utils
  toBytes(str) {
    return new TextEncoder().encode(str);
  }

  pad32(u8) {
    const out = new Uint8Array(32);
    out.set(u8.slice(0, 32));
    return out;
  }

  to32u8(raw) {
    if (raw instanceof Uint8Array) return raw.length === 32 ? raw : this.pad32(raw);
    if (typeof raw === 'string') {
      // hex without 0x
      const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
      if (/^[0-9a-fA-F]+$/.test(hex)) return Uint8Array.from(Buffer.from(hex, 'hex'));
      // base58 fallback (33B public keys or 32B priv)
      try { return bs58.decode(raw); } catch {
        console.error("Error decoding bs58 in to32u8()")
       }
    }
    if (raw?.type === 'Buffer') return Uint8Array.from(raw.data);
    throw new Error('Unsupported key format; expected 32-byte Uint8Array, hex, or base58.');
  }

  // Aptos address derivation for SingleKey Secp256k1 authentication
  // AuthenticationKey = sha3-256(AnyPublicKey_bytes || SingleKey_scheme)
  // AnyPublicKey_bytes = uleb128(1) || 0x41 || uncompressed_secp256k1_pubkey_65B
  // SingleKey_scheme = 2
  secp256k1PointToAptosAddress(compressed33) {
    // Convert to uncompressed format (65 bytes with 0x04 prefix)
    const pt = secp.Point.fromHex(compressed33);
    const uncompressed65 = pt.toRawBytes(false); // 0x04 || X(32) || Y(32)

    // Build AnyPublicKey bytes: uleb128(1) || length_byte(0x41) || secp256k1_pubkey(65 bytes)
    // This matches SDK's serialization format
    const anyPublicKeyBytes = new Uint8Array(1 + 1 + 65);
    anyPublicKeyBytes[0] = 0x01; // uleb128(1) for Secp256k1 variant
    anyPublicKeyBytes[1] = 0x41; // Length of Secp256k1PublicKey (65 = 0x41)
    anyPublicKeyBytes.set(uncompressed65, 2); // 65-byte uncompressed public key

    // Build final input: AnyPublicKey_bytes || SingleKey_scheme(2)
    const authKeyInput = new Uint8Array(anyPublicKeyBytes.length + 1);
    authKeyInput.set(anyPublicKeyBytes, 0);
    authKeyInput[anyPublicKeyBytes.length] = 0x02; // SingleKey scheme = 2

    const authKey = sha3_256(authKeyInput);
    return '0x' + Buffer.from(authKey).toString('hex');
  }

  // Crypto: ephemeral key encryption & memo encryption
  async encryptEphemeralPrivKey(ephPriv32, metaViewPubCompressed) {
    const ephPriv = this.to32u8(ephPriv32);
    const metaViewPub = this.to32u8(metaViewPubCompressed);
    const ephPub = secp.getPublicKey(ephPriv, true); // 33B

    const shared = secp.getSharedSecret(ephPriv, metaViewPub, true); // 33+1B
    const salt = sha256(ephPub);
    const key = hkdf(sha256, shared.slice(1), salt, 'ephemeral-key-encryption', 32);

    const plaintext = new Uint8Array([...ephPriv, ...ephPub]); // 32 + 33
    const nonce = randomBytes(12);
    const cipher = chacha20poly1305(key, nonce);
    const ct = cipher.encrypt(plaintext);
    return bs58.encode(new Uint8Array([...nonce, ...ct]));
  }

  async decryptEphemeralPrivKey(encodedPayloadB58OrBytes, metaViewPriv32, ephPubCompressed) {
    const metaViewPriv = this.to32u8(metaViewPriv32);
    const ephPub = this.to32u8(ephPubCompressed);

    let payloadU8;
    if (encodedPayloadB58OrBytes instanceof Uint8Array) payloadU8 = encodedPayloadB58OrBytes;
    else if (typeof encodedPayloadB58OrBytes === 'string') payloadU8 = bs58.decode(encodedPayloadB58OrBytes);
    else if (encodedPayloadB58OrBytes?.type === 'Buffer') payloadU8 = Uint8Array.from(encodedPayloadB58OrBytes.data);
    else throw new Error('encryptedPayload must be base58 string or Uint8Array');

    if (payloadU8.length < 28) throw new Error('Encrypted payload too short');

    const nonce = payloadU8.slice(0, 12);
    const ct = payloadU8.slice(12);

    const shared = secp.getSharedSecret(metaViewPriv, ephPub, true);
    const salt = sha256(ephPub);
    const key = hkdf(sha256, shared.slice(1), salt, 'ephemeral-key-encryption', 32);

    const cipher = chacha20poly1305(key, nonce);
    const pt = cipher.decrypt(ct);

    const ephPriv = pt.slice(0, 32);
    const pubRecv = pt.slice(32);
    const pubCalc = secp.getPublicKey(ephPriv, true);
    if (!pubRecv.every((b, i) => b === pubCalc[i])) throw new Error('Ephemeral public key mismatch');
    return ephPriv;
  }

  async encryptNote(plaintext, ephPriv32, metaViewPubCompressed) {
    const ephPriv = this.to32u8(ephPriv32);
    const metaViewPub = this.to32u8(metaViewPubCompressed);
    const ephPub = secp.getPublicKey(ephPriv, true);

    const shared = secp.getSharedSecret(ephPriv, metaViewPub, true);
    const salt = sha256(ephPub);
    const key = hkdf(sha256, shared.slice(1), salt, 'memo-encryption', 32);

    const nonce = randomBytes(12);
    const cipher = chacha20poly1305(key, nonce);
    const ct = cipher.encrypt(this.toBytes(plaintext));
    return new Uint8Array([...nonce, ...ct]);
  }

  async decryptNote(encryptedBytes, ephPubCompressed, metaViewPriv32) {
    const ephPub = this.to32u8(ephPubCompressed);
    const metaViewPriv = this.to32u8(metaViewPriv32);

    const nonce = encryptedBytes.slice(0, 12);
    const ct = encryptedBytes.slice(12);

    const shared = secp.getSharedSecret(metaViewPriv, ephPub, true);
    const salt = sha256(ephPub);
    const key = hkdf(sha256, shared.slice(1), salt, 'memo-encryption', 32);

    const cipher = chacha20poly1305(key, nonce);
    const pt = cipher.decrypt(ct);
    return new TextDecoder().decode(pt);
  }

  // Stealth address derivation
  async deriveStealthPub(metaSpendPubB58, metaViewPubB58, ephPriv32) {
    const shared = secp.getSharedSecret(this.to32u8(ephPriv32), this.to32u8(metaViewPubB58), true);
    const tweak = sha256(shared.slice(1));

    const tweakScalar = secp.utils.mod(
      BigInt('0x' + Buffer.from(tweak).toString('hex')),
      secp.CURVE.n
    );

    // Derive stealth public key: metaSpendPub + tweak*G
    const tweakPoint = secp.Point.BASE.multiply(tweakScalar);
    const metaSpendPoint = secp.Point.fromHex(this.to32u8(metaSpendPubB58));
    const stealthPoint = metaSpendPoint.add(tweakPoint);

    const stealthPubBytes = stealthPoint.toRawBytes(true); // compressed
    const stealthAptosAddress = this.secp256k1PointToAptosAddress(stealthPubBytes);

    return {
      stealthPubKeyB58: bs58.encode(stealthPubBytes),
      stealthAptosAddress,
      stealthPubKeyBytes: stealthPubBytes,
    };
  }

  async deriveStealthKeypair(metaSpendPriv32, metaViewPriv32, ephPubCompressedB58OrU8) {
    const shared = secp.getSharedSecret(
      this.to32u8(metaViewPriv32),
      this.to32u8(ephPubCompressedB58OrU8),
      true
    );
    const tweak = sha256(shared.slice(1));

    const tweakScalar = secp.utils.mod(
      BigInt('0x' + Buffer.from(tweak).toString('hex')),
      secp.CURVE.n
    );

    const spendPriv = this.to32u8(metaSpendPriv32);
    const spendScalar = secp.utils.mod(
      BigInt('0x' + Buffer.from(spendPriv).toString('hex')),
      secp.CURVE.n
    );

    const stealthScalar = secp.utils.mod(spendScalar + tweakScalar, secp.CURVE.n);
    const stealthHex = stealthScalar.toString(16).padStart(64, '0');
    const stealthPrivBytes = Uint8Array.from(Buffer.from(stealthHex, 'hex'));

    // Construct a real Aptos Secp256k1 account for signing transactions
    const stealthAccount = Account.fromPrivateKey({
      privateKey: new Secp256k1PrivateKey(stealthPrivBytes),
    });

    return {
      stealthPrivBytes,
      stealthAccount,
      stealthAddress: stealthAccount.accountAddress.toStringLong(),
      publicKeyBase58: () => bs58.encode(secp.getPublicKey(stealthPrivBytes, true)),
    };
  }

  // Key generation (secp256k1 meta & ephemeral)
  generateMetaKeys() {
    const metaSpendPriv = secp.utils.randomPrivateKey();
    const metaViewPriv = secp.utils.randomPrivateKey();

    const spendPub = secp.getPublicKey(metaSpendPriv, true);
    const viewPub = secp.getPublicKey(metaViewPriv, true);

    return {
      metaSpend: { privateKey: metaSpendPriv, publicKey: spendPub },
      metaView: { privateKey: metaViewPriv, publicKey: viewPub },
      metaSpendPubB58: bs58.encode(spendPub),
      metaViewPubB58: bs58.encode(viewPub),
    };
  }

  /**
   * Generate deterministic meta keys from a seed (e.g., wallet signature)
   * Same seed will ALWAYS produce the same keys
   * Uses domain separation and context-specific derivation for security
   *
   * @param {string} seed - Seed string (later will be signature from main wallet)
   * @returns {Object} Meta keys with spend and view keypairs
   */
  generateDeterministicMetaKeys(seed) {
    const seedBytes = this.toBytes(seed);
    // Use domain separator as salt for additional security
    const domainSalt = this.toBytes(APTOS_DOMAIN);
    // Derive two independent 32-byte keys using HKDF with specific contexts
    // HKDF(hash, ikm, salt, info, length)
    const metaSpendPriv = hkdf(sha256, seedBytes, domainSalt, SPEND_CONTEXT, 32);
    const metaViewPriv = hkdf(sha256, seedBytes, domainSalt, VIEW_CONTEXT, 32);

    // Ensure keys are valid secp256k1 private keys (< curve order)
    const spendScalar = secp.utils.mod(
      BigInt('0x' + Buffer.from(metaSpendPriv).toString('hex')),
      secp.CURVE.n
    );
    const viewScalar = secp.utils.mod(
      BigInt('0x' + Buffer.from(metaViewPriv).toString('hex')),
      secp.CURVE.n
    );

    const spendPrivFinal = Uint8Array.from(
      Buffer.from(spendScalar.toString(16).padStart(64, '0'), 'hex')
    );
    const viewPrivFinal = Uint8Array.from(
      Buffer.from(viewScalar.toString(16).padStart(64, '0'), 'hex')
    );

    const spendPub = secp.getPublicKey(spendPrivFinal, true);
    const viewPub = secp.getPublicKey(viewPrivFinal, true);

    return {
      metaSpend: { privateKey: spendPrivFinal, publicKey: spendPub },
      metaView: { privateKey: viewPrivFinal, publicKey: viewPub },
      metaSpendPubB58: bs58.encode(spendPub),
      metaViewPubB58: bs58.encode(viewPub),
      seed, // Include seed for reference
    };
  }

  generateEphemeralKey() {
    const priv = secp.utils.randomPrivateKey();
    const pub = secp.getPublicKey(priv, true);
    return { privateKey: priv, publicKeyB58: bs58.encode(pub) };
  }

  validateStealthMatch(payerAddress, receiverAddress) {
    return payerAddress.toLowerCase() === receiverAddress.toLowerCase();
  }

  // Static shims
  static to32u8(raw) { return new PivyStealthAptos().to32u8(raw); }
  static pad32(u8) { return new PivyStealthAptos().pad32(u8); }
  static toBytes(s) { return new PivyStealthAptos().toBytes(s); }
  static secp256k1PointToAptosAddress(point) { return new PivyStealthAptos().secp256k1PointToAptosAddress(point); }
  static async deriveStealthPub(...a) { return new PivyStealthAptos().deriveStealthPub(...a); }
  static async deriveStealthKeypair(...a) { return new PivyStealthAptos().deriveStealthKeypair(...a); }
  static async encryptNote(...a) { return new PivyStealthAptos().encryptNote(...a); }
  static async decryptNote(...a) { return new PivyStealthAptos().decryptNote(...a); }
  static async encryptEphemeralPrivKey(...a) { return new PivyStealthAptos().encryptEphemeralPrivKey(...a); }
  static async decryptEphemeralPrivKey(...a) { return new PivyStealthAptos().decryptEphemeralPrivKey(...a); }
  static generateMetaKeys() { return new PivyStealthAptos().generateMetaKeys(); }
  static generateDeterministicMetaKeys(seed) { return new PivyStealthAptos().generateDeterministicMetaKeys(seed); }
  static generateEphemeralKey() { return new PivyStealthAptos().generateEphemeralKey(); }
  static validateStealthMatch(a, b) { return new PivyStealthAptos().validateStealthMatch(a, b); }
}
