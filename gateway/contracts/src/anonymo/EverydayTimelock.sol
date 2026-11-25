// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AnonymoTimelock} from "./AnonymoTimelock.sol";

interface IEverydaySafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory modules, address next);
}

/// @notice A dedicated controller for Everyday. The Safe alone queues, cancels and executes operations.
contract EverydayTimelock is AnonymoTimelock {
    uint256 public constant EVERYDAY_DELAY = 7 days;

    address public safe;
    bytes32 private _executing;

    error InvalidSafe();
    error FixedRoles();
    error NestedExecution();

    constructor(address safe_) AnonymoTimelock(EVERYDAY_DELAY, _members(safe_), _members(safe_), address(0)) {
        safe = safe_;
        _checkSafe();
    }

    function updateDelay(uint256 newDelay) public override {
        if (newDelay < EVERYDAY_DELAY) revert DelayBelowFloor(newDelay);
        super.updateDelay(newDelay);
    }

    function grantRole(bytes32, address) public pure override {
        revert FixedRoles();
    }

    function revokeRole(bytes32, address) public pure override {
        revert FixedRoles();
    }

    function renounceRole(bytes32, address) public pure override {
        revert FixedRoles();
    }

    function isExecuting(address target, bytes calldata data) external view returns (bool) {
        return _executing == keccak256(abi.encode(target, data));
    }

    function _checkRole(bytes32 role, address account) internal view override {
        super._checkRole(role, account);
        if (account == safe) _checkSafe();
    }

    function _execute(address target, uint256 value, bytes calldata data) internal override {
        if (_executing != bytes32(0)) revert NestedExecution();
        _executing = keccak256(abi.encode(target, data));
        super._execute(target, value, data);
        delete _executing;
    }

    function _checkSafe() private view {
        if (safe.code.length == 0) revert InvalidSafe();
        IEverydaySafe s = IEverydaySafe(safe);
        if (s.getThreshold() != 3 || s.getOwners().length != 5) revert InvalidSafe();
        // A Safe module could otherwise call the timelock without the owner signatures.
        (address[] memory modules,) = s.getModulesPaginated(address(1), 1);
        if (modules.length != 0) revert InvalidSafe();
    }

    function _members(address account) private pure returns (address[] memory members) {
        members = new address[](1);
        members[0] = account;
    }
}
