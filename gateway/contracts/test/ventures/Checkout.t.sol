// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Checkout} from "../../src/ventures/Checkout.sol";
import {PriceGuard} from "../../src/ventures/PriceGuard.sol";
import {MockUSDG} from "../../src/ventures/mocks/MockUSDG.sol";
import {VenturesBase} from "./VenturesBase.sol";

contract CheckoutTest is VenturesBase {
    address payer;
    uint256 payerKey;
    address relayer = makeAddr("relayer");
    bytes32 constant VENTURE = keccak256("venture.sample");

    function setUp() public {
        _deployVentures();
        (payer, payerKey) = makeAddrAndKey("payer");
        usdg.mint(payer, 1_000e6);
        vm.prank(nymoTreasury);
        nymo.transfer(payer, 1_000_000e18);
        _setSkuPrice(SKU, SKU_PRICE);
    }

    // ------------------------------------------------------------ USDG

    function test_payUSDG_routesSplitAndEmits() public {
        Checkout.ReceiveAuth memory a = _receiveAuth(payerKey, SKU, 2, VENTURE, bytes32("s1"), 40e6);
        bytes32 expectedId = keccak256(abi.encode(block.chainid, address(checkout), uint256(1)));
        vm.expectEmit(address(checkout));
        emit Checkout.Paid(expectedId, SKU, payer, 2, 40e6, Checkout.Currency.USDG, VENTURE);
        vm.prank(relayer);
        bytes32 orderId = checkout.payUSDG(SKU, 2, VENTURE, a);
        assertEq(orderId, expectedId);
        assertEq(usdg.balanceOf(payer), 960e6);
        assertEq(usdg.balanceOf(workers), 32e6);
        assertEq(usdg.balanceOf(treasury), 4e6);
        assertEq(usdg.balanceOf(stakerCredits), 2e6);
        assertEq(usdg.balanceOf(buyBurn), 2e6);
        assertEq(usdg.balanceOf(address(checkout)), 0);
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(usdg.allowance(address(checkout), address(router)), 0);
    }

    function test_payUSDG_replayReverts() public {
        Checkout.ReceiveAuth memory a = _receiveAuth(payerKey, SKU, 1, 0, bytes32("s1"), 20e6);
        checkout.payUSDG(SKU, 1, 0, a);
        vm.expectRevert(MockUSDG.AuthorizationAlreadyUsed.selector);
        checkout.payUSDG(SKU, 1, 0, a);
    }

    function test_payUSDG_nonceBindsOrder() public {
        bytes32 other = keccak256("sku.other");
        _setSkuPrice(other, SKU_PRICE);
        Checkout.ReceiveAuth memory a = _receiveAuth(payerKey, SKU, 1, 0, bytes32("s1"), 20e6);
        // Same total, different SKU: refused.
        vm.expectRevert(Checkout.NonceNotBound.selector);
        checkout.payUSDG(other, 1, 0, a);
        // Different venture: refused.
        vm.expectRevert(Checkout.NonceNotBound.selector);
        checkout.payUSDG(SKU, 1, VENTURE, a);
    }

    function test_payUSDG_wrongValueReverts() public {
        Checkout.ReceiveAuth memory a = _receiveAuth(payerKey, SKU, 1, 0, bytes32("s1"), 19e6);
        vm.expectRevert(abi.encodeWithSelector(Checkout.AmountMismatch.selector, 20e6, 19e6));
        checkout.payUSDG(SKU, 1, 0, a);
    }

    function test_payUSDG_forgedSignatureReverts() public {
        (, uint256 otherKey) = makeAddrAndKey("other");
        Checkout.ReceiveAuth memory a = _receiveAuth(otherKey, SKU, 1, 0, bytes32("s1"), 20e6);
        a.from = payer; // signed by someone else
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        checkout.payUSDG(SKU, 1, 0, a);
    }

    function test_payUSDG_authCannotBeUsedOutsideCheckout() public {
        Checkout.ReceiveAuth memory a = _receiveAuth(payerKey, SKU, 1, 0, bytes32("s1"), 20e6);
        // A watcher calling the token directly is refused: `to` must be the caller.
        vm.prank(relayer);
        vm.expectRevert(MockUSDG.CallerMustBePayee.selector);
        usdg.receiveWithAuthorization(
            payer, address(checkout), 20e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s
        );
    }

    function test_payUSDG_unknownSkuAndZeroQty() public {
        Checkout.ReceiveAuth memory a = _receiveAuth(payerKey, SKU, 0, 0, bytes32("s1"), 0);
        vm.expectRevert(Checkout.ZeroQuantity.selector);
        checkout.payUSDG(SKU, 0, 0, a);
        vm.expectRevert(abi.encodeWithSelector(Checkout.UnknownSku.selector, keccak256("nope")));
        checkout.payUSDG(keccak256("nope"), 1, 0, a);
    }

    function test_paused_blocksBothPayments() public {
        vm.prank(safe);
        checkout.pause();
        Checkout.ReceiveAuth memory a = _receiveAuth(payerKey, SKU, 1, 0, bytes32("s1"), 20e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        checkout.payUSDG(SKU, 1, 0, a);
        Checkout.Permit memory p = _permit(payerKey, address(checkout), 1_000e18, vm.getBlockTimestamp() + 1);
        vm.prank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        checkout.payNYMO(SKU, 1, 0, p);
    }

    // ------------------------------------------------------------ NYMO

    function test_payNYMO_discountAtTwapAndBurns() public {
        // 20 USDG * 75% = 15 USDG at 0.05 USDG per NYMO = 300 NYMO.
        assertEq(checkout.quoteNYMO(SKU, 1), 300e18);
        uint256 outside0 = _outsideBurn();
        Checkout.Permit memory p = _permit(payerKey, address(checkout), 300e18, vm.getBlockTimestamp() + 1);
        vm.expectEmit(address(checkout));
        emit Checkout.Paid(
            keccak256(abi.encode(block.chainid, address(checkout), uint256(1))),
            SKU,
            payer,
            1,
            300e18,
            Checkout.Currency.NYMO,
            0
        );
        vm.prank(payer);
        checkout.payNYMO(SKU, 1, 0, p);
        assertEq(nymo.balanceOf(DEAD), 300e18);
        assertEq(nymo.balanceOf(payer), 1_000_000e18 - 300e18);
        assertEq(nymo.balanceOf(address(checkout)), 0);
        assertEq(_outsideBurn(), outside0 - 300e18);
    }

    function test_payNYMO_frontRunPermitStillPays() public {
        Checkout.Permit memory p = _permit(payerKey, address(checkout), 300e18, vm.getBlockTimestamp() + 1);
        nymo.permit(payer, address(checkout), p.value, p.deadline, p.v, p.r, p.s); // front-run
        vm.prank(payer);
        checkout.payNYMO(SKU, 1, 0, p);
        assertEq(nymo.balanceOf(DEAD), 300e18);
    }

    function test_payNYMO_existingAllowanceWithoutPermit() public {
        vm.prank(payer);
        nymo.approve(address(checkout), 300e18);
        Checkout.Permit memory p;
        p.value = 300e18;
        vm.prank(payer);
        checkout.payNYMO(SKU, 1, 0, p);
        assertEq(nymo.balanceOf(DEAD), 300e18);
    }

    function test_payNYMO_slippageCap() public {
        Checkout.Permit memory p = _permit(payerKey, address(checkout), 299e18, vm.getBlockTimestamp() + 1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(Checkout.SlippageExceeded.selector, 300e18, 299e18));
        checkout.payNYMO(SKU, 1, 0, p);
    }

    function test_payNYMO_gapExactlyFivePercentPasses() public {
        oracle.set(PRICE, PRICE * 105 / 100);
        assertGt(checkout.quoteNYMO(SKU, 1), 0);
        oracle.set(PRICE, PRICE * 95 / 100);
        assertGt(checkout.quoteNYMO(SKU, 1), 0);
    }

    function test_payNYMO_gapAboveFivePercentReverts() public {
        uint256 spot = PRICE * 105 / 100 + 1;
        oracle.set(PRICE, spot);
        Checkout.Permit memory p = _permit(payerKey, address(checkout), 1_000e18, vm.getBlockTimestamp() + 1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.PriceGap.selector, PRICE, spot));
        checkout.payNYMO(SKU, 1, 0, p);
    }

    function test_payNYMO_zeroPriceReverts() public {
        oracle.set(0, 0);
        vm.expectRevert(PriceGuard.BadPrice.selector);
        checkout.quoteNYMO(SKU, 1);
    }

    /// payNYMO reverts whenever |twap - spot| / twap > 5%, and otherwise charges ceil(75% of price / twap).
    function testFuzz_payNYMO_spotGuard(uint256 twap, uint256 spot) public {
        twap = bound(twap, 1e12, 1e24);
        spot = bound(spot, 1, 2e24);
        oracle.set(twap, spot);
        uint256 gap = twap > spot ? twap - spot : spot - twap;
        Checkout.Permit memory p;
        p.value = type(uint256).max;
        vm.prank(payer);
        nymo.approve(address(checkout), type(uint256).max);
        uint256 outside0 = _outsideBurn();
        if (gap * 10_000 > twap * 500) {
            vm.prank(payer);
            vm.expectRevert(abi.encodeWithSelector(PriceGuard.PriceGap.selector, twap, spot));
            checkout.payNYMO(SKU, 1, 0, p);
        } else {
            uint256 due = (15e6 * 1e30 + twap - 1) / twap;
            if (due > nymo.balanceOf(payer)) return;
            vm.prank(payer);
            checkout.payNYMO(SKU, 1, 0, p);
            assertEq(nymo.balanceOf(DEAD), due);
            assertEq(_outsideBurn(), outside0 - due);
        }
    }

    // ------------------------------------------------------------ admin

    function test_setters_onlyThroughTimelock() public {
        vm.startPrank(safe);
        vm.expectRevert();
        checkout.setSkuPrice(SKU, 1);
        vm.expectRevert();
        checkout.setOracle(oracle);
        vm.stopPrank();
        _setSkuPrice(SKU, 7e6);
        assertEq(checkout.skuPrice(SKU), 7e6);
        _setSkuPrice(SKU, 0);
        vm.expectRevert(abi.encodeWithSelector(Checkout.UnknownSku.selector, SKU));
        checkout.priceOf(SKU, 1);
    }
}
