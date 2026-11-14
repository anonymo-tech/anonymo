// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICoinPay} from "./interfaces/IAnonymo.sol";

/// @title CoinPay
/// @notice Pay for Anonymo usage with the Anonymo coin (launched on Pons). Every coin paid goes straight from the
/// payer to the dead address (0x…dEaD), where nobody can ever move it again: a burn that works for any ERC-20,
/// including Pons launch tokens, which have no burn function. `Paid(keyCommit, payer, amount)` tells the gateway which
/// API key to credit, and `amount` is what the dead address actually received. The gateway credits its USD value at
/// the coin's market price when it sees the payment, so usage is priced in dollars whatever the coin trades at.
/// No owner, no pause, no funds held: nothing here can be changed or drained. The gateway stops accepting coin
/// payments by withholding the `coin` instructions, not on-chain.
contract CoinPay is ICoinPay, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable coin;

    error ZeroAddress();
    error ZeroAmount();
    error EmptyKeyCommit();
    error NothingReceived();

    constructor(address coin_) {
        if (coin_ == address(0)) revert ZeroAddress();
        coin = IERC20(coin_);
    }

    /// @inheritdoc ICoinPay
    function pay(uint256 amount, bytes32 keyCommit) external {
        _pay(amount, keyCommit);
    }

    /// @inheritdoc ICoinPay
    /// @dev For coins with EIP-2612 (Pons launch tokens have none: use `pay` after an approval). A permit
    /// front-run by someone else spends the signature but sets the same allowance, so its failure is ignored and the
    /// payment falls through to the existing allowance.
    function payWithPermit(uint256 amount, bytes32 keyCommit, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        try IERC20Permit(address(coin)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _pay(amount, keyCommit);
    }

    function _pay(uint256 amount, bytes32 keyCommit) private nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (keyCommit == bytes32(0)) revert EmptyKeyCommit();
        uint256 before = coin.balanceOf(DEAD);
        coin.safeTransferFrom(msg.sender, DEAD, amount);
        uint256 received = coin.balanceOf(DEAD) - before;
        if (received == 0) revert NothingReceived();
        emit Paid(keyCommit, msg.sender, received);
    }
}
