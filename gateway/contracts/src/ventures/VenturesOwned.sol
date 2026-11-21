// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {TimelockOwned, IMinDelay} from "../anonymo/TimelockOwned.sol";

/// @title VenturesOwned
/// @notice TimelockOwned with the Ventures floor: the owning timelock must have a delay of at least 7 days (not
/// only the 48 hours TimelockOwned already enforces). Checked at construction, on every ownership transfer and
/// on every owner-only call, so lowering the timelock's delay below 7 days freezes the setters.
abstract contract VenturesOwned is TimelockOwned {
    /// @notice Minimum delay for every Ventures setter.
    uint256 public constant VENTURES_MIN_DELAY = 7 days;

    constructor(address timelock_) TimelockOwned(timelock_) {
        _requireVenturesDelay(timelock_);
    }

    function transferOwnership(address newOwner) public virtual override onlyOwner {
        _requireVenturesDelay(newOwner);
        super.transferOwnership(newOwner);
    }

    function _checkOwner() internal view virtual override {
        super._checkOwner();
        _requireVenturesDelay(msg.sender);
    }

    function _requireVenturesDelay(address account) internal view {
        (bool ok, bytes memory ret) = account.staticcall(abi.encodeCall(IMinDelay.getMinDelay, ()));
        if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) < VENTURES_MIN_DELAY) revert NotTimelock(account);
    }
}

/// @title VenturesGuarded
/// @notice VenturesOwned plus a pause that gates new payments, stakes, locks and runs only. The guardian (the
/// 3-of-5 Safe) or the owner may pause at once; only the owner (through the 7-day timelock) may unpause.
/// Exit paths (unstake, unlock, withdraw, refund, claim) must never carry `whenNotPaused`.
abstract contract VenturesGuarded is VenturesOwned, Pausable {
    /// @notice May pause (not unpause).
    address public guardian;

    event GuardianSet(address indexed guardian);

    error ZeroAddress();
    error NotGuardian();

    constructor(address timelock_, address guardian_) VenturesOwned(timelock_) {
        _setGuardian(guardian_);
    }

    /// @notice Stop new payments and stakes (guardian or owner). Exits keep working.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _pause();
    }

    /// @notice Resume (owner, through the timelock).
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Change the guardian (owner, through the timelock).
    function setGuardian(address guardian_) external onlyOwner {
        _setGuardian(guardian_);
    }

    function _setGuardian(address guardian_) private {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }
}
