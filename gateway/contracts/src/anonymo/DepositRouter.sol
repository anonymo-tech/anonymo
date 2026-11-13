// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TimelockOwned} from "./TimelockOwned.sol";
import {IDepositRouter} from "./interfaces/IAnonymo.sol";

/// @title DepositRouter
/// @notice Adapted from the deposit side of Credits: instead of holding balances, every deposit is forwarded
/// in the same call to the treasury Safe and announced as `Deposited(keyCommit, token, payer, amount)`. The gateway
/// credits the API key whose commitment is `keyCommit`. The router never holds funds.
///
/// Same address on Base, Arbitrum and Robinhood Chain: deployed through the CREATE2 deployer with one salt
/// and constructor arguments that are equal on every chain (the timelock, the Safe and the deployer, each
/// of which has the same address on every chain). Chain-specific settings, the stablecoin allowlist, are set
/// after deployment: once by the deployer through `bootstrap`, then only by the owner (the timelock).
///
/// Pausing stops deposits only. The router has no withdrawals, so a pause can never block anyone's money.
contract DepositRouter is IDepositRouter, TimelockOwned, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Where every deposit goes (the treasury Safe).
    address public treasury;
    /// @notice May pause deposits (not unpause). The Safe, so an emergency stop needs no 48-hour wait.
    address public guardian;
    /// @notice One-shot initial allowlist setter (the deployer); cleared by `bootstrap`.
    address public bootstrapper;
    /// @notice Stablecoins accepted for deposit.
    mapping(address token => bool) public isAllowed;

    event TokenAllowed(address indexed token, bool allowed);
    event TreasurySet(address indexed treasury);
    event GuardianSet(address indexed guardian);
    event Bootstrapped();

    error ZeroAddress();
    error ZeroAmount();
    error EmptyKeyCommit();
    error TokenNotAllowed(address token);
    error NotGuardian();
    error NotBootstrapper();
    error NothingReceived();

    /// @param timelock_ Owner, a TimelockController with a delay of at least 48 hours.
    /// @param guardian_ Pause-only role (the treasury Safe).
    /// @param treasury_ Receives every deposit (the treasury Safe).
    /// @param bootstrapper_ May set the initial allowlist once (the deployer).
    constructor(address timelock_, address guardian_, address treasury_, address bootstrapper_)
        TimelockOwned(timelock_)
    {
        if (bootstrapper_ == address(0)) revert ZeroAddress();
        _setGuardian(guardian_);
        _setTreasury(treasury_);
        bootstrapper = bootstrapper_;
    }

    /// @inheritdoc IDepositRouter
    function deposit(address token, uint256 amount, bytes32 keyCommit) external {
        _deposit(token, amount, keyCommit);
    }

    /// @inheritdoc IDepositRouter
    /// @dev The permit is attempted and its failure ignored, so a permit front-run by someone else (which
    /// spends the signature but sets the same allowance) does not block the deposit. Tokens without EIP-2612
    /// fall through to the existing allowance.
    function depositWithPermit(
        address token,
        uint256 amount,
        bytes32 keyCommit,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        try IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _deposit(token, amount, keyCommit);
    }

    /// @dev Emits the amount the treasury actually received, so a fee-on-transfer switch on an allowlisted
    /// token can never credit more than arrived.
    function _deposit(address token, uint256 amount, bytes32 keyCommit) private nonReentrant whenNotPaused {
        if (!isAllowed[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroAmount();
        if (keyCommit == bytes32(0)) revert EmptyKeyCommit();
        address to = treasury;
        uint256 before = IERC20(token).balanceOf(to);
        IERC20(token).safeTransferFrom(msg.sender, to, amount);
        uint256 received = IERC20(token).balanceOf(to) - before;
        if (received == 0) revert NothingReceived();
        emit Deposited(keyCommit, token, msg.sender, received);
    }

    /// @notice Set the initial allowlist on this chain. Callable once, by the bootstrapper only.
    function bootstrap(address[] calldata tokens) external {
        if (msg.sender != bootstrapper) revert NotBootstrapper();
        bootstrapper = address(0);
        for (uint256 i; i < tokens.length; ++i) {
            _setAllowed(tokens[i], true);
        }
        emit Bootstrapped();
    }

    /// @notice Allow or remove a stablecoin (owner, through the timelock).
    function setAllowed(address token, bool allowed) external onlyOwner {
        _setAllowed(token, allowed);
    }

    /// @notice Change the treasury (owner, through the timelock).
    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    /// @notice Change the guardian (owner, through the timelock).
    function setGuardian(address guardian_) external onlyOwner {
        _setGuardian(guardian_);
    }

    /// @notice Stop new deposits (guardian or owner).
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _pause();
    }

    /// @notice Resume deposits (owner only, through the timelock).
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Send any token stuck in the router (sent to it directly) on to the treasury. Anyone may call.
    function sweep(address token) external nonReentrant {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal != 0) IERC20(token).safeTransfer(treasury, bal);
    }

    function _setAllowed(address token, bool allowed) private {
        if (token == address(0)) revert ZeroAddress();
        isAllowed[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _setGuardian(address guardian_) private {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }
}
