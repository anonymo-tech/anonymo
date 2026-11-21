// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {VenturesGuarded} from "./VenturesOwned.sol";
import {PriceGuard} from "./PriceGuard.sol";
import {IERC3009, IPriceOracle, IVenturesFeeRouter} from "./interfaces/IVentures.sol";

/// @title Checkout
/// @notice Pays for Ventures SKUs (prices in USDG, 6 decimals, set through the 7-day timelock).
///  - `payUSDG` takes an EIP-3009 `receiveWithAuthorization` signed by the payer and forwards the whole amount to
///    the VenturesFeeRouter (80/10/5/5). The authorization's nonce must commit to the order
///    (`orderNonce(sku, qty, ventureId, salt)`), so a relayer cannot reuse a signature for another SKU, quantity
///    or venture.
///  - `payNYMO` charges 75% of the USDG price (25% discount) in NYMO at the 30-minute TWAP, refuses a TWAP that
///    is more than 5% from spot, and burns the NYMO (sends it to the dead address) in the same call. NYMO is this
///    repo's ANMO token, passed in as `nymo`; it has a fixed supply, so "burn" is a transfer to 0x...dEaD.
/// Pausing stops both. Every order gets a unique `orderId`, emitted in `Paid`.
contract Checkout is VenturesGuarded, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum Currency {
        USDG,
        NYMO
    }

    /// @notice An EIP-3009 ReceiveWithAuthorization from `from` to this contract. `nonce` must equal
    /// `orderNonce(sku, qty, ventureId, salt)`.
    struct ReceiveAuth {
        address from;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 salt;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice An EIP-2612 permit for this contract. `value` doubles as the most NYMO the payer accepts to pay;
    /// `deadline == 0` skips the permit and uses an existing allowance.
    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    uint256 public constant NYMO_DISCOUNT_BPS = 2_500;
    uint256 private constant BPS = 10_000;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable usdg;
    IERC20 public immutable nymo;
    IVenturesFeeRouter public immutable feeRouter;

    IPriceOracle public oracle;
    uint256 public orderCount;
    /// @notice USDG (6 decimals) per unit; 0 = not for sale.
    mapping(bytes32 sku => uint256) public skuPrice;

    /// @param amount USDG units for USDG, NYMO wei burned for NYMO.
    event Paid(
        bytes32 indexed orderId,
        bytes32 indexed sku,
        address indexed payer,
        uint256 qty,
        uint256 amount,
        Currency currency,
        bytes32 ventureId
    );
    event SkuPriceSet(bytes32 indexed sku, uint256 priceUsdg);
    event OracleSet(address indexed oracle);

    error UnknownSku(bytes32 sku);
    error ZeroQuantity();
    error AmountMismatch(uint256 expected, uint256 authorized);
    error NonceNotBound();
    error SlippageExceeded(uint256 required, uint256 max);

    /// @param usdg_ USDG (EIP-3009).
    /// @param nymo_ NYMO (this repo's ANMO, EIP-2612).
    constructor(
        IERC20 usdg_,
        IERC20 nymo_,
        IPriceOracle oracle_,
        IVenturesFeeRouter feeRouter_,
        address timelock_,
        address guardian_
    ) VenturesGuarded(timelock_, guardian_) {
        if (address(usdg_) == address(0) || address(nymo_) == address(0) || address(feeRouter_) == address(0)) {
            revert ZeroAddress();
        }
        usdg = usdg_;
        nymo = nymo_;
        feeRouter = feeRouter_;
        _setOracle(oracle_);
    }

    // ---------------------------------------------------------------- pay

    /// @notice Pay in USDG with an EIP-3009 authorization; anyone may relay it. `ventureId` is optional (0).
    function payUSDG(bytes32 sku, uint256 qty, bytes32 ventureId, ReceiveAuth calldata auth)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 orderId)
    {
        uint256 amount = priceOf(sku, qty);
        if (auth.value != amount) revert AmountMismatch(amount, auth.value);
        if (auth.nonce != orderNonce(sku, qty, ventureId, auth.salt)) revert NonceNotBound();
        orderId = _nextOrderId();
        emit Paid(orderId, sku, auth.from, qty, amount, Currency.USDG, ventureId); // reverts with the payment
        IERC3009(address(usdg)).receiveWithAuthorization(
            auth.from, address(this), amount, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s
        );
        usdg.forceApprove(address(feeRouter), amount);
        feeRouter.route(amount, orderId);
    }

    /// @notice Pay in NYMO at the guarded 30-minute TWAP with the 25% discount; the NYMO is burned.
    function payNYMO(bytes32 sku, uint256 qty, bytes32 ventureId, Permit calldata permit)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 orderId)
    {
        uint256 amount = quoteNYMO(sku, qty);
        if (amount > permit.value) revert SlippageExceeded(amount, permit.value);
        orderId = _nextOrderId();
        emit Paid(orderId, sku, msg.sender, qty, amount, Currency.NYMO, ventureId); // reverts with the payment
        if (permit.deadline != 0) {
            // A front-run permit leaves the allowance in place, so a failure here is not fatal.
            try IERC20Permit(address(nymo)).permit(
                msg.sender, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s
            ) {} catch {}
        }
        nymo.safeTransferFrom(msg.sender, BURN_ADDRESS, amount);
    }

    // ---------------------------------------------------------------- views

    /// @notice USDG due for `qty` of `sku`. Reverts for an unknown SKU or zero quantity.
    function priceOf(bytes32 sku, uint256 qty) public view returns (uint256) {
        if (qty == 0) revert ZeroQuantity();
        uint256 unit = skuPrice[sku];
        if (unit == 0) revert UnknownSku(sku);
        return unit * qty;
    }

    /// @notice NYMO wei due for `qty` of `sku` now (discounted, at the guarded TWAP, rounded up).
    function quoteNYMO(bytes32 sku, uint256 qty) public view returns (uint256) {
        uint256 usdgDue = Math.mulDiv(priceOf(sku, qty), BPS - NYMO_DISCOUNT_BPS, BPS, Math.Rounding.Ceil);
        return PriceGuard.nymoFor(usdgDue, PriceGuard.guardedTwap(oracle));
    }

    /// @notice The EIP-3009 nonce a payer signs for an order.
    function orderNonce(bytes32 sku, uint256 qty, bytes32 ventureId, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(sku, qty, ventureId, salt));
    }

    // ---------------------------------------------------------------- admin

    /// @notice Set a SKU's unit price in USDG (owner, through the 7-day timelock). 0 delists it.
    function setSkuPrice(bytes32 sku, uint256 priceUsdg) external onlyOwner {
        skuPrice[sku] = priceUsdg;
        emit SkuPriceSet(sku, priceUsdg);
    }

    /// @notice Change the price oracle (owner, through the 7-day timelock).
    function setOracle(IPriceOracle oracle_) external onlyOwner {
        _setOracle(oracle_);
    }

    function _setOracle(IPriceOracle oracle_) private {
        if (address(oracle_) == address(0)) revert ZeroAddress();
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }

    function _nextOrderId() private returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), ++orderCount));
    }
}
