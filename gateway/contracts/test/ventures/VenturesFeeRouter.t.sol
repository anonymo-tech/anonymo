// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VenturesFeeRouter} from "../../src/ventures/VenturesFeeRouter.sol";
import {VenturesBase} from "./VenturesBase.sol";

contract VenturesFeeRouterTest is VenturesBase {
    address payer = makeAddr("payer");

    function setUp() public {
        _deployVentures();
        _fundUsdg(payer, 1e30);
    }

    function test_bpsSumToTenThousand() public view {
        assertEq(
            router.WORKERS_BPS() + router.TREASURY_BPS() + router.STAKER_CREDITS_BPS() + router.BUY_BURN_BPS(),
            10_000
        );
        assertEq(router.WORKERS_BPS(), 8_000);
        assertEq(router.TREASURY_BPS(), 1_000);
        assertEq(router.STAKER_CREDITS_BPS(), 500);
        assertEq(router.BUY_BURN_BPS(), 500);
    }

    function test_split_exact() public view {
        (uint256 w, uint256 t, uint256 s, uint256 b) = router.split(100e6);
        assertEq(w, 80e6);
        assertEq(t, 10e6);
        assertEq(s, 5e6);
        assertEq(b, 5e6);
    }

    function test_split_dustToTreasury() public view {
        (uint256 w, uint256 t, uint256 s, uint256 b) = router.split(19);
        assertEq(w, 15);
        assertEq(s, 0);
        assertEq(b, 0);
        assertEq(t, 4);
    }

    function testFuzz_splitSumsExactly(uint256 amount) public view {
        amount = bound(amount, 0, type(uint256).max / 10_000);
        (uint256 w, uint256 t, uint256 s, uint256 b) = router.split(amount);
        assertEq(w + t + s + b, amount);
        assertGe(t, (amount * 1_000) / 10_000);
        assertLe(t, (amount * 1_000) / 10_000 + 3);
    }

    function testFuzz_routeConserves(uint256 amount) public {
        amount = bound(amount, 1, 1e30);
        (uint256 w, uint256 t, uint256 s, uint256 b) = router.split(amount);
        vm.expectEmit(address(router));
        emit VenturesFeeRouter.Routed(payer, bytes32("ref"), amount, w, t, s, b);
        vm.prank(payer);
        router.route(amount, bytes32("ref"));
        assertEq(
            usdg.balanceOf(workers) + usdg.balanceOf(treasury) + usdg.balanceOf(stakerCredits)
                + usdg.balanceOf(buyBurn),
            amount
        );
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function test_route_zeroReverts() public {
        vm.prank(payer);
        vm.expectRevert(VenturesFeeRouter.ZeroAmount.selector);
        router.route(0, 0);
    }

    function test_sweep() public {
        usdg.mint(address(router), 5);
        router.sweep();
        assertEq(usdg.balanceOf(treasury), 5);
    }

    function test_setters_throughTimelock() public {
        address next = makeAddr("next");
        vm.prank(safe);
        vm.expectRevert();
        router.setWorkers(next);
        _viaTimelock(address(router), abi.encodeCall(VenturesFeeRouter.setWorkers, (next)));
        _viaTimelock(address(router), abi.encodeCall(VenturesFeeRouter.setTreasury, (next)));
        _viaTimelock(address(router), abi.encodeCall(VenturesFeeRouter.setStakerCredits, (next)));
        _viaTimelock(address(router), abi.encodeCall(VenturesFeeRouter.setBuyBurn, (next)));
        vm.prank(payer);
        router.route(100e6, 0);
        assertEq(usdg.balanceOf(next), 100e6);
    }
}
