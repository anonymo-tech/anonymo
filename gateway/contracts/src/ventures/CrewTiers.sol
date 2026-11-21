// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {VenturesGuarded} from "./VenturesOwned.sol";
import {ICrewTiers} from "./interfaces/IVentures.sol";

/// @title CrewTiers
/// @notice Stake NYMO for a crew tier. The token the spec calls $NYMO is this repo's ANMO contract; it is
/// passed in as `token`.
///
/// Tier = the 7-day time-weighted average balance (TWAB) of the stake against three thresholds (Crew, Gang,
/// Syndicate; below Crew is Solo). Each balance change writes a checkpoint holding the new balance and the
/// running integral of balance over time, so any trailing-7-day average is computed on read. Time before the
/// first stake counts as zero, so a fresh stake reaches its full weight only after 7 days.
///
/// `unstake` is immediate and never paused. Pausing stops new stakes only. Thresholds change only through the
/// 7-day timelock.
contract CrewTiers is ICrewTiers, VenturesGuarded, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Checkpoint {
        uint48 time;
        uint208 balance; // balance from `time` on
        uint256 cumulative; // integral of balance dt from 0 to `time`
    }

    uint256 public constant TWAB_WINDOW = 7 days;
    uint8 public constant SOLO = 0;
    uint8 public constant CREW = 1;
    uint8 public constant GANG = 2;
    uint8 public constant SYNDICATE = 3;

    IERC20 public immutable token;

    /// @notice Minimum 7-day TWAB for Crew, Gang and Syndicate (18 decimals), strictly increasing.
    uint256[3] public thresholds;
    uint256 public totalStaked;

    mapping(address account => uint256) public stakedOf;
    mapping(address account => Checkpoint[]) private _checkpoints;
    Checkpoint[] private _totalCheckpoints;

    event Staked(address indexed account, uint256 amount, uint256 total);
    event Unstaked(address indexed account, uint256 amount, uint256 total);
    event ThresholdsSet(uint256 crew, uint256 gang, uint256 syndicate);

    error ZeroAmount();
    error InsufficientStake(uint256 staked);
    error BadThresholds();
    error FutureTimestamp();

    /// @param token_ NYMO (this repo's ANMO).
    /// @param timelock_ Owner: a timelock with at least a 7-day delay.
    /// @param guardian_ Pause-only role (the Safe).
    constructor(IERC20 token_, address timelock_, address guardian_) VenturesGuarded(timelock_, guardian_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
        _setThresholds(50_000e18, 250_000e18, 1_000_000e18);
    }

    // ---------------------------------------------------------------- stake

    /// @notice Stake `amount` NYMO. Paused with new payments.
    function stake(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 total = stakedOf[msg.sender] + amount;
        stakedOf[msg.sender] = total;
        totalStaked += amount;
        _write(_checkpoints[msg.sender], total);
        _write(_totalCheckpoints, totalStaked);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, total);
    }

    /// @notice Unstake `amount` NYMO at once. Never paused; no role can block it.
    function unstake(uint256 amount) external nonReentrant {
        uint256 staked = stakedOf[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (amount > staked) revert InsufficientStake(staked);
        uint256 total = staked - amount;
        stakedOf[msg.sender] = total;
        totalStaked -= amount;
        _write(_checkpoints[msg.sender], total);
        _write(_totalCheckpoints, totalStaked);
        token.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, total);
    }

    // ---------------------------------------------------------------- views

    /// @notice The account's average stake over the trailing 7 days.
    function twabOf(address account) external view returns (uint256) {
        return _twab(_checkpoints[account], block.timestamp);
    }

    /// @inheritdoc ICrewTiers
    /// @dev The average over [timestamp - 7 days, timestamp]. `timestamp` may not be in the future.
    function twabAt(address account, uint256 timestamp) external view returns (uint256) {
        if (timestamp > block.timestamp) revert FutureTimestamp();
        return _twab(_checkpoints[account], timestamp);
    }

    /// @notice The total stake's average over the trailing 7 days.
    function totalTwab() external view returns (uint256) {
        return _twab(_totalCheckpoints, block.timestamp);
    }

    /// @inheritdoc ICrewTiers
    function totalTwabAt(uint256 timestamp) external view returns (uint256) {
        if (timestamp > block.timestamp) revert FutureTimestamp();
        return _twab(_totalCheckpoints, timestamp);
    }

    /// @inheritdoc ICrewTiers
    /// @return 0 Solo, 1 Crew, 2 Gang, 3 Syndicate.
    function tierOf(address account) external view returns (uint8) {
        return tierFor(_twab(_checkpoints[account], block.timestamp));
    }

    /// @notice The tier a given TWAB earns.
    function tierFor(uint256 twab) public view returns (uint8) {
        if (twab >= thresholds[2]) return SYNDICATE;
        if (twab >= thresholds[1]) return GANG;
        if (twab >= thresholds[0]) return CREW;
        return SOLO;
    }

    function checkpointCount(address account) external view returns (uint256) {
        return _checkpoints[account].length;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Change the tier thresholds (owner, through the 7-day timelock).
    function setThresholds(uint256 crew, uint256 gang, uint256 syndicate) external onlyOwner {
        _setThresholds(crew, gang, syndicate);
    }

    // ---------------------------------------------------------------- internal

    function _setThresholds(uint256 crew, uint256 gang, uint256 syndicate) private {
        if (crew == 0 || gang <= crew || syndicate <= gang) revert BadThresholds();
        thresholds = [crew, gang, syndicate];
        emit ThresholdsSet(crew, gang, syndicate);
    }

    function _write(Checkpoint[] storage cps, uint256 balance) private {
        uint256 n = cps.length;
        uint48 now_ = SafeCast.toUint48(block.timestamp);
        uint208 bal = SafeCast.toUint208(balance);
        if (n != 0) {
            Checkpoint storage last = cps[n - 1];
            if (last.time == now_) {
                last.balance = bal;
                return;
            }
            uint256 cum = last.cumulative + uint256(last.balance) * (now_ - last.time);
            cps.push(Checkpoint(now_, bal, cum));
        } else {
            cps.push(Checkpoint(now_, bal, 0));
        }
    }

    /// @dev Integral of balance dt from 0 to `t`.
    function _cumulative(Checkpoint[] storage cps, uint256 t) private view returns (uint256) {
        uint256 n = cps.length;
        if (n == 0 || t < cps[0].time) return 0;
        // Last checkpoint with time <= t.
        uint256 lo = 0;
        uint256 hi = n - 1;
        if (cps[hi].time > t) {
            while (lo < hi) {
                uint256 mid = (lo + hi + 1) / 2;
                if (cps[mid].time <= t) lo = mid;
                else hi = mid - 1;
            }
        } else {
            lo = hi;
        }
        Checkpoint storage c = cps[lo];
        return c.cumulative + uint256(c.balance) * (t - c.time);
    }

    function _twab(Checkpoint[] storage cps, uint256 t) private view returns (uint256) {
        uint256 start = t > TWAB_WINDOW ? t - TWAB_WINDOW : 0;
        return (_cumulative(cps, t) - _cumulative(cps, start)) / TWAB_WINDOW;
    }
}
