// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockOwned} from "./TimelockOwned.sol";
import {IReceiptRoots} from "./interfaces/IAnonymo.sol";

/// @title ReceiptRoots
/// @notice One Merkle root over the hour's signed receipts per UTC hour (`hour` = unix seconds / 3600).
/// Adapted from ReceiptAnchor: the windowed anchor list becomes an hour-keyed map, and the anchorer is the
/// receipts signer. A posted root is final: it can never be overwritten or cleared, not even by the owner.
/// @dev The owner is a TimelockController with at least a 48-hour delay, so a signer change always waits 48
/// hours. Posting is never paused.
contract ReceiptRoots is IReceiptRoots, TimelockOwned {
    /// @notice The only address that may post roots.
    address public signer;

    mapping(uint64 hour => bytes32) private _roots;

    error ZeroAddress();

    /// @param timelock_ Owner, a TimelockController with a delay of at least 48 hours.
    /// @param signer_ Receipts signer.
    constructor(address timelock_, address signer_) TimelockOwned(timelock_) {
        _setSigner(signer_);
    }

    /// @inheritdoc IReceiptRoots
    /// @dev The hour may be the current one or any earlier one, never a future hour.
    function post(uint64 hour, bytes32 root) external {
        if (msg.sender != signer) revert NotSigner();
        if (root == bytes32(0)) revert EmptyRoot();
        if (hour > block.timestamp / 1 hours) revert FutureHour();
        if (_roots[hour] != bytes32(0)) revert RootExists(hour);
        _roots[hour] = root;
        emit RootPosted(hour, root);
    }

    /// @inheritdoc IReceiptRoots
    /// @dev Returns zero for an hour with no root.
    function rootOf(uint64 hour) external view returns (bytes32) {
        return _roots[hour];
    }

    /// @notice Replace the receipts signer (owner only, so through the 48-hour timelock).
    function setSigner(address signer_) external onlyOwner {
        _setSigner(signer_);
    }

    function _setSigner(address signer_) private {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerSet(signer_);
    }
}
