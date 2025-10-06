import axios from 'axios';

const APTOS_INDEXER_URL = 'https://api.mainnet.aptoslabs.com/v1/graphql';
const APTOS_TESTNET_INDEXER_URL = 'https://api.testnet.aptoslabs.com/v1/graphql';

/**
 * Search Aptos Name Service by domain
 * @param {string} domain - The domain to search for (e.g., "example.apt")
 * @param {boolean} isTestnet - Whether to use testnet or mainnet
 * @returns {Promise<{domain: string, subdomain: string|null, registered_address: string}|null>}
 */
export async function searchANSByDomain(domain, isTestnet = false) {
  const url = isTestnet ? APTOS_TESTNET_INDEXER_URL : APTOS_INDEXER_URL;

  try {
    const response = await axios.post(url, {
      query: `
        query getNameFromDomain($domain: String!) {
          current_aptos_names(
            where: {
              domain: { _eq: $domain }
              is_active: { _eq: true }
            }
            order_by: [
              { is_primary: desc }
              { last_transaction_version: desc }
              { expiration_timestamp: desc }
            ]
            limit: 1
          ) {
            domain
            subdomain
            registered_address
          }
        }
      `,
      variables: { domain }
    });

    console.log('ANS search response:', response.data);
    const names = response.data?.data?.current_aptos_names || [];
    return names.length > 0 ? names[0] : null;
  } catch (error) {
    console.error('ANS search error:', error);
    return null;
  }
}

/**
 * Get primary ANS for address
 * @param {string} address - The Aptos address
 * @param {boolean} isTestnet - Whether to use testnet or mainnet
 * @returns {Promise<{domain: string, subdomain: string|null, registered_address: string}|null>}
 */
export async function getPrimaryANSForAddress(address, isTestnet = false) {
  const url = isTestnet ? APTOS_TESTNET_INDEXER_URL : APTOS_INDEXER_URL;

  try {
    const response = await axios.post(url, {
      query: `
        query getNameFromAddress($registered_address: String) {
          current_aptos_names(
            where: {
              registered_address: { _eq: $registered_address }
              is_active: { _eq: true }
            }
            order_by: [
              { is_primary: desc }
              { last_transaction_version: desc }
              { expiration_timestamp: desc }
            ]
            limit: 1
          ) {
            domain
            subdomain
            registered_address
          }
        }
      `,
      variables: { registered_address: address }
    });

    const names = response.data?.data?.current_aptos_names || [];
    return names.length > 0 ? names[0] : null;
  } catch (error) {
    console.error('ANS lookup error:', error);
    return null;
  }
}

/**
 * Validate Aptos address format
 * @param {string} address - The address to validate
 * @returns {boolean}
 */
export function validateAptosAddress(address) {
  if (!address || typeof address !== 'string') return false;

  // Aptos addresses are hex with 0x prefix, can be 1-64 characters after 0x
  const aptosAddressRegex = /^0x[a-fA-F0-9]{1,64}$/;
  return aptosAddressRegex.test(address);
}

/**
 * Normalize Aptos address to full 64-character format
 * @param {string} address - The address to normalize
 * @returns {string}
 */
export function normalizeAptosAddress(address) {
  if (!address || !address.startsWith('0x')) return address;

  // Remove 0x prefix
  const hex = address.slice(2);

  // Pad to 64 characters
  const padded = hex.padStart(64, '0');

  return `0x${padded}`;
}
