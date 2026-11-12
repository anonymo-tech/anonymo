// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {CreditPass} from "../../src/anonymo/CreditPass.sol";
import {FeeRouter} from "../../src/anonymo/FeeRouter.sol";
import {TokenFixture} from "./CreditPass.t.sol";

/// Random stakes, unstakes, withdrawals, routed spends, pauses and plain transfers over ANMO, CreditPass and
/// FeeRouter. Every action that the rules say must work is called without try/catch, so with
/// fail_on_revert a revert there fails the run.
contract TokenEconomyHandler is CommonBase, StdUtils {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    ANMO public anmo;
    CreditPass public pass;
    FeeRouter public fees;
    address public guardian;
    address public payer;
    address[] public actors;

    uint256 public routed;
    uint256 public toWorkers;
    uint256 public toTreasury;
    uint256 public toStakers;
    uint256 public burned;
    uint256 public withdrawnTotal;
    uint256 public withdrawsWhilePaused;

    constructor(ANMO anmo_, CreditPass pass_, FeeRouter fees_, address guardian_, address payer_, address[] memory a) {
        anmo = anmo_;
        pass = pass_;
        fees = fees_;
        guardian = guardian_;
        payer = payer_;
        actors = a;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 i) internal view returns (address) {
        return actors[i % actors.length];
    }

    function stake(uint256 who, uint256 amount) external {
        address a = _actor(who);
        uint256 bal = anmo.balanceOf(a);
        (uint256 active,,,,,) = pass.positions(a);
        uint256 min = active >= pass.MIN_STAKE() ? 1 : pass.MIN_STAKE() - active;
        if (bal < min || pass.paused()) return;
        amount = bound(amount, min, bal);
        vm.prank(a);
        pass.stake(amount);
    }

    function requestUnstake(uint256 who) external {
        address a = _actor(who);
        (uint256 active,,,,,) = pass.positions(a);
        if (active == 0) return;
        vm.prank(a); // never paused
        pass.requestUnstake();
    }

    function withdraw(uint256 who) external {
        address a = _actor(who);
        (, uint256 pending, uint64 ends,,,) = pass.positions(a);
        if (pending == 0) return;
        if (block.timestamp < ends) vm.warp(ends);
        bool paused = pass.paused();
        vm.prank(a); // never paused: must not revert
        pass.withdraw();
        withdrawnTotal += pending;
        if (paused) ++withdrawsWhilePaused;
    }

    function route(uint256 amount) external {
        amount = bound(amount, 1, 50_000e18);
        if (anmo.balanceOf(payer) < amount) return;
        (uint256 w, uint256 t, uint256 s, uint256 b) = fees.split(amount);
        if (pass.totalStaked() == 0) {
            t += s;
            s = 0;
        }
        vm.prank(payer);
        fees.route(amount, bytes32(amount));
        routed += amount;
        toWorkers += w;
        toTreasury += t;
        toStakers += s;
        burned += b;
    }

    function transfer(uint256 from, uint256 to, uint256 amount) external {
        address a = _actor(from);
        uint256 bal = anmo.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 0, bal);
        vm.prank(a);
        anmo.transfer(_actor(to), amount);
    }

    function pause() external {
        if (pass.paused()) return;
        vm.prank(guardian);
        pass.pause();
    }

    function unpause() external {
        if (!pass.paused()) return;
        vm.prank(pass.owner());
        pass.unpause();
    }

    function advance(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 3 days));
    }
}

contract TokenEconomyInvariantTest is TokenFixture {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    TokenEconomyHandler handler;
    uint256 workers0;
    uint256 treasury0;

    function setUp() public {
        vm.warp(1_790_000_000);
        _deployTokens();
        address[] memory a = new address[](4);
        a[0] = alice;
        a[1] = bob;
        a[2] = makeAddr("carol");
        a[3] = makeAddr("dave");
        vm.startPrank(treasury);
        anmo.transfer(a[2], 1_000_000e18);
        anmo.transfer(a[3], 10e18);
        vm.stopPrank();
        for (uint256 i = 2; i < 4; ++i) {
            vm.prank(a[i]);
            anmo.approve(address(pass), type(uint256).max);
        }
        handler = new TokenEconomyHandler(anmo, pass, fees, safe, payer, a);
        workers0 = anmo.balanceOf(workers);
        treasury0 = anmo.balanceOf(treasury);
        targetContract(address(handler));
    }

    /// ANMO supply never changes.
    function invariant_anmoSupplyNeverChanges() public view {
        assertEq(anmo.totalSupply(), anmo.TOTAL_SUPPLY());
    }

    /// The FeeRouter split always sums to the input, and the router keeps nothing.
    function invariant_feeRouterConserves() public view {
        assertEq(
            handler.toWorkers() + handler.toTreasury() + handler.toStakers() + handler.burned(), handler.routed()
        );
        assertEq(anmo.balanceOf(address(fees)), 0);
        assertEq(anmo.balanceOf(workers) - workers0, handler.toWorkers());
        assertEq(anmo.balanceOf(treasury) - treasury0, handler.toTreasury());
        assertEq(anmo.balanceOf(DEAD), handler.burned());
        assertEq(pass.totalCredit(), handler.toStakers());
    }

    /// Staked principal is always fully backed, and the totals match the positions.
    function invariant_creditPassSolvent() public view {
        uint256 active;
        uint256 pending;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            (uint256 a, uint256 p,,,,) = pass.positions(handler.actors(i));
            active += a;
            pending += p;
        }
        assertEq(pass.totalStaked(), active);
        assertEq(pass.totalPending(), pending);
        assertEq(anmo.balanceOf(address(pass)), active + pending + pass.totalCredit());
    }

    /// Credit handed out never exceeds credit received, and rounding holds back only a few wei.
    function invariant_creditConserved() public view {
        uint256 sum;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            sum += pass.creditOf(handler.actors(i));
        }
        assertLe(sum, pass.totalCredit());
        // What is not yet handed out is only the carried remainder (under totalStaked / 1e18 wei, at most
        // ~3e6 here) plus one wei of flooring per position.
        assertLe(pass.totalCredit() - sum, 1e7);
    }

    function afterInvariant() external view {
        // Report-only: shows the paused-withdrawal path is exercised.
        handler.withdrawsWhilePaused();
    }
}
