// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ICoinPay} from "./interfaces/IAnonymo.sol";

/// @title CoinPay
/// @notice Pay for Anonymo usage with ANMO. Every coin paid is burned in the same call, and
/// `Paid(keyCommit, payer, amount)` tells the gateway which API key to credit. The gateway credits the USD value
/// at the coin's market price when it sees the payment (a 30-minute pool average, never more than the spot price),
/// so usage is priced in dollars whatever the coin trades at.
/// No owner, no pause, no funds held: nothing here can be changed or drained. The gateway stops accepting coin
/// payments by withholding the `coin` instructions, not on-chain.
contract CoinPay is ICoinPay {
    ERC20Burnable public immutable coin;

    error ZeroAddress();
    error ZeroAmount();
    error EmptyKeyCommit();

    constructor(address coin_) {
        if (coin_ == address(0)) revert ZeroAddress();
        coin = ERC20Burnable(coin_);
    }

    /// @inheritdoc ICoinPay
    function pay(uint256 amount, bytes32 keyCommit) external {
        _pay(amount, keyCommit);
    }

    /// @inheritdoc ICoinPay
    /// @dev A permit front-run by someone else spends the signature but sets the same allowance, so its failure
    /// is ignored and the payment falls through to the existing allowance.
    function payWithPermit(uint256 amount, bytes32 keyCommit, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        try IERC20Permit(address(coin)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _pay(amount, keyCommit);
    }

    function _pay(uint256 amount, bytes32 keyCommit) private {
        if (amount == 0) revert ZeroAmount();
        if (keyCommit == bytes32(0)) revert EmptyKeyCommit();
        coin.burnFrom(msg.sender, amount);
        emit Paid(keyCommit, msg.sender, amount);
    }
}
