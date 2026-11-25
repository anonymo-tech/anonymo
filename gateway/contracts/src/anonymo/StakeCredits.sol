// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EverydayPausable} from "./EverydayOwned.sol";
import {EverydayTimelock} from "./EverydayTimelock.sol";
import {StakeTwab} from "./StakeTwab.sol";

/// @notice NYMO stake with immediate exit and seven-day time-weighted tiers. Daily credits are issued off-chain.
contract StakeCredits is EverydayPausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using StakeTwab for StakeTwab.Checkpoint[];

    enum Tier {
        Free,
        Plus,
        Pro,
        Black
    }

    struct TierRule {
        uint256 minTwab;
        uint256 dailyMicroUsd;
    }

    uint256 public constant TWAB_WINDOW = StakeTwab.WINDOW;
    IERC20 public immutable nymo;

    TierRule[3] public tierTable;
    uint256 public totalStaked;
    mapping(address account => uint256) public stakedOf;
    mapping(address account => StakeTwab.Checkpoint[]) private _history;
    StakeTwab.Checkpoint[] private _totalHistory;

    event Staked(address indexed account, uint256 amount, uint256 balance);
    event Unstaked(address indexed account, uint256 amount, uint256 balance);
    event TierTableSet(TierRule[3] table);

    error InvalidStake();
    error InvalidTable();
    error FutureTimestamp();
    error InvalidToken();

    constructor(IERC20 nymo_, EverydayTimelock timelock_, uint256[3] memory dailyMicroUsd)
        EverydayPausable(timelock_)
    {
        if (address(nymo_).code.length == 0) revert InvalidToken();
        nymo = nymo_;
        _setTierTable(
            [
                TierRule(10_000e18, dailyMicroUsd[0]),
                TierRule(50_000e18, dailyMicroUsd[1]),
                TierRule(250_000e18, dailyMicroUsd[2])
            ]
        );
    }

    function stake(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert InvalidStake();
        uint256 balance = stakedOf[msg.sender] + amount;
        _update(msg.sender, balance, totalStaked + amount);
        nymo.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, balance);
    }

    function unstake(uint256 amount) external nonReentrant {
        uint256 balance = stakedOf[msg.sender];
        if (amount == 0 || amount > balance) revert InvalidStake();
        balance -= amount;
        _update(msg.sender, balance, totalStaked - amount);
        nymo.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, balance);
    }

    function twabOf(address account) public view returns (uint256) {
        return twabAt(account, block.timestamp);
    }

    function twabAt(address account, uint256 time) public view returns (uint256) {
        if (time > block.timestamp) revert FutureTimestamp();
        return _history[account].average(time);
    }

    function totalTwabAt(uint256 time) external view returns (uint256) {
        if (time > block.timestamp) revert FutureTimestamp();
        return _totalHistory.average(time);
    }

    function tierOf(address account) public view returns (Tier) {
        uint256 average = twabOf(account);
        if (average >= tierTable[2].minTwab) return Tier.Black;
        if (average >= tierTable[1].minTwab) return Tier.Pro;
        if (average >= tierTable[0].minTwab) return Tier.Plus;
        return Tier.Free;
    }

    /// @notice Index stake and table events for daily credit issuance. A full exit stops new credits immediately.
    function dailyCreditOf(address account) external view returns (uint256) {
        Tier tier = tierOf(account);
        if (tier == Tier.Free || stakedOf[account] == 0) return 0;
        return tierTable[uint8(tier) - 1].dailyMicroUsd;
    }

    function setTierTable(TierRule[3] calldata table) external onlyOwner {
        _setTierTable(table);
    }

    function _setTierTable(TierRule[3] memory table) private {
        if (
            table[0].minTwab == 0 || table[0].minTwab >= table[1].minTwab
                || table[1].minTwab >= table[2].minTwab
        ) {
            revert InvalidTable();
        }
        for (uint256 i; i < table.length; ++i) {
            tierTable[i] = table[i];
        }
        emit TierTableSet(table);
    }

    function _update(address account, uint256 balance, uint256 total) private {
        stakedOf[account] = balance;
        totalStaked = total;
        _history[account].write(balance);
        _totalHistory.write(total);
    }
}
