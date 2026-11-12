// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FeeRouter} from "../../src/anonymo/FeeRouter.sol";
import {TokenFixture} from "./CreditPass.t.sol";

contract FeeRouterTest is TokenFixture {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        _deployTokens();
    }

    function test_split_exact() public view {
        (uint256 w, uint256 t, uint256 s, uint256 b) = fees.split(1_000e18);
        assertEq(w, 800e18);
        assertEq(t, 100e18);
        assertEq(s, 50e18);
        assertEq(b, 50e18);
    }

    function test_split_dustGoesToTreasury() public view {
        // 19 wei: 80% = 15.2 -> 15, 5% = 0.95 -> 0, 5% -> 0, treasury = 19 - 15 = 4 (10% + dust)
        (uint256 w, uint256 t, uint256 s, uint256 b) = fees.split(19);
        assertEq(w, 15);
        assertEq(s, 0);
        assertEq(b, 0);
        assertEq(t, 4);
    }

    /// The FeeRouter split always sums to the input.
    function testFuzz_splitAlwaysSumsToInput(uint256 amount) public view {
        amount = bound(amount, 0, type(uint256).max / 10_000);
        (uint256 w, uint256 t, uint256 s, uint256 b) = fees.split(amount);
        assertEq(w + t + s + b, amount);
        // treasury gets at least its 10% and less than 10% + 3 wei of dust
        assertGe(t, (amount * 1_000) / 10_000);
        assertLe(t, (amount * 1_000) / 10_000 + 3);
    }

    function test_route_withStakers() public {
        _stake(alice, 100e18);
        uint256 t0 = anmo.balanceOf(treasury);
        vm.expectEmit(address(fees));
        emit FeeRouter.Routed(payer, keccak256("spend"), 1_000e18, 800e18, 100e18, 50e18, 50e18);
        _route(1_000e18);
        assertEq(anmo.balanceOf(workers), 800e18);
        assertEq(anmo.balanceOf(treasury) - t0, 100e18);
        assertEq(anmo.balanceOf(DEAD), 50e18);
        assertEq(anmo.balanceOf(address(pass)), 100e18 + 50e18);
        assertEq(pass.totalCredit(), 50e18);
        assertEq(anmo.balanceOf(address(fees)), 0);
        assertEq(anmo.totalSupply(), anmo.TOTAL_SUPPLY());
    }

    function test_route_noStakersSendsStakerShareToTreasury() public {
        uint256 t0 = anmo.balanceOf(treasury);
        _route(1_000e18);
        assertEq(anmo.balanceOf(treasury) - t0, 150e18);
        assertEq(pass.totalCredit(), 0);
        assertEq(anmo.balanceOf(address(fees)), 0);
    }

    function testFuzz_route_conserves(uint256 amount, bool staked) public {
        amount = bound(amount, 1, 10_000_000e18);
        if (staked) _stake(alice, 1e18);
        uint256 t0 = anmo.balanceOf(treasury);
        uint256 p0 = anmo.balanceOf(address(pass));
        _route(amount);
        uint256 out = anmo.balanceOf(workers) + (anmo.balanceOf(treasury) - t0) + anmo.balanceOf(DEAD)
            + (anmo.balanceOf(address(pass)) - p0);
        assertEq(out, amount);
        assertEq(anmo.balanceOf(address(fees)), 0);
    }

    function test_route_zeroReverts() public {
        vm.prank(payer);
        vm.expectRevert(FeeRouter.ZeroAmount.selector);
        fees.route(0, bytes32(0));
    }

    function test_sweep() public {
        vm.prank(payer);
        anmo.transfer(address(fees), 5e18);
        uint256 t0 = anmo.balanceOf(treasury);
        fees.sweep();
        assertEq(anmo.balanceOf(treasury) - t0, 5e18);
    }

    function test_admin_throughTimelock() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        fees.setWorkerPool(safe);
        address nextPool = makeAddr("next-pool");
        address nextTreasury = makeAddr("next-treasury");
        _viaTimelock(address(fees), abi.encodeCall(FeeRouter.setWorkerPool, (nextPool)));
        _viaTimelock(address(fees), abi.encodeCall(FeeRouter.setTreasury, (nextTreasury)));
        _route(100e18);
        assertEq(anmo.balanceOf(nextPool), 80e18);
        assertEq(anmo.balanceOf(nextTreasury), 15e18);
    }
}
