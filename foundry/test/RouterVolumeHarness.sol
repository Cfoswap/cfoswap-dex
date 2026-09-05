// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {CfoRouter} from "../src/router/CfoRouter.sol";

/// @dev Test-only exposure of the router's internal volume-normalization
/// logic. No production code path uses this contract.
contract RouterVolumeHarness is CfoRouter {
    constructor(address[3] memory feeRecipients, uint256[3] memory feeShares)
        CfoRouter(msg.sender, feeRecipients, feeShares)
    {}

    function calcVolumeUSDT18(
        address fromToken,
        address toToken,
        uint256 fromAmount,
        uint256 toAmount
    ) external view returns (uint256) {
        return _calcVolumeUSDT18(fromToken, toToken, fromAmount, toAmount);
    }
}

/// @dev Minimal ERC20 stand-in that reports non-18 decimals, used to
/// verify the decimal-normalization branch without a fork.
contract MockToken6 {
    function decimals() external pure returns (uint8) {
        return 6;
    }
}

/// @dev Minimal ERC20 stand-in reporting 18 decimals. Registered in the
/// router stablecoin whitelist to exercise the stablecoin-volume branches
/// without mainnet fork (mainnet stable addresses are codeless locally and
/// an external call to a codeless address reverts despite the try/catch).
contract MockToken18 {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}
