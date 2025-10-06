# Aptos CCTP Move Scripts

This directory contains compiled Move scripts for interacting with Aptos CCTP (Cross-Chain Transfer Protocol).

## Required Scripts

You need to obtain the compiled `.mv` files from the [aptos-cctp repository](https://github.com/circlefin/aptos-cctp):

### Testnet Scripts
Place these in `testnet/`:
- `handle_receive_message.mv` - Script to receive and process CCTP messages on Aptos testnet

### Mainnet Scripts
Place these in `mainnet/`:
- `handle_receive_message.mv` - Script to receive and process CCTP messages on Aptos mainnet

## How to Get the Scripts

### Option 1: Download from aptos-cctp Repository
1. Clone the repository: `git clone https://github.com/circlefin/aptos-cctp.git`
2. Navigate to the precompiled scripts directory (if available)
3. Copy the `.mv` files to the appropriate directories

### Option 2: Compile from Source
1. Clone the repository: `git clone https://github.com/circlefin/aptos-cctp.git`
2. Follow the repository's instructions to compile the Move modules
3. The compiled `.mv` files will be generated in the build output
4. Copy them to this directory structure

### Option 3: Use Example Scripts (Recommended for Testing)
The aptos-cctp repository includes example TypeScript scripts that demonstrate the exact Move bytecode needed. Look in:
```
typescript/example/precompiled-move-scripts/testnet/handle_receive_message.mv
typescript/example/precompiled-move-scripts/mainnet/handle_receive_message.mv
```

## Script Details

### handle_receive_message.mv
This script is used to complete the CCTP transfer by:
1. Taking the message bytes from the source chain
2. Taking the attestation signature from Circle's attestation service
3. Calling the MessageTransmitter to receive and process the message
4. Minting USDC to the recipient address

## Contract Addresses

### Testnet
- MessageTransmitter Package: `0x081e86cebf457a0c6004f35bd648a2794698f52e0dde09a48619dcd3d4cc23d9`
- TokenMessengerMinter Package: `0x5f9b937419dda90aa06c1836b7847f65bbbe3f1217567758dc2488be31a477b9`
- USDC: `0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832`

### Mainnet
- MessageTransmitter Package: `0x177e17751820e4b4371873ca8c30279be63bdea63b88ed0f2239c2eea10f1772`
- TokenMessengerMinter Package: `0x9bce6734f7b63e835108e3bd8c36743d4709fe435f44791918801d0989640a9d`
- USDC: `0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b`

## Important Notes

- These scripts must match the deployed CCTP contracts on Aptos
- Do not modify the compiled bytecode
- Keep testnet and mainnet scripts separate
- The scripts are network-specific due to hardcoded object addresses

## Reference Documentation

- [Aptos CCTP Tutorial](https://aptos.dev/en/tutorials/transfer-usdc-between-aptos-and-base-via-cctp-v1)
- [Circle CCTP Documentation](https://www.circle.com/cross-chain-transfer-protocol)
- [aptos-cctp Repository](https://github.com/circlefin/aptos-cctp)
