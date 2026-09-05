/// SPDX-License-Identifier: MIT
// AUTO-GENERATED — DO NOT EDIT BY HAND. This file is gitignored.
// Per-chain constants for the current deploy target. Regenerated per deploy by
// scripts/deploy/gen-chainconfig.js, or seeded with defaults by scripts/deploy/ensure-chainconfig.js.
pragma solidity ^0.8.0;

// Target chain this config was generated for. DeployDexRouter.s.sol asserts
// block.chainid == _EXPECTED_CHAIN_ID to prevent deploying with the wrong chain's config.
uint256 constant _EXPECTED_CHAIN_ID = 56;

uint256 constant NATIVE_TOKEN_TRANSFER_GAS_LIMIT = 100000;
address constant _WETH = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
address constant _APPROVE_PROXY = 0x0000000000000000000000000000000000000000;
address constant _PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
// Uniswap V3 CREATE2 prefix: 0xff ++ factory(20 bytes) ++ 11-byte zero padding.
bytes32 constant _FF_FACTORY = 0xffdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F70000000000000000000000;
// DexRouter owner (constructor arg in DeployDexRouter.s.sol). Per-chain, REQUIRED in
// deployed/<chain>/base.js owner (no default). NOT baked into any value/routing path.
address constant _OWNER = address(0);
