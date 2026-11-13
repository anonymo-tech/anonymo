// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title AnonymoTimelock
/// @notice The OpenZeppelin TimelockController with two additions:
///  - The delay can never go below 48 hours, at construction or through `updateDelay`. A stock controller lets
///    governance lower the delay, run a change with no wait, and restore the delay in the same batch, so an
///    owner that checks only the current delay (TimelockOwned) would see 48 hours throughout.
///  - Each role keeps a member count, so a deploy script can prove that the Safe is the only proposer, executor
///    and canceller and that the timelock is its only admin. A stock controller cannot enumerate its roles.
contract AnonymoTimelock is TimelockController {
    uint256 public constant MIN_DELAY_FLOOR = 48 hours;

    mapping(bytes32 role => uint256) public roleMemberCount;

    error DelayBelowFloor(uint256 delay);

    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {
        if (minDelay < MIN_DELAY_FLOOR) revert DelayBelowFloor(minDelay);
    }

    /// @inheritdoc TimelockController
    function updateDelay(uint256 newDelay) public virtual override {
        if (newDelay < MIN_DELAY_FLOOR) revert DelayBelowFloor(newDelay);
        super.updateDelay(newDelay);
    }

    function _grantRole(bytes32 role, address account) internal virtual override returns (bool granted) {
        granted = super._grantRole(role, account);
        if (granted) ++roleMemberCount[role];
    }

    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool revoked) {
        revoked = super._revokeRole(role, account);
        if (revoked) --roleMemberCount[role];
    }
}
