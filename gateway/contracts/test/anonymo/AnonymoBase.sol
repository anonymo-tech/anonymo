// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Shared fixture: a 48-hour TimelockController whose only proposer and executor is `safe`.
abstract contract AnonymoBase is Test {
    uint256 internal constant DELAY = 48 hours;

    address internal safe = makeAddr("safe");
    TimelockController internal timelock;
    uint256 private _salt;

    function _deployTimelock() internal returns (TimelockController t) {
        t = _deployTimelock(DELAY);
    }

    function _deployTimelock(uint256 delay) internal returns (TimelockController t) {
        address[] memory s = new address[](1);
        s[0] = safe;
        t = new TimelockController(delay, s, s, address(0));
    }

    /// @dev Schedule `data` on `target` through the timelock as the Safe, wait the delay, execute it.
    function _viaTimelock(address target, bytes memory data) internal {
        bytes32 salt = bytes32(++_salt);
        vm.prank(safe);
        timelock.schedule(target, 0, data, bytes32(0), salt, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(safe);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    /// @dev Schedule only; returns the salt so a test can try to execute early.
    function _schedule(address target, bytes memory data) internal returns (bytes32 salt) {
        salt = bytes32(++_salt);
        vm.prank(safe);
        timelock.schedule(target, 0, data, bytes32(0), salt, DELAY);
    }
}
