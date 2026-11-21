// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {VenturesOwned} from "./VenturesOwned.sol";
import {IVenturesFeeRouter} from "./interfaces/IVentures.sol";

/// @title VenturesFeeRouter
/// @notice Splits every USDG payment 80/10/5/5: workers (route, sandbox and hosting costs and Recipe creators,
/// paid out off this contract and through RecipeRegistry.fund), treasury, staker credits and buy-and-burn. The
/// bps are constants. Rounding dust goes to the treasury, so the four parts always sum to the input and nothing
/// stays here. The staker-credit and buy-burn parts go to plain addresses; buying and burning NYMO happens off
/// this contract. (The repo's FeeRouter splits ANMO; this one splits USDG.) Not pausable: pausing is done at the
/// payment entry points.
contract VenturesFeeRouter is IVenturesFeeRouter, VenturesOwned, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant WORKERS_BPS = 8_000;
    uint256 public constant TREASURY_BPS = 1_000;
    uint256 public constant STAKER_CREDITS_BPS = 500;
    uint256 public constant BUY_BURN_BPS = 500;
    uint256 public constant BPS = 10_000;

    IERC20 public immutable usdg;

    address public workers;
    address public treasury;
    address public stakerCredits;
    address public buyBurn;

    event Routed(
        address indexed payer,
        bytes32 indexed ref,
        uint256 amount,
        uint256 toWorkers,
        uint256 toTreasury,
        uint256 toStakerCredits,
        uint256 toBuyBurn
    );
    event WorkersSet(address indexed workers);
    event TreasurySet(address indexed treasury);
    event StakerCreditsSet(address indexed stakerCredits);
    event BuyBurnSet(address indexed buyBurn);

    error ZeroAddress();
    error ZeroAmount();

    constructor(
        IERC20 usdg_,
        address timelock_,
        address workers_,
        address treasury_,
        address stakerCredits_,
        address buyBurn_
    ) VenturesOwned(timelock_) {
        if (address(usdg_) == address(0)) revert ZeroAddress();
        usdg = usdg_;
        _setWorkers(workers_);
        _setTreasury(treasury_);
        _setStakerCredits(stakerCredits_);
        _setBuyBurn(buyBurn_);
    }

    /// @notice The split of `amount`. The four parts always sum to `amount`; dust goes to the treasury.
    function split(uint256 amount)
        public
        pure
        returns (uint256 toWorkers, uint256 toTreasury, uint256 toStakerCredits, uint256 toBuyBurn)
    {
        toWorkers = (amount * WORKERS_BPS) / BPS;
        toStakerCredits = (amount * STAKER_CREDITS_BPS) / BPS;
        toBuyBurn = (amount * BUY_BURN_BPS) / BPS;
        toTreasury = amount - toWorkers - toStakerCredits - toBuyBurn;
    }

    /// @notice Pull `amount` USDG from the caller and split it. `ref` is an opaque reference (an order id).
    function route(uint256 amount, bytes32 ref) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        (uint256 w, uint256 t, uint256 s, uint256 b) = split(amount);
        usdg.safeTransfer(workers, w);
        usdg.safeTransfer(treasury, t);
        usdg.safeTransfer(stakerCredits, s);
        usdg.safeTransfer(buyBurn, b);
        emit Routed(msg.sender, ref, amount, w, t, s, b);
    }

    /// @notice Send USDG sent here directly to the treasury. Anyone may call.
    function sweep() external nonReentrant {
        uint256 bal = usdg.balanceOf(address(this));
        if (bal != 0) usdg.safeTransfer(treasury, bal);
    }

    function setWorkers(address a) external onlyOwner {
        _setWorkers(a);
    }

    function setTreasury(address a) external onlyOwner {
        _setTreasury(a);
    }

    function setStakerCredits(address a) external onlyOwner {
        _setStakerCredits(a);
    }

    function setBuyBurn(address a) external onlyOwner {
        _setBuyBurn(a);
    }

    function _setWorkers(address a) private {
        if (a == address(0)) revert ZeroAddress();
        workers = a;
        emit WorkersSet(a);
    }

    function _setTreasury(address a) private {
        if (a == address(0)) revert ZeroAddress();
        treasury = a;
        emit TreasurySet(a);
    }

    function _setStakerCredits(address a) private {
        if (a == address(0)) revert ZeroAddress();
        stakerCredits = a;
        emit StakerCreditsSet(a);
    }

    function _setBuyBurn(address a) private {
        if (a == address(0)) revert ZeroAddress();
        buyBurn = a;
        emit BuyBurnSet(a);
    }
}
