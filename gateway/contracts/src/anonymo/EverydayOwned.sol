// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {TimelockOwned} from "./TimelockOwned.sol";
import {EverydayTimelock} from "./EverydayTimelock.sol";

abstract contract EverydayOwned is TimelockOwned {
    error NotQueued();
    error FixedOwner();

    constructor(EverydayTimelock timelock_) TimelockOwned(address(timelock_)) {
        if (address(timelock_).codehash != keccak256(type(EverydayTimelock).runtimeCode)) {
            revert NotTimelock(address(timelock_));
        }
    }

    /// @dev Keep the controller that enforces the seven-day floor and Safe-only roles.
    function transferOwnership(address) public pure override {
        revert FixedOwner();
    }

    function _checkOwner() internal view override {
        super._checkOwner();
        if (!EverydayTimelock(payable(msg.sender)).isExecuting(address(this), msg.data)) revert NotQueued();
    }
}

abstract contract EverydayPausable is EverydayOwned, Pausable {
    constructor(EverydayTimelock timelock_) EverydayOwned(timelock_) {}

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
