// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EverydayOwned} from "./EverydayOwned.sol";
import {EverydayTimelock} from "./EverydayTimelock.sol";

/// @notice Routes Everyday revenue in USDG. The workers fund creator payouts from their share.
contract EverydayFeeRouter is EverydayOwned, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant WORKERS_BPS = 8_000;
    uint256 public constant TREASURY_BPS = 1_000;
    uint256 public constant STAKER_CREDITS_BPS = 500;
    uint256 public constant BUY_BURN_BPS = 500;
    uint256 public constant BPS = 10_000;

    struct Recipients {
        address workers;
        address treasury;
        address stakerCredits;
        address buyBurn;
    }

    IERC20 public immutable usdg;
    Recipients public recipients;

    event RecipientsSet(Recipients recipients);
    event Routed(
        address indexed payer,
        bytes32 indexed ref,
        uint256 amount,
        uint256 toWorkers,
        uint256 toTreasury,
        uint256 toStakerCredits,
        uint256 toBuyBurn
    );

    error InvalidAddress();
    error InvalidAmount();

    constructor(IERC20 usdg_, EverydayTimelock timelock_, Recipients memory recipients_)
        EverydayOwned(timelock_)
    {
        if (address(usdg_).code.length == 0) revert InvalidAddress();
        usdg = usdg_;
        _setRecipients(recipients_);
    }

    function workers() external view returns (address) {
        return recipients.workers;
    }

    function split(uint256 amount)
        public
        pure
        returns (uint256 workers_, uint256 treasury, uint256 stakers, uint256 buyBurn)
    {
        workers_ = Math.mulDiv(amount, WORKERS_BPS, BPS);
        stakers = Math.mulDiv(amount, STAKER_CREDITS_BPS, BPS);
        buyBurn = Math.mulDiv(amount, BUY_BURN_BPS, BPS);
        treasury = amount - workers_ - stakers - buyBurn;
    }

    function route(uint256 amount, bytes32 ref) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        if (usdg.balanceOf(address(this)) - before != amount) revert InvalidAmount();
        (uint256 w, uint256 t, uint256 s, uint256 b) = split(amount);
        Recipients memory to = recipients;
        if (w != 0) usdg.safeTransfer(to.workers, w);
        usdg.safeTransfer(to.treasury, t);
        if (s != 0) usdg.safeTransfer(to.stakerCredits, s);
        if (b != 0) usdg.safeTransfer(to.buyBurn, b);
        emit Routed(msg.sender, ref, amount, w, t, s, b);
    }

    function setRecipients(Recipients calldata recipients_) external onlyOwner {
        _setRecipients(recipients_);
    }

    function _setRecipients(Recipients memory r) private {
        if (
            r.workers == address(0) || r.treasury == address(0) || r.stakerCredits == address(0)
                || r.buyBurn == address(0) || r.workers == address(this) || r.treasury == address(this)
                || r.stakerCredits == address(this) || r.buyBurn == address(this)
        ) revert InvalidAddress();
        recipients = r;
        emit RecipientsSet(r);
    }
}
