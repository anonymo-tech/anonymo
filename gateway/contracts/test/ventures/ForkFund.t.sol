// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ForkFund} from "../../src/ventures/ForkFund.sol";
import {PriceGuard} from "../../src/ventures/PriceGuard.sol";
import {VenturesBase} from "./VenturesBase.sol";

contract ForkFundTest is VenturesBase {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address opener = makeAddr("opener");
    bytes32 constant TARGET = keccak256("commit.sample");
    bytes32 constant SPEC = keccak256("spec.sample");
    bytes32 constant REPO = keccak256("repo.output");
    uint256 constant GOAL = 1_000e6;

    function setUp() public {
        _deployVentures();
        _fundUsdg(alice, 10_000e6);
        _fundUsdg(bob, 10_000e6);
        _fundNymo(alice, 1_000_000e18);
        _fundNymo(bob, 1_000_000e18);
    }

    function _open() internal returns (uint256 id) {
        vm.prank(opener);
        id = fork.open(TARGET, SPEC, GOAL);
    }

    function _give(address who, uint256 id, ForkFund.Currency c, uint256 amount) internal {
        vm.prank(who);
        fork.contribute(id, c, amount);
    }

    function _receipt() internal pure returns (ForkFund.CleanRoomReceipt memory r) {
        r.targetCommit = TARGET;
        r.repoHash = REPO;
        r.licenceSpdxHash = keccak256("MIT");
        r.reportHash = keccak256("report");
        r.issuedAt = 1;
    }

    function test_open() public {
        vm.expectEmit(address(fork));
        emit ForkFund.Opened(1, opener, TARGET, SPEC, GOAL, uint64(vm.getBlockTimestamp() + 21 days));
        uint256 id = _open();
        ForkFund.Fund memory f = fork.funds(id);
        assertEq(uint8(f.status), uint8(ForkFund.Status.Open));
        assertEq(f.goalUsdg, GOAL);
        assertEq(f.deadline, vm.getBlockTimestamp() + 21 days);
    }

    function test_contribute_nymoValuedAtTwap() public {
        uint256 id = _open();
        // 10,000 NYMO at 0.05 = 500 USDG toward the goal.
        vm.expectEmit(address(fork));
        emit ForkFund.Contributed(id, alice, ForkFund.Currency.NYMO, 10_000e18, 500e6);
        _give(alice, id, ForkFund.Currency.NYMO, 10_000e18);
        assertEq(fork.raisedOf(id), 500e6);
        // A later price change does not move the recorded value.
        oracle.set(PRICE * 2, PRICE * 2);
        assertEq(fork.raisedOf(id), 500e6);
        _give(bob, id, ForkFund.Currency.NYMO, 5_000e18);
        assertEq(fork.raisedOf(id), 1_000e6);
    }

    function test_contribute_nymoGuardedByGap() public {
        uint256 id = _open();
        oracle.set(PRICE, PRICE * 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.PriceGap.selector, PRICE, PRICE * 2));
        fork.contribute(id, ForkFund.Currency.NYMO, 1e18);
    }

    function test_withdraw_beforeTrigger_evenPaused() public {
        uint256 id = _open();
        _give(alice, id, ForkFund.Currency.USDG, 300e6);
        _give(alice, id, ForkFund.Currency.NYMO, 1_000e18);
        _pauseAll();
        vm.expectEmit(address(fork));
        emit ForkFund.Withdrawn(id, alice, 300e6, 1_000e18);
        vm.prank(alice);
        fork.withdraw(id);
        assertEq(usdg.balanceOf(alice), 10_000e6);
        assertEq(nymo.balanceOf(alice), 1_000_000e18);
        assertEq(fork.raisedOf(id), 0);
        vm.prank(alice);
        vm.expectRevert(ForkFund.NothingToReturn.selector);
        fork.withdraw(id);
    }

    function test_trigger_routesUsdgAndBurnsNymo() public {
        uint256 id = _open();
        _give(alice, id, ForkFund.Currency.USDG, 600e6);
        _give(bob, id, ForkFund.Currency.NYMO, 8_000e18); // 400 USDG
        uint256 outside0 = _outsideBurn();
        vm.expectEmit(address(fork));
        emit ForkFund.Triggered(id, 600e6, 8_000e18, 1_000e6);
        fork.trigger(id);
        assertEq(usdg.balanceOf(workers), 480e6);
        assertEq(usdg.balanceOf(treasury), 60e6);
        assertEq(nymo.balanceOf(DEAD), 8_000e18);
        assertEq(_outsideBurn(), outside0 - 8_000e18);
        assertEq(usdg.balanceOf(address(fork)), 0);
        assertEq(nymo.balanceOf(address(fork)), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ForkFund.NotOpen.selector, id));
        fork.withdraw(id);
    }

    function test_trigger_notFundedReverts() public {
        uint256 id = _open();
        _give(alice, id, ForkFund.Currency.USDG, 999e6);
        vm.expectRevert(abi.encodeWithSelector(ForkFund.NotFunded.selector, 999e6, GOAL));
        fork.trigger(id);
    }

    function test_trigger_afterWithdrawFallsShort() public {
        uint256 id = _open();
        _give(alice, id, ForkFund.Currency.USDG, 600e6);
        _give(bob, id, ForkFund.Currency.USDG, 400e6);
        vm.prank(bob);
        fork.withdraw(id);
        vm.expectRevert(abi.encodeWithSelector(ForkFund.NotFunded.selector, 600e6, GOAL));
        fork.trigger(id);
    }

    function test_trigger_pausedAndExpired() public {
        uint256 id = _open();
        _give(alice, id, ForkFund.Currency.USDG, GOAL);
        vm.prank(safe);
        fork.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fork.trigger(id);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fork.open(TARGET, SPEC, GOAL);
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fork.contribute(id, ForkFund.Currency.USDG, 1);
        _viaTimelock(address(fork), abi.encodeWithSignature("unpause()"));
        vm.warp(vm.getBlockTimestamp() + 21 days);
        vm.expectRevert(abi.encodeWithSelector(ForkFund.Expired.selector, id));
        fork.trigger(id);
    }

    function test_refund_afterDeadline() public {
        uint256 id = _open();
        _give(alice, id, ForkFund.Currency.USDG, 100e6);
        _give(alice, id, ForkFund.Currency.NYMO, 100e18);
        vm.expectRevert(abi.encodeWithSelector(ForkFund.NotExpired.selector, id));
        fork.refund(id, alice);
        vm.warp(vm.getBlockTimestamp() + 21 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ForkFund.Expired.selector, id));
        fork.contribute(id, ForkFund.Currency.USDG, 1);
        _pauseAll();
        vm.expectEmit(address(fork));
        emit ForkFund.Refunded(id, alice, 100e6, 100e18);
        vm.prank(bob); // anyone may trigger the refund; it pays the contributor
        fork.refund(id, alice);
        assertEq(usdg.balanceOf(alice), 10_000e6);
        assertEq(nymo.balanceOf(alice), 1_000_000e18);
        assertEq(usdg.balanceOf(bob), 10_000e6);
    }

    function test_fulfil_requiresMitAndMatchingReceipt() public {
        uint256 id = _open();
        _give(alice, id, ForkFund.Currency.USDG, GOAL);
        ForkFund.CleanRoomReceipt memory r = _receipt();
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(ForkFund.NotTriggered.selector, id));
        fork.fulfil(id, REPO, r);
        fork.trigger(id);

        vm.expectRevert(ForkFund.NotFulfiller.selector);
        fork.fulfil(id, REPO, r);

        r.licenceSpdxHash = keccak256("GPL-3.0-only");
        vm.prank(signer);
        vm.expectRevert(ForkFund.LicenceNotMit.selector);
        fork.fulfil(id, REPO, r);

        r = _receipt();
        r.targetCommit = keccak256("other");
        vm.prank(signer);
        vm.expectRevert(ForkFund.ReceiptMismatch.selector);
        fork.fulfil(id, REPO, r);

        r = _receipt();
        vm.prank(signer);
        vm.expectRevert(ForkFund.ReceiptMismatch.selector);
        fork.fulfil(id, keccak256("other-repo"), r);

        vm.expectEmit(address(fork));
        emit ForkFund.Fulfilled(id, REPO, keccak256(abi.encode(r)));
        vm.prank(signer);
        fork.fulfil(id, REPO, r);
        ForkFund.Fund memory f = fork.funds(id);
        assertEq(uint8(f.status), uint8(ForkFund.Status.Fulfilled));
        assertEq(f.repoHash, REPO);
    }

    /// Escrow equals contributions minus withdrawals, for any mix, until the trigger.
    function testFuzz_escrowEqualsContributionsMinusWithdrawals(uint96 a1, uint96 a2, uint96 b1, bool aOut, bool bOut)
        public
    {
        uint256 id = _open();
        uint256 ua = bound(a1, 1, 5_000e6);
        uint256 na = bound(a2, 1, 500_000e18);
        uint256 ub = bound(b1, 1, 5_000e6);
        _give(alice, id, ForkFund.Currency.USDG, ua);
        _give(alice, id, ForkFund.Currency.NYMO, na);
        _give(bob, id, ForkFund.Currency.USDG, ub);
        uint256 u = ua + ub;
        uint256 n = na;
        if (aOut) {
            vm.prank(alice);
            fork.withdraw(id);
            u -= ua;
            n -= na;
        }
        if (bOut) {
            vm.prank(bob);
            fork.withdraw(id);
            u -= ub;
        }
        ForkFund.Fund memory f = fork.funds(id);
        assertEq(f.usdgRaised, u);
        assertEq(f.nymoRaised, n);
        assertEq(usdg.balanceOf(address(fork)), u);
        assertEq(nymo.balanceOf(address(fork)), n);
    }

    // ---- the build is never paid for by burned NYMO alone ------------------------------------------------------

    function test_openRefusesAGoalBelowTheMinimumCash() public {
        uint256 low = fork.minCashUsdg() - 1;
        vm.prank(opener);
        vm.expectRevert(abi.encodeWithSelector(ForkFund.GoalTooLow.selector, low, fork.minCashUsdg()));
        fork.open(TARGET, SPEC, low);
    }

    function test_triggerNeedsTheMinimumInUsdgNotJustValue() public {
        uint256 id = _open();
        // Fully funded in value, but almost all of it NYMO (which is burned): too little cash to pay for the build.
        _give(alice, id, ForkFund.Currency.USDG, fork.minCashUsdg() - 1);
        _give(bob, id, ForkFund.Currency.NYMO, 50_000e18);
        vm.expectRevert(abi.encodeWithSelector(ForkFund.NotEnoughCash.selector, fork.minCashUsdg() - 1, fork.minCashUsdg()));
        fork.trigger(id);
        _give(alice, id, ForkFund.Currency.USDG, 1);
        fork.trigger(id);
    }
}
