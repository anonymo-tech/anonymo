// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {AnonymoTimelock} from "../../src/anonymo/AnonymoTimelock.sol";
import {EverydayOwned, EverydayPausable} from "../../src/anonymo/EverydayOwned.sol";
import {EverydayTimelock} from "../../src/anonymo/EverydayTimelock.sol";
import {EverydayFeeRouter} from "../../src/anonymo/EverydayFeeRouter.sol";
import {Checkout} from "../../src/anonymo/Checkout.sol";
import {CreditPass} from "../../src/anonymo/CreditPass.sol";
import {StakeCredits} from "../../src/anonymo/StakeCredits.sol";
import {CreatorPayouts} from "../../src/anonymo/CreatorPayouts.sol";
import {Referrals} from "../../src/anonymo/Referrals.sol";
import {VoteRegistry} from "../../src/anonymo/VoteRegistry.sol";
import {Boosts} from "../../src/anonymo/Boosts.sol";
import {MockPriceOracle} from "../../src/ventures/mocks/MockPriceOracle.sol";
import {MockUSDG} from "../../src/ventures/mocks/MockUSDG.sol";
import {PriceGuard} from "../../src/ventures/PriceGuard.sol";
import {EverydayFixture} from "./EverydayFixture.sol";

struct System {
    ANMO nymo;
    MockUSDG usdg;
    MockPriceOracle oracle;
    Checkout checkout;
    StakeCredits stakes;
    Boosts boosts;
    CreatorPayouts payouts;
    CreditPass legacyPass;
    Referrals referrals;
    VoteRegistry votes;
    EverydayFeeRouter router;
    EverydayTimelock timelock;
    address payer;
    address second;
    address workers;
    address signer;
}

contract EverydayHandler is Test {
    bytes32 private constant CREATOR = keccak256("creator");
    System private sys;

    uint256 public burned;
    uint256 public lastWeek;
    uint256 private _orders;

    constructor(System memory system) {
        sys = system;
        vm.prank(sys.payer);
        sys.nymo.approve(address(sys.checkout), type(uint256).max);
    }

    function exitWhilePaused(uint256 stakeSeed, uint256 boostSeed) external {
        uint256 staked = sys.stakes.stakedOf(sys.payer);
        uint256 locked = sys.boosts.boostedBy(CREATOR, sys.payer);
        uint256 stakeOut = staked == 0 ? 0 : bound(stakeSeed, 1, staked);
        uint256 boostOut = locked == 0 ? 0 : bound(boostSeed, 1, locked);
        (, uint256 pending,,,,) = sys.legacyPass.positions(sys.payer);
        uint256 before = sys.nymo.balanceOf(sys.payer);
        vm.startPrank(sys.payer);
        if (stakeOut != 0) sys.stakes.unstake(stakeOut);
        if (boostOut != 0) sys.boosts.unlock(CREATOR, boostOut);
        if (pending != 0) sys.legacyPass.withdraw();
        vm.stopPrank();
        assertEq(sys.nymo.balanceOf(sys.payer) - before, stakeOut + boostOut + pending);
    }

    function split(uint256 amount) external view {
        (uint256 w, uint256 t, uint256 s, uint256 b) = sys.router.split(amount);
        assertEq(w + t + s + b, amount);
    }

    function quoteAndBurn(uint256 spreadSeed, bool below) external {
        uint256 spread = bound(spreadSeed, 0, 1_000);
        uint256 spot = below ? 1e18 - spread * 1e14 : 1e18 + spread * 1e14;
        sys.oracle.set(1e18, spot);
        bytes32 sku = sys.checkout.PASS30();
        Checkout.Permit memory permit = Checkout.Permit(bytes32(++_orders), type(uint256).max, 0, 0, 0, 0);
        if (spread > 500) vm.expectRevert(abi.encodeWithSelector(PriceGuard.PriceGap.selector, 1e18, spot));
        vm.prank(sys.payer);
        sys.checkout.payNYMO(sku, 1, permit);
        if (spread <= 500) burned += 9.6e18;
    }

    function claimWhilePaused(uint256 firstSeed, uint256 secondSeed, bool reverse) external {
        uint256 week = lastWeek + 1;
        vm.warp(vm.getBlockTimestamp() + 7 days);
        lastWeek = week;
        CreatorPayouts.Node memory a = _node(sys.payer, bound(firstSeed, 1, 100));
        CreatorPayouts.Node memory b = _node(sys.second, bound(secondSeed, 1, 100));
        CreatorPayouts.Node memory root = sys.payouts.combine(a, b);
        vm.prank(sys.workers);
        sys.payouts.fund(week, root.sum);
        vm.prank(sys.signer);
        sys.payouts.postRoot(week, keccak256(abi.encode(root.hash, root.sum)));
        vm.prank(sys.payer);
        vm.expectRevert(CreatorPayouts.InvalidAmount.selector);
        sys.payouts.claim(week, root.sum + 1, new CreatorPayouts.Node[](0));
        if (reverse) {
            _claim(week, sys.second, b, a);
            _claim(week, sys.payer, a, b);
        } else {
            _claim(week, sys.payer, a, b);
            _claim(week, sys.second, b, a);
        }
        assertEq(sys.payouts.claimedShares(week), root.sum);
    }

    function setterRequiresQueue(uint8 selector, uint256 value) external {
        uint256 kind = selector % 8;
        address target;
        bytes memory data;
        if (kind == 0) {
            StakeCredits.TierRule[3] memory table =
                [StakeCredits.TierRule(1, value), StakeCredits.TierRule(2, 2), StakeCredits.TierRule(3, 3)];
            target = address(sys.stakes);
            data = abi.encodeCall(StakeCredits.setTierTable, (table));
        } else if (kind == 1) {
            target = address(sys.checkout);
            data = abi.encodeCall(Checkout.setOracle, (sys.oracle));
        } else if (kind == 2) {
            target = address(sys.payouts);
            data = abi.encodeCall(CreatorPayouts.setSigner, (sys.second));
        } else if (kind == 3) {
            target = address(sys.referrals);
            data = abi.encodeCall(Referrals.setRegistrar, (sys.second));
        } else if (kind == 4) {
            target = address(sys.votes);
            data = abi.encodeCall(
                VoteRegistry.registerOption, (sys.votes.currentEpoch(), VoteRegistry.Ballot.Voice, CREATOR)
            );
        } else if (kind == 5) {
            EverydayFeeRouter.Recipients memory next =
                EverydayFeeRouter.Recipients(sys.second, sys.payer, sys.workers, sys.signer);
            target = address(sys.router);
            data = abi.encodeCall(EverydayFeeRouter.setRecipients, (next));
        } else if (kind == 6) {
            target = address(sys.checkout);
            data = abi.encodeCall(EverydayPausable.pause, ());
        } else {
            target = address(sys.boosts);
            data = abi.encodeCall(EverydayPausable.unpause, ());
        }
        vm.prank(address(sys.timelock));
        (bool ok, bytes memory reason) = target.call(data);
        assertFalse(ok);
        assertEq(bytes4(reason), EverydayOwned.NotQueued.selector);
        assertFalse(sys.timelock.isExecuting(target, data));
    }

    function _node(address creator, uint256 amount) private view returns (CreatorPayouts.Node memory) {
        return CreatorPayouts.Node(sys.payouts.leafFor(creator, amount), amount);
    }

    function _claim(
        uint256 week,
        address creator,
        CreatorPayouts.Node memory leaf,
        CreatorPayouts.Node memory sibling
    ) private {
        CreatorPayouts.Node[] memory proof = new CreatorPayouts.Node[](1);
        proof[0] = sibling;
        uint256 before = sys.usdg.balanceOf(creator);
        vm.prank(creator);
        sys.payouts.claim(week, leaf.sum, proof);
        assertEq(sys.usdg.balanceOf(creator) - before, leaf.sum);
        assertTrue(sys.payouts.claimed(week, leaf.hash));
        vm.expectRevert(CreatorPayouts.AlreadyClaimed.selector);
        vm.prank(creator);
        sys.payouts.claim(week, leaf.sum, proof);
    }
}

contract EverydayInvariants is EverydayFixture {
    EverydayHandler private handler;
    CreditPass private legacyPass;

    function setUp() public override {
        super.setUp();
        address[] memory roles = new address[](1);
        roles[0] = address(safe);
        AnonymoTimelock legacyLock = new AnonymoTimelock(48 hours, roles, roles, address(0));
        legacyPass = new CreditPass(nymo, address(legacyLock), address(this), address(router), 1);
        vm.startPrank(payer);
        nymo.approve(address(legacyPass), 1e18);
        legacyPass.stake(1e18);
        legacyPass.requestUnstake();
        stakes.stake(200_000e18);
        boosts.boost(CREATOR, 200_000e18);
        vm.stopPrank();
        legacyPass.pause();

        bytes memory pause = abi.encodeCall(EverydayPausable.pause, ());
        bytes32 stakeSalt = _queue(address(stakes), pause);
        bytes32 boostSalt = _queue(address(boosts), pause);
        bytes32 payoutSalt = _queue(address(payouts), pause);
        vm.warp(block.timestamp + WEEK);
        _execute(address(stakes), pause, stakeSalt);
        _execute(address(boosts), pause, boostSalt);
        _execute(address(payouts), pause, payoutSalt);

        handler = new EverydayHandler(
            System(
                nymo,
                usdg,
                oracle,
                checkout,
                stakes,
                boosts,
                payouts,
                legacyPass,
                referrals,
                votes,
                router,
                timelock,
                payer,
                second,
                workers,
                signer
            )
        );
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = EverydayHandler.exitWhilePaused.selector;
        selectors[1] = EverydayHandler.split.selector;
        selectors[2] = EverydayHandler.quoteAndBurn.selector;
        selectors[3] = EverydayHandler.claimWhilePaused.selector;
        selectors[4] = EverydayHandler.setterRequiresQueue.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariant_supplyExitCustodyAndRootConservation() public view {
        assertEq(nymo.totalSupply(), nymo.TOTAL_SUPPLY() - handler.burned());
        assertEq(nymo.balanceOf(address(stakes)), stakes.totalStaked());
        assertEq(nymo.balanceOf(address(boosts)), boosts.totalBoosted(CREATOR));
        assertEq(nymo.balanceOf(address(legacyPass)), legacyPass.totalPending());
        assertEq(payouts.claimedShares(handler.lastWeek()), payouts.funded(handler.lastWeek()));
        assertEq(usdg.balanceOf(address(payouts)), 0);
        assertTrue(stakes.paused() && boosts.paused() && payouts.paused() && legacyPass.paused());
        assertFalse(checkout.paused());
        assertEq(
            router.WORKERS_BPS() + router.TREASURY_BPS() + router.STAKER_CREDITS_BPS()
                + router.BUY_BURN_BPS(),
            10_000
        );
    }
}
