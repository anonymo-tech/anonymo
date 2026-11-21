// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {VenturesGuarded} from "./VenturesOwned.sol";

/// @title BuildFuel
/// @notice Lock NYMO (this repo's ANMO, passed in as `token`) for daily build credits. Credits are not tokens and
/// never leave the gateway: it reads `Locked` / `Unlocked` and credits `locked * fuelRate / 1e18` build credits
/// a day, non-transferable. `unlock` is immediate and never paused; pausing stops new locks only. `fuelRate`
/// changes only through the 7-day timelock.
contract BuildFuel is VenturesGuarded, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    /// @notice Build credits a day per whole NYMO (1e18 wei) locked.
    uint256 public fuelRate;
    uint256 public totalLocked;
    mapping(address account => uint256) public lockedOf;

    /// @param total The account's locked balance after the change.
    event Locked(address indexed account, uint256 amount, uint256 total);
    event Unlocked(address indexed account, uint256 amount, uint256 total);
    event FuelRateSet(uint256 fuelRate);

    error ZeroAmount();
    error InsufficientLock(uint256 locked);

    /// @param token_ NYMO (this repo's ANMO).
    /// @param timelock_ Owner: a timelock with at least a 7-day delay.
    /// @param guardian_ Pause-only role (the Safe).
    /// @param fuelRate_ Initial build credits a day per locked NYMO.
    constructor(IERC20 token_, address timelock_, address guardian_, uint256 fuelRate_)
        VenturesGuarded(timelock_, guardian_)
    {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
        fuelRate = fuelRate_;
        emit FuelRateSet(fuelRate_);
    }

    /// @notice Lock `amount` NYMO. Paused with new payments.
    function lock(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 total = lockedOf[msg.sender] + amount;
        lockedOf[msg.sender] = total;
        totalLocked += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Locked(msg.sender, amount, total);
    }

    /// @notice Unlock `amount` NYMO at once. Never paused; no role can block it.
    function unlock(uint256 amount) external nonReentrant {
        uint256 locked = lockedOf[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (amount > locked) revert InsufficientLock(locked);
        uint256 total = locked - amount;
        lockedOf[msg.sender] = total;
        totalLocked -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Unlocked(msg.sender, amount, total);
    }

    /// @notice Build credits a day the account's lock earns at the current rate.
    function dailyFuelOf(address account) external view returns (uint256) {
        return (lockedOf[account] * fuelRate) / 1e18;
    }

    /// @notice Change the rate (owner, through the 7-day timelock).
    function setFuelRate(uint256 fuelRate_) external onlyOwner {
        fuelRate = fuelRate_;
        emit FuelRateSet(fuelRate_);
    }
}
