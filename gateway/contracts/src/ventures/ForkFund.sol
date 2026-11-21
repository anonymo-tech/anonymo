// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {VenturesGuarded} from "./VenturesOwned.sol";
import {PriceGuard} from "./PriceGuard.sol";
import {IPriceOracle, IVenturesFeeRouter} from "./interfaces/IVentures.sol";

/// @title ForkFund
/// @notice Crowdfunds a clean-room fork of a target commit.
///  - `open` starts a fund with a USDG goal and a 21-day deadline.
///  - `contribute` takes USDG or NYMO (this repo's ANMO, passed in as `nymo`). NYMO counts toward the goal at the
///    guarded 30-minute TWAP at contribution time (the value is fixed then; it is used for the goal only).
///  - `withdraw` returns a contributor's whole contribution at any time before the trigger, paused or not.
///  - `trigger` (anyone, once the goal is met and before the deadline) routes the escrowed USDG through the
///    VenturesFeeRouter and burns the escrowed NYMO (sends it to 0x...dEaD; the token has a fixed supply).
///  - `fulfil` (the gateway's fulfiller key) records the output repo. Its clean-room receipt must name the fund's
///    target commit and the same repo hash, and its licence must be MIT (`licenceSpdxHash == keccak256("MIT")`).
///  - `refund` returns a contribution once the deadline passed without a trigger. Anyone may call it; the money
///    goes only to the contributor.
/// Pausing stops `open`, `contribute` and `trigger` (new money and new runs) only.
contract ForkFund is VenturesGuarded, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Triggered,
        Fulfilled
    }

    enum Currency {
        USDG,
        NYMO
    }

    struct Fund {
        address opener;
        uint64 deadline;
        Status status;
        bytes32 targetCommit;
        bytes32 specHash;
        uint256 goalUsdg;
        uint256 usdgRaised; // escrowed USDG
        uint256 nymoRaised; // escrowed NYMO
        uint256 nymoValueUsdg; // USDG value of the escrowed NYMO at contribution-time TWAPs
        bytes32 repoHash;
    }

    struct Contribution {
        uint256 usdg;
        uint256 nymo;
        uint256 nymoValueUsdg;
    }

    /// @notice What the clean room attests for a finished fork.
    struct CleanRoomReceipt {
        bytes32 targetCommit;
        bytes32 repoHash;
        bytes32 licenceSpdxHash;
        bytes32 reportHash;
        uint64 issuedAt;
    }

    uint256 public constant FUNDING_PERIOD = 21 days;
    bytes32 public constant MIT_HASH = keccak256("MIT");
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable usdg;
    IERC20 public immutable nymo;
    IVenturesFeeRouter public immutable feeRouter;

    IPriceOracle public oracle;
    /// @notice The gateway key that records finished forks.
    address public fulfiller;
    uint256 public fundCount;
    /// @notice The least USDG (not NYMO) a fund must raise before it can trigger, and the least goal it can open with.
    /// NYMO contributions are burned at trigger, so only the USDG pays for the build: this keeps every fork's cash
    /// at or above the crew's cost. Starting value 186.25 USDG = the Build Better price ($149) over the workers'
    /// 80% share of the fee split. Changed only through the timelock.
    uint256 public minCashUsdg = 186_250_000;

    mapping(uint256 fundId => Fund) private _funds;
    mapping(uint256 fundId => mapping(address contributor => Contribution)) public contributions;

    event Opened(
        uint256 indexed fundId,
        address indexed opener,
        bytes32 indexed targetCommit,
        bytes32 specHash,
        uint256 goalUsdg,
        uint64 deadline
    );
    event Contributed(
        uint256 indexed fundId, address indexed contributor, Currency currency, uint256 amount, uint256 usdgValue
    );
    event Withdrawn(uint256 indexed fundId, address indexed contributor, uint256 usdg, uint256 nymo);
    event Triggered(uint256 indexed fundId, uint256 usdgRouted, uint256 nymoBurned, uint256 raisedUsdgValue);
    event Fulfilled(uint256 indexed fundId, bytes32 indexed repoHash, bytes32 receiptHash);
    event Refunded(uint256 indexed fundId, address indexed contributor, uint256 usdg, uint256 nymo);
    event OracleSet(address indexed oracle);
    event FulfillerSet(address indexed fulfiller);
    event MinCashSet(uint256 minCashUsdg);

    error ZeroAmount();
    error ZeroHash();
    error NotOpen(uint256 fundId);
    error NotTriggered(uint256 fundId);
    error Expired(uint256 fundId);
    error NotExpired(uint256 fundId);
    error NotFunded(uint256 raised, uint256 goal);
    error NothingToReturn();
    error NotFulfiller();
    error LicenceNotMit();
    error ReceiptMismatch();
    error GoalTooLow(uint256 goal, uint256 minimum);
    error NotEnoughCash(uint256 usdgRaised, uint256 minimum);

    constructor(
        IERC20 usdg_,
        IERC20 nymo_,
        IPriceOracle oracle_,
        IVenturesFeeRouter feeRouter_,
        address timelock_,
        address guardian_,
        address fulfiller_
    ) VenturesGuarded(timelock_, guardian_) {
        if (address(usdg_) == address(0) || address(nymo_) == address(0) || address(feeRouter_) == address(0)) {
            revert ZeroAddress();
        }
        usdg = usdg_;
        nymo = nymo_;
        feeRouter = feeRouter_;
        _setOracle(oracle_);
        _setFulfiller(fulfiller_);
    }

    // ---------------------------------------------------------------- funding

    /// @notice Open a fund for `targetCommit` described by `specHash`, with a USDG goal.
    function open(bytes32 targetCommit, bytes32 specHash, uint256 goalUsdg)
        external
        whenNotPaused
        returns (uint256 fundId)
    {
        if (targetCommit == bytes32(0) || specHash == bytes32(0)) revert ZeroHash();
        if (goalUsdg == 0) revert ZeroAmount();
        if (goalUsdg < minCashUsdg) revert GoalTooLow(goalUsdg, minCashUsdg);
        fundId = ++fundCount;
        Fund storage f = _funds[fundId];
        f.opener = msg.sender;
        f.deadline = SafeCast.toUint64(block.timestamp + FUNDING_PERIOD);
        f.status = Status.Open;
        f.targetCommit = targetCommit;
        f.specHash = specHash;
        f.goalUsdg = goalUsdg;
        emit Opened(fundId, msg.sender, targetCommit, specHash, goalUsdg, f.deadline);
    }

    /// @notice Contribute `amount` USDG or NYMO (approved to this contract) before the deadline.
    function contribute(uint256 fundId, Currency currency, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        Fund storage f = _funds[fundId];
        if (f.status != Status.Open) revert NotOpen(fundId);
        if (block.timestamp >= f.deadline) revert Expired(fundId);
        Contribution storage c = contributions[fundId][msg.sender];
        uint256 value;
        if (currency == Currency.USDG) {
            value = amount;
            f.usdgRaised += amount;
            c.usdg += amount;
            usdg.safeTransferFrom(msg.sender, address(this), amount);
        } else {
            value = PriceGuard.usdgFor(amount, PriceGuard.guardedTwap(oracle));
            f.nymoRaised += amount;
            f.nymoValueUsdg += value;
            c.nymo += amount;
            c.nymoValueUsdg += value;
            nymo.safeTransferFrom(msg.sender, address(this), amount);
        }
        emit Contributed(fundId, msg.sender, currency, amount, value);
    }

    /// @notice Take back the caller's whole contribution. Works until the trigger, paused or not.
    function withdraw(uint256 fundId) external nonReentrant {
        Fund storage f = _funds[fundId];
        if (f.status != Status.Open) revert NotOpen(fundId);
        (uint256 u, uint256 n) = _release(f, fundId, msg.sender);
        emit Withdrawn(fundId, msg.sender, u, n);
    }

    /// @notice Return `contributor`'s contribution once the deadline passed without a trigger. Anyone may call;
    /// the money goes only to the contributor. Never paused.
    function refund(uint256 fundId, address contributor) external nonReentrant {
        Fund storage f = _funds[fundId];
        if (f.status != Status.Open) revert NotOpen(fundId);
        if (block.timestamp < f.deadline) revert NotExpired(fundId);
        (uint256 u, uint256 n) = _release(f, fundId, contributor);
        emit Refunded(fundId, contributor, u, n);
    }

    /// @notice Start the fork once the goal is met (anyone, before the deadline): route the USDG, burn the NYMO.
    function trigger(uint256 fundId) external nonReentrant whenNotPaused {
        Fund storage f = _funds[fundId];
        if (f.status != Status.Open) revert NotOpen(fundId);
        if (block.timestamp >= f.deadline) revert Expired(fundId);
        uint256 raised = f.usdgRaised + f.nymoValueUsdg;
        if (raised < f.goalUsdg) revert NotFunded(raised, f.goalUsdg);
        if (f.usdgRaised < minCashUsdg) revert NotEnoughCash(f.usdgRaised, minCashUsdg);
        f.status = Status.Triggered;
        uint256 u = f.usdgRaised;
        uint256 n = f.nymoRaised;
        emit Triggered(fundId, u, n, raised);
        if (u != 0) {
            usdg.forceApprove(address(feeRouter), u);
            feeRouter.route(u, bytes32(fundId));
        }
        if (n != 0) nymo.safeTransfer(BURN_ADDRESS, n);
    }

    /// @notice Record the finished fork (fulfiller only). The receipt must match and carry an MIT licence.
    function fulfil(uint256 fundId, bytes32 repoHash, CleanRoomReceipt calldata receipt) external {
        if (msg.sender != fulfiller) revert NotFulfiller();
        Fund storage f = _funds[fundId];
        if (f.status != Status.Triggered) revert NotTriggered(fundId);
        if (repoHash == bytes32(0)) revert ZeroHash();
        if (receipt.licenceSpdxHash != MIT_HASH) revert LicenceNotMit();
        if (receipt.repoHash != repoHash || receipt.targetCommit != f.targetCommit) revert ReceiptMismatch();
        f.status = Status.Fulfilled;
        f.repoHash = repoHash;
        emit Fulfilled(fundId, repoHash, keccak256(abi.encode(receipt)));
    }

    // ---------------------------------------------------------------- views

    function funds(uint256 fundId) external view returns (Fund memory) {
        return _funds[fundId];
    }

    /// @notice USDG raised plus the USDG value of the NYMO raised.
    function raisedOf(uint256 fundId) external view returns (uint256) {
        Fund storage f = _funds[fundId];
        return f.usdgRaised + f.nymoValueUsdg;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Change the price oracle (owner, through the 7-day timelock).
    function setOracle(IPriceOracle oracle_) external onlyOwner {
        _setOracle(oracle_);
    }

    /// @notice Change the least USDG a fund must raise (owner, through the 7-day timelock).
    function setMinCash(uint256 minCashUsdg_) external onlyOwner {
        minCashUsdg = minCashUsdg_;
        emit MinCashSet(minCashUsdg_);
    }

    /// @notice Change the fulfiller key (owner, through the 7-day timelock).
    function setFulfiller(address fulfiller_) external onlyOwner {
        _setFulfiller(fulfiller_);
    }

    // ---------------------------------------------------------------- internal

    function _release(Fund storage f, uint256 fundId, address contributor) private returns (uint256 u, uint256 n) {
        Contribution storage c = contributions[fundId][contributor];
        u = c.usdg;
        n = c.nymo;
        if (u == 0 && n == 0) revert NothingToReturn();
        f.usdgRaised -= u;
        f.nymoRaised -= n;
        f.nymoValueUsdg -= c.nymoValueUsdg;
        delete contributions[fundId][contributor];
        if (u != 0) usdg.safeTransfer(contributor, u);
        if (n != 0) nymo.safeTransfer(contributor, n);
    }

    function _setOracle(IPriceOracle oracle_) private {
        if (address(oracle_) == address(0)) revert ZeroAddress();
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }

    function _setFulfiller(address fulfiller_) private {
        if (fulfiller_ == address(0)) revert ZeroAddress();
        fulfiller = fulfiller_;
        emit FulfillerSet(fulfiller_);
    }
}
