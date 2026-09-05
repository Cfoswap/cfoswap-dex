// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

/// @dev Verbatim copy of CommissionLib's _wrapETH / _swapFeeToUSDT assembly,
///      so fork tests exercise the exact production bytecode logic.
contract FeeSwapHarness {
    address constant internal _WETH = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c; // WBNB
    address constant internal _BSC_USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant internal _BSC_WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    receive() external payable {}

    /// @dev Same logic as _wrapETH in CommissionLib
    function wrapETH(uint256 amount_) external {
        assembly {
            if gt(amount_, 0) {
                let fp := mload(0x40)
                mstore(0x40, add(fp, 0x40))
                mstore(fp, 0xd0e30db000000000000000000000000000000000000000000000000000000000) // deposit()
                if iszero(call(gas(), _WETH, amount_, fp, 0x4, 0, 0)) {
                    mstore(0x00, 0x08c379a0)
                    mstore(0x04, 0x20)
                    mstore(0x24, 0x13)
                    mstore(0x44, "commission: wrap eth fail")
                    revert(0, 0x57)
                }
            }
        }
    }

    /// @dev Verbatim copy of _swapFeeToUSDT (returns ok flag for degradation)
    function swapFeeToUSDT(address tokenIn_, uint256 amountIn_) external returns (uint256 amountOut, bool ok) {
        assembly {
            amountOut := amountIn_
            ok := 0
            if eq(tokenIn_, _BSC_USDT) {
                ok := 1
                mstore(0x00, amountOut)
                mstore(0x20, ok)
                return(0x00, 0x40)
            }

            let freePtr := mload(0x40)
            mstore(0x40, add(freePtr, 0x200))

            mstore(freePtr, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(add(freePtr, 0x04), address())
            if iszero(staticcall(gas(), _BSC_USDT, freePtr, 0x24, 0x00, 0x20)) {
                mstore(0x00, 0x08c379a0)
                mstore(0x04, 0x20)
                mstore(0x24, 0x13)
                mstore(0x44, "swap fee: balOf fail")
                revert(0, 0x53)
            }
            let usdtBefore := mload(0)

            mstore(freePtr, 0x095ea7b300000000000000000000000000000000000000000000000000000000)
            mstore(add(freePtr, 0x04), 0x10ED43C718714eb63d5aA57B78B54704E256024E)
            mstore(add(freePtr, 0x24), amountIn_)
            if iszero(call(gas(), tokenIn_, 0, freePtr, 0x44, 0, 0x20)) {
                mstore(0x00, amountOut)
                mstore(0x20, ok)
                return(0x00, 0x40)
            }

            let pathLen := 3
            if eq(tokenIn_, _BSC_WBNB) { pathLen := 2 }

            let cd := add(freePtr, 0x60)
            mstore(cd, 0x38ed173900000000000000000000000000000000000000000000000000000000)
            mstore(add(cd, 0x04), amountIn_)
            mstore(add(cd, 0x24), 0)
            mstore(add(cd, 0x44), 0xA0)
            mstore(add(cd, 0x64), address())
            mstore(add(cd, 0x84), add(timestamp(), 0xffffffff))
            mstore(add(cd, 0xA4), pathLen)
            mstore(add(cd, 0xC4), tokenIn_)
            if eq(pathLen, 3) {
                mstore(add(cd, 0xE4), _BSC_WBNB)
                mstore(add(cd, 0x104), _BSC_USDT)
            }
            if eq(pathLen, 2) {
                mstore(add(cd, 0xE4), _BSC_USDT)
            }
            let cdSize := add(0xC4, mul(pathLen, 0x20))

            if iszero(call(gas(), 0x10ED43C718714eb63d5aA57B78B54704E256024E, 0, cd, cdSize, 0, 0)) {
                mstore(0x00, amountOut)
                mstore(0x20, ok)
                return(0x00, 0x40)
            }

            mstore(freePtr, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(add(freePtr, 0x04), address())
            if iszero(staticcall(gas(), _BSC_USDT, freePtr, 0x24, 0x00, 0x20)) {
                mstore(0x00, 0x08c379a0)
                mstore(0x04, 0x20)
                mstore(0x24, 0x13)
                mstore(0x44, "swap fee: balOf2 fail")
                revert(0, 0x53)
            }
            amountOut := sub(mload(0), usdtBefore)
            ok := 1
        }
    }
}
