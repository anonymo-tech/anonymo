// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TimelockOwned} from "./TimelockOwned.sol";
import {IStakerCredit} from "./interfaces/IAnonymo.sol";

/// @title FeeRouter
/// @notice Splits every ANMO-denominated spend 80/10/5/5: worker pool, treasury, stakers (as API credit in the
/// CreditPass) and burn. Rounding dust goes to the treasury, so the four parts always sum to the input and
/// nothing stays in the router. With no active stake the stakers' part goes to the treasury.
/// @dev "Burn" sends to the dead address: ANMO has no burn function and its total supply never changes.
contract FeeRouter is TimelockOwned, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant WORKER_BPS = 8_000;
    uint256 public constant TREASURY_BPS = 1_000;
    uint256 public constant STAKERS_BPS = 500;
    uint256 public constant BURN_BPS = 500;
    uint256 private constant BPS = 10_000;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable anmo;
    IStakerCredit public immutable creditPass;

    address public workerPool;
    address public treasury;

    event Routed(
        address indexed payer,
        bytes32 indexed ref,
        uint256 amount,
        uint256 toWorkers,
        uint256 toTreasury,
        uint256 toStakers,
        uint256 burned
    );
    event WorkerPoolSet(address indexed workerPool);
    event TreasurySet(address indexed treasury);

    error ZeroAddress();
    error ZeroAmount();

    /// @param anmo_ The ANMO token.
    /// @param creditPass_ The CreditPass that receives the stakers' part.
    /// @param timelock_ Owner, a TimelockController with a delay of at least 48 hours.
    /// @param workerPool_ Receives 80%.
    /// @param treasury_ Receives 10% plus rounding dust.
    constructor(IERC20 anmo_, IStakerCredit creditPass_, address timelock_, address workerPool_, address treasury_)
        TimelockOwned(timelock_)
    {
        if (address(anmo_) == address(0) || address(creditPass_) == address(0)) revert ZeroAddress();
        anmo = anmo_;
        creditPass = creditPass_;
        _setWorkerPool(workerPool_);
        _setTreasury(treasury_);
    }

    /// @notice The split of `amount`. The four parts always sum to `amount`.
    function split(uint256 amount)
        public
        pure
        returns (uint256 toWorkers, uint256 toTreasury, uint256 toStakers, uint256 burned)
    {
        toWorkers = (amount * WORKER_BPS) / BPS;
        toStakers = (amount * STAKERS_BPS) / BPS;
        burned = (amount * BURN_BPS) / BPS;
        toTreasury = amount - toWorkers - toStakers - burned; // 10% plus dust
    }

    /// @notice Pull `amount` ANMO from the caller and split it. `ref` is an opaque reference for the gateway
    /// (for example the spend's ledger id).
    function route(uint256 amount, bytes32 ref) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        anmo.safeTransferFrom(msg.sender, address(this), amount);
        (uint256 toWorkers, uint256 toTreasury, uint256 toStakers, uint256 burned) = split(amount);
        if (toStakers != 0 && creditPass.totalStaked() == 0) {
            toTreasury += toStakers;
            toStakers = 0;
        }
        anmo.safeTransfer(workerPool, toWorkers);
        anmo.safeTransfer(treasury, toTreasury);
        anmo.safeTransfer(BURN_ADDRESS, burned);
        if (toStakers != 0) {
            anmo.forceApprove(address(creditPass), toStakers);
            creditPass.notifyCredit(toStakers);
        }
        emit Routed(msg.sender, ref, amount, toWorkers, toTreasury, toStakers, burned);
    }

    /// @notice Send any ANMO left in the router (sent to it directly) to the treasury. Anyone may call.
    function sweep() external nonReentrant {
        uint256 bal = anmo.balanceOf(address(this));
        if (bal != 0) anmo.safeTransfer(treasury, bal);
    }

    /// @notice Change the worker pool (owner, through the timelock).
    function setWorkerPool(address workerPool_) external onlyOwner {
        _setWorkerPool(workerPool_);
    }

    /// @notice Change the treasury (owner, through the timelock).
    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    function _setWorkerPool(address workerPool_) private {
        if (workerPool_ == address(0)) revert ZeroAddress();
        workerPool = workerPool_;
        emit WorkerPoolSet(workerPool_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }
}
