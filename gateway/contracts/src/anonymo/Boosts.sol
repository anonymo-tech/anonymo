// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EverydayPausable} from "./EverydayOwned.sol";
import {EverydayTimelock} from "./EverydayTimelock.sol";

/// @notice NYMO locked behind an opaque creator id for ranking. Only the wallet that locked it can unlock it.
contract Boosts is EverydayPausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IERC20 public immutable nymo;
    mapping(bytes32 creatorId => uint256) public totalBoosted;
    mapping(bytes32 creatorId => mapping(address account => uint256)) public boostedBy;

    event Boosted(bytes32 indexed creatorId, address indexed account, uint256 amount);
    event Unlocked(bytes32 indexed creatorId, address indexed account, uint256 amount);

    error InvalidToken();
    error InvalidBoost();

    constructor(IERC20 nymo_, EverydayTimelock timelock_) EverydayPausable(timelock_) {
        if (address(nymo_).code.length == 0) revert InvalidToken();
        nymo = nymo_;
    }

    function boost(bytes32 creatorId, uint256 amount) external whenNotPaused nonReentrant {
        if (creatorId == bytes32(0) || amount == 0) revert InvalidBoost();
        boostedBy[creatorId][msg.sender] += amount;
        totalBoosted[creatorId] += amount;
        nymo.safeTransferFrom(msg.sender, address(this), amount);
        emit Boosted(creatorId, msg.sender, amount);
    }

    function unlock(bytes32 creatorId, uint256 amount) external nonReentrant {
        uint256 locked = boostedBy[creatorId][msg.sender];
        if (amount == 0 || amount > locked) revert InvalidBoost();
        boostedBy[creatorId][msg.sender] = locked - amount;
        totalBoosted[creatorId] -= amount;
        nymo.safeTransfer(msg.sender, amount);
        emit Unlocked(creatorId, msg.sender, amount);
    }
}
