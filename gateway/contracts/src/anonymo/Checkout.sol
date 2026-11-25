// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ANMO} from "./ANMO.sol";
import {EverydayPausable} from "./EverydayOwned.sol";
import {EverydayTimelock} from "./EverydayTimelock.sol";
import {EverydayFeeRouter} from "./EverydayFeeRouter.sol";
import {IPriceOracle, IERC3009} from "../ventures/interfaces/IVentures.sol";
import {PriceGuard} from "../ventures/PriceGuard.sol";

/// @notice Pass checkout. Each order reference is an opaque one-time value for the off-chain entitlement.
contract Checkout is EverydayPausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct ReceiveAuth {
        address from;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 orderRef;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Permit {
        bytes32 orderRef;
        uint256 value; // maximum NYMO the payer accepts
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bytes32 public constant PASS30 = bytes32("PASS30");
    bytes32 public constant PASS30_PLUS = bytes32("PASS30_PLUS");
    uint256 public constant PASS30_PRICE = 12e6;
    uint256 public constant PASS30_PLUS_PRICE = 29e6;
    uint256 public constant PASS_DURATION = 30 days;

    IERC20 public immutable usdg;
    ANMO public immutable nymo;
    EverydayFeeRouter public immutable feeRouter;
    IPriceOracle public oracle;

    mapping(bytes32 orderId => bool) public paid;

    event Paid(
        bytes32 indexed orderId,
        bytes32 indexed sku,
        address indexed payer,
        bytes32 orderRef,
        uint256 quantity,
        address token,
        uint256 amount
    );
    event OracleSet(address indexed oracle);

    error InvalidAddress();
    error UnknownSku();
    error InvalidQuantity();
    error InvalidAmount();
    error InvalidOrder();
    error AlreadyPaid();
    error SlippageExceeded(uint256 required, uint256 max);

    constructor(ANMO nymo_, EverydayFeeRouter feeRouter_, IPriceOracle oracle_, EverydayTimelock timelock_)
        EverydayPausable(timelock_)
    {
        if (address(nymo_).code.length == 0 || address(feeRouter_).code.length == 0) revert InvalidAddress();
        usdg = feeRouter_.usdg();
        nymo = nymo_;
        feeRouter = feeRouter_;
        _setOracle(oracle_);
    }

    /// @notice Anyone can relay an authorization. The EIP-3009 nonce binds the SKU, quantity and order reference.
    function payUSDG(bytes32 sku, uint256 qty, ReceiveAuth calldata auth)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 orderId)
    {
        uint256 amount = priceOf(sku, qty);
        if (auth.value != amount) revert InvalidAmount();
        orderId = _takeOrder(auth.from, auth.orderRef);
        uint256 before = usdg.balanceOf(address(this));
        IERC3009(address(usdg))
            .receiveWithAuthorization(
                auth.from,
                address(this),
                amount,
                auth.validAfter,
                auth.validBefore,
                orderNonce(sku, qty, auth.orderRef),
                auth.v,
                auth.r,
                auth.s
            );
        if (usdg.balanceOf(address(this)) - before != amount) revert InvalidAmount();
        usdg.forceApprove(address(feeRouter), amount);
        feeRouter.route(amount, orderId);
        emit Paid(orderId, sku, auth.from, auth.orderRef, qty, address(usdg), amount);
    }

    /// @notice Accept a permit or an existing allowance, then burn the NYMO directly from the payer.
    function payNYMO(bytes32 sku, uint256 qty, Permit calldata permit)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 orderId)
    {
        uint256 amount = quoteNYMO(sku, qty);
        if (amount > permit.value) revert SlippageExceeded(amount, permit.value);
        orderId = _takeOrder(msg.sender, permit.orderRef);
        if (permit.deadline != 0) {
            // A front-run permit leaves the same allowance for burnFrom.
            try nymo.permit(
                msg.sender, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s
            ) {}
                catch {}
        }
        nymo.burnFrom(msg.sender, amount);
        emit Paid(orderId, sku, msg.sender, permit.orderRef, qty, address(nymo), amount);
    }

    function priceOf(bytes32 sku, uint256 qty) public pure returns (uint256) {
        if (qty == 0) revert InvalidQuantity();
        if (sku == PASS30) return PASS30_PRICE * qty;
        if (sku == PASS30_PLUS) return PASS30_PLUS_PRICE * qty;
        revert UnknownSku();
    }

    function quoteNYMO(bytes32 sku, uint256 qty) public view returns (uint256) {
        uint256 price = priceOf(sku, qty);
        uint256 discounted = price - price / 5;
        return PriceGuard.nymoFor(discounted, PriceGuard.guardedTwap(oracle));
    }

    function orderNonce(bytes32 sku, uint256 qty, bytes32 orderRef) public pure returns (bytes32) {
        return keccak256(abi.encode(sku, qty, orderRef));
    }

    function orderIdFor(address payer, bytes32 orderRef) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), payer, orderRef));
    }

    function setOracle(IPriceOracle oracle_) external onlyOwner {
        _setOracle(oracle_);
    }

    function _takeOrder(address payer, bytes32 orderRef) private returns (bytes32 id) {
        if (payer == address(0) || orderRef == bytes32(0)) revert InvalidOrder();
        id = orderIdFor(payer, orderRef);
        if (paid[id]) revert AlreadyPaid();
        paid[id] = true;
    }

    function _setOracle(IPriceOracle oracle_) private {
        if (address(oracle_).code.length == 0) revert InvalidAddress();
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }
}
