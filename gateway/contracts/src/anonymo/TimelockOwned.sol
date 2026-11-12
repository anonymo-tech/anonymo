// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IMinDelay {
    function getMinDelay() external view returns (uint256);
}

/// @title TimelockOwned
/// @notice Ownable2Step whose owner must be a timelock (anything exposing `getMinDelay()`) with a delay of at
/// least 48 hours. The check runs at construction, on every ownership transfer and on every owner-only call,
/// so if the timelock's delay is ever lowered below 48 hours the owner functions stop working until it is
/// raised again. Ownership can never be renounced.
abstract contract TimelockOwned is Ownable2Step {
    /// @notice Minimum delay every privileged change goes through.
    uint256 public constant MIN_OWNER_DELAY = 48 hours;

    error NotTimelock(address account);
    error RenounceDisabled();

    constructor(address timelock_) Ownable(timelock_) {
        _requireTimelock(timelock_);
    }

    /// @dev Ownership moves only to another timelock with at least the minimum delay.
    function transferOwnership(address newOwner) public virtual override onlyOwner {
        _requireTimelock(newOwner);
        super.transferOwnership(newOwner);
    }

    /// @dev Disabled: an ownerless contract could never change its signer, treasury or rates again.
    function renounceOwnership() public view virtual override onlyOwner {
        revert RenounceDisabled();
    }

    function _checkOwner() internal view virtual override {
        super._checkOwner();
        _requireTimelock(msg.sender);
    }

    function _requireTimelock(address account) internal view {
        if (account.code.length == 0) revert NotTimelock(account);
        (bool ok, bytes memory ret) = account.staticcall(abi.encodeCall(IMinDelay.getMinDelay, ()));
        if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) < MIN_OWNER_DELAY) revert NotTimelock(account);
    }
}
