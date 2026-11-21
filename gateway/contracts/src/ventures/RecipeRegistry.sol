// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {VenturesGuarded} from "./VenturesOwned.sol";

/// @title RecipeRegistry
/// @notice Recipes and their creator payouts.
///  - `publish` registers a recipe hash with its per-run creator fee in USDG. The creator publishes it, or the
///    gateway signer publishes it on the creator's behalf. Paused with new payments.
///  - `recordRun` (gateway signer only) records one paid run per `orderId` and owes the creator the recipe's fee.
///    Not paused: it books runs that were already paid for.
///  - `fund` (anyone; in practice the workers bucket) adds USDG to the payout pool.
///  - `claim` pays the caller what they are owed, up to what the pool holds. It never reverts, paused or not;
///    with nothing to pay it pays 0. Payouts are first come, first served when the pool is short.
contract RecipeRegistry is VenturesGuarded, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Recipe {
        bytes32 recipeHash;
        address creator;
        uint256 priceUsdg; // creator fee per run, USDG units
        uint256 runs;
    }

    IERC20 public immutable usdg;

    /// @notice The gateway's hot key: records runs, may publish for creators.
    address public signer;
    uint256 public recipeCount;
    /// @notice Total owed to creators and not yet paid.
    uint256 public totalOwed;

    mapping(uint256 recipeId => Recipe) public recipes;
    mapping(bytes32 recipeHash => uint256) public recipeIdOf;
    mapping(bytes32 orderId => uint256) public runRecipeOf; // 0 = not recorded
    mapping(address creator => uint256) public owedOf;
    mapping(address creator => uint256) public paidOf;

    event Published(uint256 indexed recipeId, bytes32 indexed recipeHash, address indexed creator, uint256 priceUsdg);
    event RunRecorded(
        uint256 indexed recipeId, bytes32 indexed orderId, address indexed creator, uint256 priceUsdg, uint256 runs
    );
    event Funded(address indexed from, uint256 amount);
    event Claimed(address indexed creator, uint256 amount);
    event SignerSet(address indexed signer);

    error NotSigner();
    error NotCreatorOrSigner();
    error AlreadyPublished(uint256 recipeId);
    error UnknownRecipe(uint256 recipeId);
    error RunAlreadyRecorded(bytes32 orderId);
    error ZeroHash();
    error ZeroAmount();

    constructor(IERC20 usdg_, address timelock_, address guardian_, address signer_)
        VenturesGuarded(timelock_, guardian_)
    {
        if (address(usdg_) == address(0)) revert ZeroAddress();
        usdg = usdg_;
        _setSigner(signer_);
    }

    /// @notice Register a recipe. Returns its id (from 1).
    function publish(bytes32 recipeHash, uint256 priceUsdg, address creator)
        external
        whenNotPaused
        returns (uint256 recipeId)
    {
        if (creator == address(0)) revert ZeroAddress();
        if (recipeHash == bytes32(0)) revert ZeroHash();
        if (msg.sender != creator && msg.sender != signer) revert NotCreatorOrSigner();
        uint256 existing = recipeIdOf[recipeHash];
        if (existing != 0) revert AlreadyPublished(existing);
        recipeId = ++recipeCount;
        recipes[recipeId] = Recipe(recipeHash, creator, priceUsdg, 0);
        recipeIdOf[recipeHash] = recipeId;
        emit Published(recipeId, recipeHash, creator, priceUsdg);
    }

    /// @notice Record one paid run of `recipeId` for `orderId` (gateway signer only, once per order).
    function recordRun(uint256 recipeId, bytes32 orderId) external {
        if (msg.sender != signer) revert NotSigner();
        Recipe storage r = recipes[recipeId];
        if (r.creator == address(0)) revert UnknownRecipe(recipeId);
        if (runRecipeOf[orderId] != 0) revert RunAlreadyRecorded(orderId);
        runRecipeOf[orderId] = recipeId;
        uint256 runs = ++r.runs;
        owedOf[r.creator] += r.priceUsdg;
        totalOwed += r.priceUsdg;
        emit RunRecorded(recipeId, orderId, r.creator, r.priceUsdg, runs);
    }

    /// @notice Add `amount` USDG to the payout pool.
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice Pay the caller what they are owed, up to the pool. Never paused and never reverts.
    function claim() external nonReentrant returns (uint256 amount) {
        amount = Math.min(owedOf[msg.sender], usdg.balanceOf(address(this)));
        if (amount != 0) {
            owedOf[msg.sender] -= amount;
            paidOf[msg.sender] += amount;
            totalOwed -= amount;
            usdg.safeTransfer(msg.sender, amount);
        }
        emit Claimed(msg.sender, amount);
    }

    /// @notice What `creator` could claim now.
    function claimableOf(address creator) external view returns (uint256) {
        return Math.min(owedOf[creator], usdg.balanceOf(address(this)));
    }

    /// @notice Change the gateway signer (owner, through the 7-day timelock).
    function setSigner(address signer_) external onlyOwner {
        _setSigner(signer_);
    }

    function _setSigner(address signer_) private {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerSet(signer_);
    }
}
