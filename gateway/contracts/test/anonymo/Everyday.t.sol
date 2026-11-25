// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {AnonymoTimelock} from "../../src/anonymo/AnonymoTimelock.sol";
import {EverydayTimelock} from "../../src/anonymo/EverydayTimelock.sol";
import {TimelockOwned} from "../../src/anonymo/TimelockOwned.sol";
import {EverydayOwned, EverydayPausable} from "../../src/anonymo/EverydayOwned.sol";
import {EverydayFeeRouter} from "../../src/anonymo/EverydayFeeRouter.sol";
import {Checkout} from "../../src/anonymo/Checkout.sol";
import {StakeCredits} from "../../src/anonymo/StakeCredits.sol";
import {CreatorPayouts} from "../../src/anonymo/CreatorPayouts.sol";
import {Referrals} from "../../src/anonymo/Referrals.sol";
import {VoteRegistry} from "../../src/anonymo/VoteRegistry.sol";
import {Boosts} from "../../src/anonymo/Boosts.sol";
import {PriceGuard} from "../../src/ventures/PriceGuard.sol";
import {MockUSDG} from "../../src/ventures/mocks/MockUSDG.sol";
import {MockPriceOracle} from "../../src/ventures/mocks/MockPriceOracle.sol";
import {EverydayFixture} from "./EverydayFixture.sol";

contract EverydayTest is EverydayFixture {
    function test_stakeAndImmediateUnstakeWithCheckpointHistory() public {
        uint256 start = block.timestamp;
        vm.startPrank(payer);
        vm.expectEmit(true, false, false, true, address(stakes));
        emit StakeCredits.Staked(payer, 30_000e18, 30_000e18);
        stakes.stake(30_000e18);
        stakes.stake(30_000e18);
        vm.stopPrank();
        assertEq(stakes.twabOf(payer), 0);
        assertEq(uint8(stakes.tierOf(payer)), uint8(StakeCredits.Tier.Free));

        vm.warp(start + WEEK / 2);
        assertEq(stakes.twabOf(payer), 30_000e18);
        vm.prank(payer);
        stakes.unstake(20_000e18);
        vm.warp(start + WEEK);
        assertEq(stakes.twabAt(payer, start + WEEK / 2), 30_000e18);
        assertEq(stakes.totalTwabAt(block.timestamp), 50_000e18);
        assertEq(uint8(stakes.tierOf(payer)), uint8(StakeCredits.Tier.Pro));
        assertEq(stakes.dailyCreditOf(payer), 2e6);

        _govern(address(stakes), abi.encodeCall(EverydayPausable.pause, ()));
        vm.startPrank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        stakes.stake(1);
        vm.expectEmit(true, false, false, true, address(stakes));
        emit StakeCredits.Unstaked(payer, 40_000e18, 0);
        stakes.unstake(40_000e18);
        vm.stopPrank();
        assertEq(nymo.balanceOf(payer), 500_000e18);
        assertEq(stakes.dailyCreditOf(payer), 0);
        assertEq(stakes.stakedOf(payer), 0);

        _govern(address(stakes), abi.encodeCall(EverydayPausable.unpause, ()));
        assertFalse(stakes.paused());
        assertEq(stakes.twabOf(payer), 0);
    }

    function test_stakeInputAndTierTable() public {
        vm.expectRevert(StakeCredits.InvalidStake.selector);
        stakes.stake(0);
        vm.expectRevert(StakeCredits.InvalidStake.selector);
        stakes.unstake(1);
        vm.expectRevert(StakeCredits.FutureTimestamp.selector);
        stakes.twabAt(payer, block.timestamp + 1);
        vm.expectRevert(StakeCredits.FutureTimestamp.selector);
        stakes.totalTwabAt(block.timestamp + 1);

        StakeCredits.TierRule[3] memory table =
            [StakeCredits.TierRule(1, 11), StakeCredits.TierRule(2, 22), StakeCredits.TierRule(3, 33)];
        vm.prank(payer);
        stakes.stake(4);
        _govern(address(stakes), abi.encodeCall(StakeCredits.setTierTable, (table)));
        assertEq(uint8(stakes.tierOf(payer)), uint8(StakeCredits.Tier.Black));
        assertEq(stakes.dailyCreditOf(payer), 33);
        table[0].minTwab = 2;
        bytes memory bad = abi.encodeCall(StakeCredits.setTierTable, (table));
        bytes32 salt = _queue(address(stakes), bad);
        vm.warp(block.timestamp + WEEK);
        vm.expectRevert(StakeCredits.InvalidTable.selector);
        _execute(address(stakes), bad, salt);
    }

    function test_usdgAuthorizationBindsOrderAndRoutesRevenue() public {
        bytes32 sku = checkout.PASS30_PLUS();
        Checkout.ReceiveAuth memory auth = _authorize(sku, 2, ORDER);
        bytes32 id = checkout.orderIdFor(payer, ORDER);
        bytes32 originalRef = auth.orderRef;
        auth.orderRef = keccak256("other order");
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        checkout.payUSDG(sku, 2, auth);
        auth.orderRef = originalRef;
        vm.expectRevert(Checkout.InvalidAmount.selector);
        checkout.payUSDG(sku, 1, auth);

        vm.expectEmit(true, true, true, true, address(checkout));
        emit Checkout.Paid(id, sku, payer, ORDER, 2, address(usdg), 58e6);
        assertEq(checkout.payUSDG(sku, 2, auth), id);
        assertTrue(checkout.paid(id));
        vm.expectRevert(Checkout.AlreadyPaid.selector);
        checkout.payUSDG(sku, 2, auth);
        assertEq(usdg.balanceOf(payer), 10_000e6 - 58e6);
        assertEq(usdg.balanceOf(workers), 10_000e6 + 46_400_000);
        assertEq(usdg.balanceOf(treasury), 5_800_000);
        assertEq(usdg.balanceOf(stakerCredits), 2_900_000);
        assertEq(usdg.balanceOf(buyBurn), 2_900_000);
        assertEq(usdg.balanceOf(address(checkout)) + usdg.balanceOf(address(router)), 0);
        assertEq(usdg.allowance(address(checkout), address(router)), 0);
        assertEq(checkout.PASS_DURATION(), 30 days);
    }

    function test_payNYMOSignedPermitAndFrontRunAllowanceBurnSupply() public {
        bytes32 sku = checkout.PASS30();
        uint256 quote = 9.6e18;
        assertEq(checkout.quoteNYMO(sku, 1), quote);
        Checkout.Permit memory permit = _permit(ORDER, quote);
        uint256 supply = nymo.totalSupply();
        vm.prank(payer);
        checkout.payNYMO(sku, 1, permit);
        assertEq(nymo.totalSupply(), supply - quote);
        assertEq(nymo.balanceOf(payer), 500_000e18 - quote);
        assertEq(nymo.balanceOf(address(checkout)), 0);

        permit = _permit(keccak256("other order"), quote);
        nymo.permit(payer, address(checkout), quote, permit.deadline, permit.v, permit.r, permit.s);
        vm.prank(payer);
        checkout.payNYMO(sku, 1, permit);
        assertEq(nymo.totalSupply(), supply - 2 * quote);
    }

    function test_checkoutQuotesAndPaymentPause() public {
        bytes32 sku = checkout.PASS30();
        vm.expectRevert(Checkout.InvalidQuantity.selector);
        checkout.priceOf(sku, 0);
        vm.expectRevert(Checkout.UnknownSku.selector);
        checkout.priceOf(bytes32("missing"), 1);
        oracle.set(0, 1);
        vm.expectRevert(PriceGuard.BadPrice.selector);
        checkout.quoteNYMO(sku, 1);
        oracle.set(1e18, 0.95e18);
        assertEq(checkout.quoteNYMO(sku, 1), 9.6e18);
        oracle.set(1e18, 1.05e18);
        assertEq(checkout.quoteNYMO(sku, 1), 9.6e18);
        vm.expectRevert(abi.encodeWithSelector(Checkout.SlippageExceeded.selector, 9.6e18, 1));
        checkout.payNYMO(sku, 1, Checkout.Permit(ORDER, 1, 0, 0, 0, 0));
        oracle.set(1e18, 1.05e18 + 1);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.PriceGap.selector, 1e18, 1.05e18 + 1));
        checkout.payNYMO(sku, 1, Checkout.Permit(ORDER, type(uint256).max, 0, 0, 0, 0));

        MockPriceOracle next = new MockPriceOracle(2e18, 2e18);
        vm.expectCall(address(next), abi.encodeCall(next.twap, (uint32(30 minutes))));
        _govern(address(checkout), abi.encodeCall(Checkout.setOracle, (next)));
        assertEq(checkout.quoteNYMO(sku, 1), 4.8e18);
        _govern(address(checkout), abi.encodeCall(EverydayPausable.pause, ()));
        Checkout.ReceiveAuth memory auth = _authorize(sku, 1, ORDER);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        checkout.payUSDG(sku, 1, auth);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        checkout.payNYMO(sku, 1, Checkout.Permit(ORDER, type(uint256).max, 0, 0, 0, 0));
    }

    function testFuzz_feeSplitConservesEveryAmount(uint256 amount) public view {
        (uint256 w, uint256 t, uint256 s, uint256 b) = router.split(amount);
        assertEq(w + t + s + b, amount);
        assertEq(s, b);
        assertEq(
            router.WORKERS_BPS() + router.TREASURY_BPS() + router.STAKER_CREDITS_BPS()
                + router.BUY_BURN_BPS(),
            10_000
        );
    }

    function test_feeRecipientsAndZeroRoute() public {
        vm.expectRevert(EverydayFeeRouter.InvalidAmount.selector);
        router.route(0, ORDER);
        EverydayFeeRouter.Recipients memory next =
            EverydayFeeRouter.Recipients(workers, payer, stakerCredits, buyBurn);
        _govern(address(router), abi.encodeCall(EverydayFeeRouter.setRecipients, (next)));
        vm.startPrank(payer);
        usdg.approve(address(router), 1);
        router.route(1, ORDER);
        vm.stopPrank();
        assertEq(usdg.balanceOf(payer), 10_000e6);
        assertEq(usdg.balanceOf(address(router)), 0);
    }

    function test_payoutsHoldBudgetReplayAndTipsWhilePaused() public {
        uint256 week = payouts.currentWeek();
        CreatorPayouts.Node memory a = _node(payer, 41e6);
        CreatorPayouts.Node memory b = _node(second, 59e6);
        bytes32 root = _root(payouts.combine(a, b));
        vm.expectRevert(CreatorPayouts.NotWorkers.selector);
        payouts.fund(week, 100e6);
        vm.prank(workers);
        payouts.fund(week, 100e6);
        vm.prank(payer);
        payouts.tip(second, 5e6);
        vm.expectRevert(CreatorPayouts.MissingRoot.selector);
        payouts.claim(week, 1, new CreatorPayouts.Node[](0));

        vm.warp((week + 2) * WEEK - 1);
        vm.expectRevert(CreatorPayouts.NotSigner.selector);
        payouts.postRoot(week, root);
        vm.prank(signer);
        vm.expectRevert(CreatorPayouts.HoldActive.selector);
        payouts.postRoot(week, root);
        vm.warp(block.timestamp + 1);
        vm.prank(signer);
        payouts.postRoot(week, root);
        vm.prank(signer);
        vm.expectRevert(CreatorPayouts.RootExists.selector);
        payouts.postRoot(week, root);
        vm.prank(workers);
        vm.expectRevert(CreatorPayouts.RootExists.selector);
        payouts.fund(week, 1);

        _govern(address(payouts), abi.encodeCall(EverydayPausable.pause, ()));
        vm.startPrank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        payouts.tip(second, 1);
        vm.expectRevert(CreatorPayouts.InvalidProof.selector);
        payouts.claim(week, 40e6, _proof(b));
        payouts.claim(week, a.sum, _proof(b));
        vm.expectRevert(CreatorPayouts.AlreadyClaimed.selector);
        payouts.claim(week, a.sum, _proof(b));
        vm.stopPrank();

        vm.warp(block.timestamp + 100 weeks);
        vm.prank(second);
        payouts.claim(week, b.sum, _proof(a));
        assertEq(usdg.balanceOf(second), 64e6);
        assertEq(usdg.balanceOf(payer), 10_000e6 - 5e6 + 41e6);
        assertEq(payouts.claimedShares(week), payouts.funded(week));
        assertEq(usdg.balanceOf(address(payouts)), 0);
    }

    function test_tipOnlyRootAndSignerRotation() public {
        uint256 week = payouts.currentWeek();
        bytes32 empty = payouts.EMPTY_ROOT();
        vm.prank(payer);
        payouts.tip(second, 1);
        _govern(address(payouts), abi.encodeCall(CreatorPayouts.setSigner, (second)));
        vm.warp((week + 2) * WEEK);
        vm.startPrank(second);
        vm.expectRevert(CreatorPayouts.InvalidRoot.selector);
        payouts.postRoot(week, bytes32(0));
        payouts.postRoot(week, empty);
        CreatorPayouts.Node[] memory noProof = new CreatorPayouts.Node[](0);
        payouts.claim(week, 0, noProof);
        vm.expectRevert(CreatorPayouts.InvalidAmount.selector);
        payouts.claim(week, 0, noProof);
        vm.stopPrank();
        assertEq(usdg.balanceOf(second), 1);
    }

    function test_boostsOnlyIncreaseRankingAndUnlockToSourceWhilePaused() public {
        vm.expectRevert(Boosts.InvalidBoost.selector);
        boosts.boost(bytes32(0), 1);
        vm.prank(payer);
        boosts.boost(CREATOR, 500e18);
        assertEq(boosts.totalBoosted(CREATOR), 500e18);
        assertEq(stakes.twabOf(payer), 0);
        vm.prank(second);
        vm.expectRevert(Boosts.InvalidBoost.selector);
        boosts.unlock(CREATOR, 1);

        _govern(address(boosts), abi.encodeCall(EverydayPausable.pause, ()));
        vm.startPrank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        boosts.boost(CREATOR, 1);
        boosts.unlock(CREATOR, 200e18);
        boosts.unlock(CREATOR, 300e18);
        vm.stopPrank();
        assertEq(boosts.totalBoosted(CREATOR), 0);
        assertEq(boosts.boostedBy(CREATOR, payer), 0);
        assertEq(nymo.balanceOf(payer), 500_000e18);
    }

    function test_referralRegistrarAndEvent() public {
        vm.expectRevert(Referrals.NotRegistrar.selector);
        referrals.register(CREATOR);
        vm.prank(registrar);
        vm.expectRevert(Referrals.InvalidInviter.selector);
        referrals.register(bytes32(0));
        _govern(address(referrals), abi.encodeCall(Referrals.setRegistrar, (second)));
        assertEq(referrals.CREDIT_WINDOW(), 90 days);
        vm.expectEmit(true, false, false, true, address(referrals));
        emit Referrals.Registered(CREATOR);
        vm.prank(second);
        referrals.register(CREATOR);
    }

    function test_votesUseWeeklyCappedSnapshotsAndCanMoveOneVote() public {
        uint256 epoch = votes.currentEpoch() + 1;
        VoteRegistry.Ballot ballot = VoteRegistry.Ballot.Voice;
        bytes32 first = bytes32("alto");
        bytes32 next = bytes32("bass");
        vm.prank(payer);
        stakes.stake(100_000e18);
        vm.startPrank(second);
        nymo.approve(address(stakes), 1_000e18);
        stakes.stake(1_000e18);
        vm.stopPrank();
        bytes32 firstSalt =
            _queue(address(votes), abi.encodeCall(VoteRegistry.registerOption, (epoch, ballot, first)));
        bytes32 secondSalt =
            _queue(address(votes), abi.encodeCall(VoteRegistry.registerOption, (epoch, ballot, next)));
        vm.warp(block.timestamp + WEEK);
        _execute(
            address(votes), abi.encodeCall(VoteRegistry.registerOption, (epoch, ballot, first)), firstSalt
        );
        _execute(
            address(votes), abi.encodeCall(VoteRegistry.registerOption, (epoch, ballot, next)), secondSalt
        );
        assertEq(votes.weightOf(payer, epoch), 2_020e18);
        assertEq(votes.weightOf(second, epoch), 1_000e18);

        vm.expectRevert(VoteRegistry.NoWeight.selector);
        votes.vote(ballot, first);
        vm.startPrank(payer);
        vm.expectRevert(VoteRegistry.InvalidOption.selector);
        votes.vote(VoteRegistry.Ballot.ModelFamily, first);
        votes.vote(ballot, first);
        assertEq(votes.tally(epoch, ballot, first), 2_020e18);
        stakes.unstake(100_000e18);
        votes.vote(ballot, next);
        vm.stopPrank();
        assertEq(votes.tally(epoch, ballot, first), 0);
        assertEq(votes.tally(epoch, ballot, next), 2_020e18);
        (bytes32 option, uint256 weight) = votes.voteOf(epoch, ballot, payer);
        assertEq(option, next);
        assertEq(weight, 2_020e18);
        vm.warp(block.timestamp + WEEK);
        assertEq(votes.weightOf(payer, epoch + 1), 0);
    }

    function test_timelockRequiresQueueWaitAndModuleFreeThreeOfFiveSafe() public {
        bytes memory change = abi.encodeCall(Referrals.setRegistrar, (second));
        vm.expectRevert(EverydayOwned.NotQueued.selector);
        vm.prank(address(timelock));
        referrals.setRegistrar(second);
        vm.expectPartialRevert(TimelockController.TimelockUnexpectedOperationState.selector);
        _execute(address(referrals), change, bytes32(0));
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        timelock.schedule(address(referrals), 0, change, bytes32(0), bytes32(0), WEEK);

        safe.setModule(true);
        vm.expectRevert(EverydayTimelock.InvalidSafe.selector);
        vm.prank(address(safe));
        timelock.schedule(address(referrals), 0, change, bytes32(0), bytes32(0), WEEK);
        safe.setModule(false);
        bytes32 salt = _queue(address(referrals), change);
        vm.warp(block.timestamp + WEEK - 1);
        vm.expectPartialRevert(TimelockController.TimelockUnexpectedOperationState.selector);
        _execute(address(referrals), change, salt);
        vm.warp(block.timestamp + 1);
        safe.setThreshold(2);
        vm.expectRevert(EverydayTimelock.InvalidSafe.selector);
        _execute(address(referrals), change, salt);
        safe.setThreshold(3);
        _execute(address(referrals), change, salt);
        assertEq(referrals.registrar(), second);
        vm.expectPartialRevert(TimelockController.TimelockUnexpectedOperationState.selector);
        _execute(address(referrals), change, salt);
    }

    function test_timelockFloorRolesAndOwnerCannotBeReplaced() public {
        bytes memory lower = abi.encodeCall(EverydayTimelock.updateDelay, (WEEK - 1));
        bytes32 salt = _queue(address(timelock), lower);
        vm.warp(block.timestamp + WEEK);
        vm.expectRevert(abi.encodeWithSelector(AnonymoTimelock.DelayBelowFloor.selector, WEEK - 1));
        _execute(address(timelock), lower, salt);
        _govern(address(timelock), abi.encodeCall(EverydayTimelock.updateDelay, (2 * WEEK)));
        assertEq(timelock.getMinDelay(), 2 * WEEK);

        vm.expectRevert(EverydayTimelock.FixedRoles.selector);
        timelock.grantRole(bytes32(0), second);
        vm.expectRevert(EverydayTimelock.FixedRoles.selector);
        timelock.revokeRole(bytes32(0), second);
        vm.expectRevert(EverydayTimelock.FixedRoles.selector);
        timelock.renounceRole(bytes32(0), address(this));
        vm.expectRevert(EverydayOwned.FixedOwner.selector);
        referrals.transferOwnership(second);

        address[] memory members = new address[](1);
        members[0] = address(safe);
        AnonymoTimelock legacy = new AnonymoTimelock(WEEK, members, members, address(0));
        vm.expectRevert(abi.encodeWithSelector(TimelockOwned.NotTimelock.selector, address(legacy)));
        new Referrals(EverydayTimelock(payable(address(legacy))), registrar);
    }
}
