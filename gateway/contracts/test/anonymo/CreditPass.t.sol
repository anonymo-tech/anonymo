// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {CreditPass} from "../../src/anonymo/CreditPass.sol";
import {FeeRouter} from "../../src/anonymo/FeeRouter.sol";
import {DepositRouter} from "../../src/anonymo/DepositRouter.sol";
import {IStakerCredit} from "../../src/anonymo/interfaces/IAnonymo.sol";
import {MockStable} from "../../src/anonymo/mocks/MockStable.sol";
import {AnonymoBase} from "./AnonymoBase.sol";

/// Shared fixture for CreditPass and FeeRouter.
abstract contract TokenFixture is AnonymoBase {
    uint256 constant RATE = 1_000; // micro-USD per ANMO per day

    ANMO anmo;
    CreditPass pass;
    FeeRouter fees;
    address treasury = makeAddr("treasury");
    address workers = makeAddr("workers");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address payer = makeAddr("payer");

    function _deployTokens() internal {
        timelock = _deployTimelock();
        anmo = new ANMO(treasury);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        pass = new CreditPass(IERC20(address(anmo)), address(timelock), safe, predicted, RATE);
        fees = new FeeRouter(IERC20(address(anmo)), IStakerCredit(address(pass)), address(timelock), workers, treasury);
        assertEq(address(fees), predicted);
        vm.startPrank(treasury);
        anmo.transfer(alice, 1_000_000e18);
        anmo.transfer(bob, 1_000_000e18);
        anmo.transfer(payer, 10_000_000e18);
        vm.stopPrank();
        vm.prank(alice);
        anmo.approve(address(pass), type(uint256).max);
        vm.prank(bob);
        anmo.approve(address(pass), type(uint256).max);
        vm.prank(payer);
        anmo.approve(address(fees), type(uint256).max);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        pass.stake(amount);
    }

    function _route(uint256 amount) internal {
        vm.prank(payer);
        fees.route(amount, keccak256("spend"));
    }
}

contract CreditPassTest is TokenFixture {
    function setUp() public {
        vm.warp(1_790_000_000);
        _deployTokens();
    }

    function test_constructor() public view {
        assertEq(address(pass.anmo()), address(anmo));
        assertEq(pass.feeRouter(), address(fees));
        assertEq(pass.owner(), address(timelock));
        assertEq(pass.guardian(), safe);
        assertEq(pass.microUsdPerAnmoPerDay(), RATE);
        assertEq(pass.COOLDOWN(), 7 days);
        assertEq(pass.ROLLOVER_DAYS(), 3);
    }

    function test_stake_allowance() public {
        _stake(alice, 1_000e18);
        (uint256 perDay, uint256 cap) = pass.allowanceOf(alice);
        assertEq(perDay, 1_000_000); // 1,000 ANMO * 1,000 micro-USD = 1 USD a day
        assertEq(cap, 3_000_000); // rolls over for up to 3 days
        assertEq(pass.totalStaked(), 1_000e18);
        assertEq(anmo.balanceOf(address(pass)), 1_000e18);
        (uint256 active,,, uint64 since,,) = pass.positions(alice);
        assertEq(active, 1_000e18);
        assertEq(since, block.timestamp);
    }

    function testFuzz_allowance_linearInStake(uint256 amount) public {
        amount = bound(amount, 1e18, 1_000_000e18);
        _stake(alice, amount);
        (uint256 perDay, uint256 cap) = pass.allowanceOf(alice);
        assertEq(perDay, (amount * RATE) / 1e18);
        assertEq(cap, perDay * 3);
    }

    function test_stake_topUpKeepsSince() public {
        _stake(alice, 100e18);
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 1 days);
        _stake(alice, 100e18);
        (uint256 active,,, uint64 since,,) = pass.positions(alice);
        assertEq(active, 200e18);
        assertEq(since, t0);
    }

    function test_stake_zeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(CreditPass.ZeroAmount.selector);
        pass.stake(0);
    }

    function test_stake_belowMinimumReverts() public {
        vm.prank(alice);
        vm.expectRevert(CreditPass.BelowMinStake.selector);
        pass.stake(1e18 - 1);
        _stake(alice, 1e18);
        _stake(alice, 1); // top-ups of any size once the position is at the minimum
    }

    function test_requestUnstake_dropsAllowanceAndStartsCooldown() public {
        _stake(alice, 500e18);
        vm.prank(alice);
        pass.requestUnstake();
        (uint256 perDay, uint256 cap) = pass.allowanceOf(alice);
        assertEq(perDay, 0);
        assertEq(cap, 0);
        (uint256 active, uint256 pending, uint64 ends, uint64 since,,) = pass.positions(alice);
        assertEq(active, 0);
        assertEq(pending, 500e18);
        assertEq(ends, block.timestamp + 7 days);
        assertEq(since, 0);
        assertEq(pass.totalStaked(), 0);
        assertEq(pass.totalPending(), 500e18);
    }

    function test_requestUnstake_nothingStakedReverts() public {
        vm.prank(alice);
        vm.expectRevert(CreditPass.ZeroAmount.selector);
        pass.requestUnstake();
    }

    function test_withdraw_onlyAfterCooldown() public {
        _stake(alice, 500e18);
        vm.prank(alice);
        pass.requestUnstake();
        uint64 ends = uint64(block.timestamp + 7 days);
        vm.warp(ends - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CreditPass.CooldownActive.selector, ends));
        pass.withdraw();
        vm.warp(ends);
        uint256 before = anmo.balanceOf(alice);
        vm.prank(alice);
        pass.withdraw();
        assertEq(anmo.balanceOf(alice), before + 500e18);
        assertEq(pass.totalPending(), 0);
        vm.prank(alice);
        vm.expectRevert(CreditPass.NothingPending.selector);
        pass.withdraw();
    }

    function test_requestUnstake_againMergesAndRestartsCooldown() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        pass.requestUnstake();
        vm.warp(block.timestamp + 6 days);
        _stake(alice, 50e18);
        vm.prank(alice);
        pass.requestUnstake();
        (, uint256 pending, uint64 ends,,,) = pass.positions(alice);
        assertEq(pending, 150e18);
        assertEq(ends, block.timestamp + 7 days);
    }

    /// A cooldown withdrawal works while deposits are paused (DepositRouter and staking both paused).
    function test_cooldownWithdrawalWorksWhileDepositsArePaused() public {
        DepositRouter router = new DepositRouter(address(timelock), safe, treasury, address(this));
        MockStable usdc = new MockStable("USD Coin", "USDC");
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        router.bootstrap(tokens);

        _stake(alice, 300e18);
        vm.prank(alice);
        pass.requestUnstake();

        vm.startPrank(safe);
        router.pause();
        pass.pause();
        vm.stopPrank();
        assertTrue(router.paused());
        assertTrue(pass.paused());

        // Deposits and new stakes are stopped...
        usdc.mint(bob, 1e6);
        vm.startPrank(bob);
        usdc.approve(address(router), 1e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.deposit(address(usdc), 1e6, keccak256("k"));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pass.stake(1e18);
        vm.stopPrank();

        // ...but the cooldown withdrawal is not.
        vm.warp(block.timestamp + 7 days);
        uint256 before = anmo.balanceOf(alice);
        vm.prank(alice);
        pass.withdraw();
        assertEq(anmo.balanceOf(alice), before + 300e18);
        assertTrue(router.paused() && pass.paused());
    }

    /// Unstaking can also start while staking is paused.
    function test_requestUnstakeWorksWhilePaused() public {
        _stake(alice, 300e18);
        vm.prank(safe);
        pass.pause();
        vm.prank(alice);
        pass.requestUnstake();
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        pass.withdraw();
        assertEq(pass.totalPending(), 0);
    }

    function test_pause_guardianOnly_unpauseThroughTimelock() public {
        vm.prank(alice);
        vm.expectRevert(CreditPass.NotGuardian.selector);
        pass.pause();
        vm.prank(safe);
        pass.pause();
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        pass.unpause();
        _viaTimelock(address(pass), abi.encodeCall(CreditPass.unpause, ()));
        _stake(alice, 1e18);
    }

    function test_setRate_throughTimelock() public {
        _stake(alice, 1_000e18);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        pass.setRate(2_000);
        _viaTimelock(address(pass), abi.encodeCall(CreditPass.setRate, (2_000)));
        (uint256 perDay,) = pass.allowanceOf(alice);
        assertEq(perDay, 2_000_000);
    }

    // ------------------------------------------------------------ stakers' credit

    function test_notifyCredit_onlyFeeRouter() public {
        _stake(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(CreditPass.NotFeeRouter.selector);
        pass.notifyCredit(1e18);
    }

    function test_credit_sharedProRataOverActiveStake() public {
        _stake(alice, 300e18);
        _stake(bob, 100e18);
        _route(1_000e18); // stakers get 50e18
        assertEq(pass.totalCredit(), 50e18);
        assertEq(pass.creditOf(alice), 37.5e18);
        assertEq(pass.creditOf(bob), 12.5e18);

        // Bob leaves: he keeps the credit earned so far but earns no more.
        vm.prank(bob);
        pass.requestUnstake();
        _route(1_000e18);
        // 50e18 over 300e18 does not divide exactly: under 300 wei waits in the remainder for the next notify.
        assertApproxEqAbs(pass.creditOf(alice), 87.5e18, 300);
        assertLe(pass.creditOf(alice), 87.5e18);
        assertEq(pass.creditOf(bob), 12.5e18);

        // Credit is never withdrawable as tokens.
        vm.warp(block.timestamp + 7 days);
        uint256 before = anmo.balanceOf(bob);
        vm.prank(bob);
        pass.withdraw();
        assertEq(anmo.balanceOf(bob), before + 100e18);
        assertEq(pass.creditOf(bob), 12.5e18);
    }

    function test_credit_lateStakerGetsNothingEarlier() public {
        _stake(alice, 100e18);
        _route(1_000e18);
        _stake(bob, 100e18);
        assertEq(pass.creditOf(bob), 0);
        _route(1_000e18);
        assertEq(pass.creditOf(alice), 75e18);
        assertEq(pass.creditOf(bob), 25e18);
    }

    function test_sweepExcess_neverTouchesPrincipal() public {
        _stake(alice, 100e18);
        _stake(bob, 50e18);
        vm.prank(bob);
        pass.requestUnstake();
        _route(1_000e18);
        assertEq(pass.excess(), 50e18);
        address sink = makeAddr("sink");
        _viaTimelock(address(pass), abi.encodeCall(CreditPass.sweepExcess, (sink)));
        assertEq(anmo.balanceOf(sink), 50e18);
        assertEq(anmo.balanceOf(address(pass)), 150e18);
        assertEq(pass.excess(), 0);
        // Both principals still come out in full.
        vm.prank(alice);
        pass.requestUnstake();
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        pass.withdraw();
        vm.prank(bob);
        pass.withdraw();
        assertEq(anmo.balanceOf(address(pass)), 0);
    }

    function test_sweepExcess_onlyOwner() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        pass.sweepExcess(safe);
    }
}
