# API Documentation

## Auth Routes (`/auth`)

### GET `/auth/siwa/nonce`
Generate SIWA (Sign in with Aptos) nonce for authentication
- **Body**: None
- **Response**: `{ data: { nonce, domain, statement, uri, version, chainId } }`
- **Auth**: None
- **Rate Limit**: 20 requests per minute

### POST `/auth/siwa/callback`
Verify SIWA signature and authenticate user
- **Body**: `{ output: string, email?: string }`
- **Response**: `{ token, wallet: { id, chain, address, privyWalletId, loginMethod } }`
- **Auth**: None
- **Rate Limit**: 10 requests per minute

### POST `/auth/register-meta-keys` 🔒
Register meta keys for user wallets (batch operation)
- **Body**: `{ metaKeys: array }` where each metaKey has `{ chain, address, metaSpendPriv, metaSpendPub, metaViewPub, metaViewPriv }`
- **Response**: `{ message, updatedWallets, totalProcessed, successCount, errorCount, errors? }`
- **Auth**: Required
- **Rate Limit**: 10 requests per minute

### GET `/auth/me` 🔒
Get current user information with wallets and profile
- **Body**: None
- **Response**: Complete user object with wallets, profile image, and NFC tag
- **Auth**: Required
- **Rate Limit**: 120 requests per minute

### POST `/auth/me/switch-chain` 🔒
Switch to a different chain context for the user
- **Body**: `{ chain: string }` (must be "APTOS")
- **Response**: `{ message, token, currentWallet }`
- **Auth**: Required
- **Rate Limit**: 30 requests per minute

### POST `/auth/set-profile-image` 🔒
Set user's profile image (currently only supports EMOJI_AND_COLOR type)
- **Body**: `{ type: "EMOJI_AND_COLOR", data: { emoji, backgroundColor } }`
- **Response**: `{ message, profileImage }`
- **Auth**: Required
- **Rate Limit**: 10 requests per minute

---

## Address Routes (`/address`)

### GET `/address/:username/:tag/:chain`
Get chain-specific link data for a username/tag combination
- **Params**: `username`, `tag`, `chain` (APTOS_MAINNET|APTOS_TESTNET)
- **Body**: None
- **Response**: Chain-specific link data with payment information, amounts, and meta keys
- **Auth**: None
- **Rate Limit**: 60 requests per minute

### GET `/address/:username/:tag`
Get complete link data for all supported chains
- **Params**: `username`, `tag`
- **Body**: None
- **Response**: Multi-chain link data with fundraising stats, collected amounts, and chain configurations
- **Auth**: None
- **Rate Limit**: 60 requests per minute

### GET `/address/:username`
Get personal link data for a username (empty tag)
- **Params**: `username`
- **Body**: None
- **Response**: Personal link data for all supported chains
- **Auth**: None
- **Rate Limit**: 60 requests per minute

### GET `/address/link/:linkId`
Get link data by link ID (internal route for link retrieval)
- **Params**: `linkId`
- **Body**: None
- **Response**: Complete link data with user and chain information
- **Auth**: None
- **Rate Limit**: 100 requests per minute

### GET `/address/destination-search`
Search for destinations (usernames, SNS domains, addresses)
- **Query**: `q` (search query), `chain` (APTOS_MAINNET|APTOS_TESTNET)
- **Body**: None
- **Response**: `{ query, chain, results: array, count }`
- **Auth**: None
- **Rate Limit**: 30 requests per minute

---

## CCTP Routes (`/cctp`)

### POST `/cctp/submit-cctp-tx`
Submit CCTP transaction for background processing
- **Query**: `chain` (chain identifier)
- **Body**: Complex CCTP transaction data including attestation, amounts, and chain-specific data
- **Response**: `{ success, message, transactionId, status }`
- **Auth**: None (uses Turnstile captcha protection)
- **Rate Limit**: 10 requests per minute

### GET `/cctp/cctp-status/:transactionId`
Get CCTP transaction status and completion details
- **Params**: `transactionId`
- **Body**: None
- **Response**: Transaction status with completion data and explorer URLs
- **Auth**: None

### POST `/cctp/process-cctp-tx`
Legacy CCTP processing endpoint (marked as not implemented for Aptos)
- **Query**: `chain`
- **Body**: CCTP transaction data
- **Response**: Not implemented error
- **Auth**: None

---

## Link Routes (`/link`)

### POST `/link/create-link` 🔒
Create a new payment link
- **Query**: `chain` (DEVNET|MAINNET|SUI_TESTNET|SUI_MAINNET)
- **Body**: Form data with link configuration (type, name, slug, amountType, etc.)
- **Response**: Created link object
- **Auth**: Required
- **Rate Limit**: 5 requests per minute

### POST `/link/update-link/:linkId` 🔒
Update an existing link
- **Query**: `chain`
- **Body**: Form data with updated link configuration
- **Response**: Updated link object
- **Auth**: Required
- **Rate Limit**: 15 requests per minute

### GET `/link/:linkId` 🔒
Get detailed link information with activities
- **Params**: `linkId`
- **Query**: `limit` (default: 100)
- **Body**: None
- **Response**: Link data with payment activities and statistics
- **Auth**: Required
- **Rate Limit**: 60 requests per minute

### GET `/link/:linkId/activities` 🔒
Get payment activities for a specific link
- **Params**: `linkId`
- **Query**: `limit` (default: 100)
- **Body**: None
- **Response**: Array of payment activities for the link
- **Auth**: Required
- **Rate Limit**: 60 requests per minute

### GET `/link/my-links` 🔒
Get all user's active links with payment statistics
- **Body**: None
- **Response**: Array of user's links with payment stats
- **Auth**: Required

### POST `/link/archive-link/:linkId` 🔒
Archive a link (make inactive)
- **Params**: `linkId`
- **Body**: None
- **Response**: Archived link object
- **Auth**: Required

### POST `/link/unarchive-link/:linkId` 🔒
Unarchive a link (make active again)
- **Params**: `linkId`
- **Body**: None
- **Response**: Unarchived link object
- **Auth**: Required

### POST `/link/delete-link/:linkId` 🔒
Permanently delete a link
- **Params**: `linkId`
- **Body**: None
- **Response**: Success message
- **Auth**: Required

---

## File Routes (`/files`)

### GET `/files/file/:fileId/info`
Get file information and metadata
- **Params**: `fileId`
- **Body**: None
- **Response**: File metadata (id, filename, size, contentType, url, etc.)
- **Auth**: None
- **Rate Limit**: 30 requests per minute

### GET `/files/file/:fileId`
Access/download a file (redirects to S3 signed URL)
- **Params**: `fileId`
- **Body**: None
- **Response**: Redirect to signed S3 URL (1 hour expiration)
- **Auth**: None
- **Rate Limit**: 60 requests per minute

### POST `/files/upload/:linkId` 🔒
Upload files to an existing link
- **Params**: `linkId`
- **Body**: Multipart form data with files
- **Response**: Upload confirmation with file metadata
- **Auth**: Required
- **Rate Limit**: 20 requests per minute

### DELETE `/files/delete/:linkId/:fileType` 🔒
Delete a specific file type from a link
- **Params**: `linkId`, `fileType` (thumbnail, deliverableFile_1, etc.)
- **Body**: None
- **Response**: Deletion confirmation
- **Auth**: Required
- **Rate Limit**: 15 requests per minute

### GET `/files/metadata/:linkId` 🔒
Get file metadata for a link
- **Params**: `linkId`
- **Body**: None
- **Response**: File metadata including template info and file count
- **Auth**: Required
- **Rate Limit**: 30 requests per minute

---

## User Routes (`/user`)

### GET `/user/username/check`
Check if a username is available
- **Query**: `username`
- **Body**: None
- **Response**: `{ isAvailable: boolean }`
- **Auth**: None

### POST `/user/username/set` 🔒
Set username for the current user
- **Body**: `{ username: string }`
- **Response**: Updated user object
- **Auth**: Required

### GET `/user/balance/:address`
Get portfolio balance for a specific address
- **Params**: `address`
- **Query**: `chain` (MAINNET|DEVNET|SUI_MAINNET|SUI_TESTNET)
- **Body**: None
- **Response**: Portfolio with token balances and USD values
- **Auth**: None

### GET `/user/balance/stats` 🔒
Get balance statistics for user
- **Query**: `chain`
- **Body**: None
- **Response**: Balance statistics and analytics
- **Auth**: Required

### GET `/user/activities` 🔒
Get user activities (payments and withdrawals)
- **Query**: `chain`
- **Body**: None
- **Response**: Array of user activities
- **Auth**: Required

### GET `/user/balances` 🔒
Get aggregated balances for all user addresses
- **Query**: `chain`
- **Body**: None
- **Response**: Formatted balances with USD values
- **Auth**: Required

### POST `/user/balances/reconcile` 🔒
Reconcile user balances (admin/cache management)
- **Body**: Balance reconciliation parameters
- **Response**: Reconciliation results
- **Auth**: Required

### GET `/user/cache/stats` 🔒
Get cache statistics (admin endpoint)
- **Body**: None
- **Response**: Cache performance statistics
- **Auth**: Required

### POST `/user/cache/cleanup` 🔒
Clean up user cache (admin endpoint)
- **Body**: Cleanup parameters
- **Response**: Cleanup results
- **Auth**: Required

### POST `/user/aptos/withdrawal-group` 🔒
Create withdrawal group for Aptos transactions
- **Query**: `chain` (SUI_MAINNET|SUI_TESTNET)
- **Body**: `{ withdrawalId: string }`
- **Response**: Created withdrawal group
- **Auth**: Required

---

## Transaction Routes (`/tx`)

### POST `/tx/prepare-aptos-withdrawal` 🔒
Prepare sponsored withdrawal transaction from stealth address (legacy endpoint)
- **Body**: Withdrawal transaction parameters
- **Response**: Prepared transaction data
- **Auth**: Required

### POST `/tx/prepare-aptos-stealth-payment` 🔒
Prepare sponsored stealth payment transaction (legacy endpoint)
- **Body**: Stealth payment parameters
- **Response**: Prepared transaction data
- **Auth**: Required

---

## Pay Routes (`/pay`)

### POST `/pay/payment-info`
Prepare payment information for transaction notes
- **Body**: `{ paymentData: array }` with supported types: email, name, telegram_username, message
- **Response**: `{ success, message, data: { paymentInfoId, collectedFields, createdAt } }`
- **Auth**: None

### GET `/pay/payment-info`
Get validated payment information linked to actual payments
- **Query**: `limit` (default: 50), `offset` (default: 0)
- **Body**: None
- **Response**: Paginated payment information with transaction links
- **Auth**: None

### GET `/pay/payment-info/admin`
Admin endpoint to query payment info by IP address
- **Query**: `ipAddress` (required), `limit`, `offset`, `unlinkedOnly`
- **Body**: None
- **Response**: Payment info with IP tracking data
- **Auth**: None (should add admin middleware)

### DELETE `/pay/payment-info/admin/bulk`
Admin bulk deletion of payment info
- **Body**: `{ ipAddress, unlinkedOnly, olderThanDays }`
- **Response**: Deletion confirmation with counts
- **Auth**: None (should add admin middleware)

---

## Documentation Routes (`/docs`)

### GET `/docs/docs`
Serve API documentation
- **Body**: None
- **Response**: API documentation content
- **Auth**: None

---

## Interactive Routes (`/pivy-activity`)

### GET `/pivy-activity`
Get Pivy activity data (interactive endpoint)
- **Body**: None
- **Response**: Pivy activity information
- **Auth**: None

---

## NFC Tag Routes (`/nfc`)

### POST `/nfc/admin/create-tag` 🔒
Admin endpoint to create NFC tag
- **Body**: Tag creation parameters
- **Response**: Created tag object
- **Auth**: Required

### GET `/nfc/admin/tags` 🔒
Admin endpoint to list NFC tags
- **Body**: None
- **Response**: Array of NFC tags
- **Auth**: Required

### POST `/nfc/admin/:tagId/delete` 🔒
Admin endpoint to delete NFC tag
- **Params**: `tagId`
- **Body**: None
- **Response**: Deletion confirmation
- **Auth**: Required

### POST `/nfc/admin/:tagId/inject` 🔒
Admin endpoint to inject data into NFC tag
- **Params**: `tagId`
- **Body**: Injection data
- **Response**: Injection confirmation
- **Auth**: Required

### POST `/nfc/:tagId/claim` 🔒
Claim an NFC tag for the current user
- **Params**: `tagId`
- **Body**: Claim parameters
- **Response**: Claim confirmation
- **Auth**: Required

### GET `/nfc/my-tag` 🔒
Get current user's NFC tag
- **Body**: None
- **Response**: User's NFC tag information
- **Auth**: Required

### GET `/nfc/:tagId`
Get NFC tag information by ID
- **Params**: `tagId`
- **Body**: None
- **Response**: Tag information
- **Auth**: None

---

## Documentation Reference

### Legend
- 🔒 = Authentication required
- **Auth**: Required = Must include JWT token in Authorization header
- **Auth**: None = No authentication needed

### Common Response Format
```json
{
  "success": boolean,
  "message": string,
  "data": object,
  "error": string?
}
```

### Supported Chains
- `APTOS_MAINNET` - Aptos mainnet
- `APTOS_TESTNET` - Aptos testnet

### Authentication Methods
- `WALLET` - Traditional wallet signature (SIWA)
- Meta keys for stealth address support

### Rate Limiting
All endpoints include appropriate rate limiting based on their usage patterns:
- Public endpoints: 30-120 requests per minute
- Authenticated endpoints: 5-60 requests per minute
- Admin endpoints: Lower limits for security

### File Templates
- `simple-payment`: Optional thumbnail
- `digital-product`: Optional thumbnail + multiple deliverable files
- `fundraiser`: Special handling for fundraising with goal tracking