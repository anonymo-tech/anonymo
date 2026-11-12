// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TimelockOwned} from "./TimelockOwned.sol";
import {ICreditPass, IStakerCredit} from "./interfaces/IAnonymo.sol";

/// @title CreditPass
/// @notice Stake ANMO for a daily API credit allowance. The gateway reads `allowanceOf` on each request and
/// meters usage off-chain as a token bucket: it fills at `microUsdPerDay` from the time of the stake and holds
/// at most `rolloverCapMicroUsd` (3 days), so unused credit rolls over for up to 3 days.
///
/// Unstaking: `requestUnstake` moves the whole active stake into a 7-day cooldown (the allowance drops to
/// zero at once), then `withdraw` returns it. Neither is ever paused and no role can touch staked principal.
/// Pausing stops new stakes only.
///
/// Stakers' credit: the FeeRouter sends 5% of every ANMO-denominated spend here through `notifyCredit`. It is
/// shared pro rata over the active stake as ANMO-denominated API credit (`creditOf`, cumulative and never
/// decreasing), not as tokens: stakers can never withdraw it. The tokens behind it may be swept by the owner,
/// but the sweep can never reach staked principal.
contract CreditPass is ICreditPass, IStakerCredit, TimelockOwned, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Position {
        uint256 active; // staked, earning allowance and credit
        uint256 pending; // in cooldown, earning nothing
        uint64 cooldownEnds; // when `pending` becomes withdrawable
        uint64 stakedSince; // first stake of the current active position (0 when none)
        uint256 creditDebt; // active * accCreditPerShare at the last update (scaled by PRECISION)
        uint256 creditAccrued; // cumulative credit settled to this position (scaled by PRECISION)
    }

    uint256 public constant COOLDOWN = 7 days;
    uint256 public constant ROLLOVER_DAYS = 3;
    /// @notice Smallest active position (1 ANMO). Keeps `totalStaked` at least 1e18 whenever it is non-zero,
    /// which bounds `accCreditPerShare` growth.
    uint256 public constant MIN_STAKE = 1e18;
    uint256 private constant PRECISION = 1e18;

    IERC20 public immutable anmo;
    /// @notice The only address that may call `notifyCredit`.
    address public immutable feeRouter;

    /// @notice micro-USD of daily allowance per whole ANMO (1e18 wei) staked.
    uint256 public microUsdPerAnmoPerDay;
    /// @notice May pause new stakes (not unpause).
    address public guardian;

    uint256 public totalStaked; // sum of active
    uint256 public totalPending; // sum of pending
    uint256 public totalCredit; // sum of notified credit
    uint256 public accCreditPerShare;
    uint256 private _creditRemainder; // undistributed scaled credit, carried to the next notify

    mapping(address user => Position) public positions;

    event Staked(address indexed user, uint256 amount);
    event UnstakeRequested(address indexed user, uint256 amount, uint64 cooldownEnds);
    event Withdrawn(address indexed user, uint256 amount);
    event CreditNotified(uint256 amount, uint256 accCreditPerShare);
    event RateSet(uint256 microUsdPerAnmoPerDay);
    event GuardianSet(address indexed guardian);
    event ExcessSwept(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NothingPending();
    error CooldownActive(uint64 endsAt);
    error NotGuardian();
    error NotFeeRouter();
    error NoStakers();
    error BelowMinStake();

    /// @param anmo_ The ANMO token.
    /// @param timelock_ Owner, a TimelockController with a delay of at least 48 hours.
    /// @param guardian_ Pause-only role (the Safe).
    /// @param feeRouter_ The FeeRouter (its address is known before deployment).
    /// @param microUsdPerAnmoPerDay_ Initial allowance rate.
    constructor(
        IERC20 anmo_,
        address timelock_,
        address guardian_,
        address feeRouter_,
        uint256 microUsdPerAnmoPerDay_
    ) TimelockOwned(timelock_) {
        if (address(anmo_) == address(0) || feeRouter_ == address(0)) revert ZeroAddress();
        anmo = anmo_;
        feeRouter = feeRouter_;
        _setGuardian(guardian_);
        microUsdPerAnmoPerDay = microUsdPerAnmoPerDay_;
        emit RateSet(microUsdPerAnmoPerDay_);
    }

    // ---------------------------------------------------------------- staking

    /// @inheritdoc ICreditPass
    function stake(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        Position storage p = positions[msg.sender];
        if (p.active + amount < MIN_STAKE) revert BelowMinStake();
        _settle(p);
        if (p.active == 0) p.stakedSince = uint64(block.timestamp);
        p.active += amount;
        totalStaked += amount;
        p.creditDebt = _debt(p.active);
        anmo.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @inheritdoc ICreditPass
    /// @dev Moves the whole active stake into cooldown. Calling again while a cooldown runs adds the new
    /// active stake to it and restarts the 7 days for the combined amount. Never paused.
    function requestUnstake() external nonReentrant {
        Position storage p = positions[msg.sender];
        uint256 amount = p.active;
        if (amount == 0) revert ZeroAmount();
        _settle(p);
        p.active = 0;
        p.stakedSince = 0;
        p.creditDebt = 0;
        totalStaked -= amount;
        p.pending += amount;
        totalPending += amount;
        uint64 ends = uint64(block.timestamp + COOLDOWN);
        p.cooldownEnds = ends;
        emit UnstakeRequested(msg.sender, amount, ends);
    }

    /// @inheritdoc ICreditPass
    /// @dev Never paused: no modifier here may ever depend on `paused()` or on any role.
    function withdraw() external nonReentrant {
        Position storage p = positions[msg.sender];
        uint256 amount = p.pending;
        if (amount == 0) revert NothingPending();
        if (block.timestamp < p.cooldownEnds) revert CooldownActive(p.cooldownEnds);
        p.pending = 0;
        p.cooldownEnds = 0;
        totalPending -= amount;
        anmo.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc ICreditPass
    function allowanceOf(address user) external view returns (uint256 microUsdPerDay, uint256 rolloverCapMicroUsd) {
        microUsdPerDay = (positions[user].active * microUsdPerAnmoPerDay) / 1e18;
        rolloverCapMicroUsd = microUsdPerDay * ROLLOVER_DAYS;
    }

    /// @notice Cumulative ANMO-denominated API credit earned from the stakers' share (never decreases).
    function creditOf(address user) external view returns (uint256) {
        Position storage p = positions[user];
        return (p.creditAccrued + _debt(p.active) - p.creditDebt) / PRECISION;
    }

    // ---------------------------------------------------------------- stakers' credit

    /// @inheritdoc IStakerCredit
    /// @dev FeeRouter only. Pulls `amount` ANMO from the FeeRouter and shares it over the active stake.
    /// Reverts with no active stake; the FeeRouter checks `totalStaked` first and sends to the treasury.
    function notifyCredit(uint256 amount) external nonReentrant {
        if (msg.sender != feeRouter) revert NotFeeRouter();
        if (amount == 0) return;
        uint256 staked = totalStaked;
        if (staked == 0) revert NoStakers();
        anmo.safeTransferFrom(msg.sender, address(this), amount);
        totalCredit += amount;
        uint256 scaled = amount * PRECISION + _creditRemainder;
        uint256 acc = accCreditPerShare + scaled / staked;
        _creditRemainder = scaled % staked;
        accCreditPerShare = acc;
        emit CreditNotified(amount, acc);
    }

    // ---------------------------------------------------------------- admin

    /// @notice Change the allowance rate (owner, through the timelock).
    function setRate(uint256 microUsdPerAnmoPerDay_) external onlyOwner {
        microUsdPerAnmoPerDay = microUsdPerAnmoPerDay_;
        emit RateSet(microUsdPerAnmoPerDay_);
    }

    /// @notice Change the guardian (owner, through the timelock).
    function setGuardian(address guardian_) external onlyOwner {
        _setGuardian(guardian_);
    }

    /// @notice Stop new stakes (guardian or owner). Unstaking and withdrawals keep working.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _pause();
    }

    /// @notice Resume staking (owner, through the timelock).
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice ANMO held beyond staked principal (credit tokens and anything sent here directly).
    function excess() public view returns (uint256) {
        return anmo.balanceOf(address(this)) - totalStaked - totalPending;
    }

    /// @notice Move the excess to `to` (owner, through the timelock). Never touches principal.
    function sweepExcess(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = excess();
        if (amount != 0) anmo.safeTransfer(to, amount);
        emit ExcessSwept(to, amount);
    }

    // ---------------------------------------------------------------- internal

    function _settle(Position storage p) private {
        if (p.active != 0) p.creditAccrued += _debt(p.active) - p.creditDebt;
    }

    /// @dev Kept scaled (not divided by PRECISION) so a position's credit is floored once, in `creditOf`.
    /// The sum of every `creditOf` therefore never exceeds `totalCredit`.
    function _debt(uint256 active) private view returns (uint256) {
        return active * accCreditPerShare;
    }

    function _setGuardian(address guardian_) private {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }
}
