// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CrewTiers} from "../../src/ventures/CrewTiers.sol";
import {BuildFuel} from "../../src/ventures/BuildFuel.sol";
import {VenturesBase} from "./VenturesBase.sol";

contract CrewTiersTest is VenturesBase {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        _deployVentures();
        _fundNymo(alice, 10_000_000e18);
        _fundNymo(bob, 10_000_000e18);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        crew.stake(amount);
    }

    function test_constructor() public view {
        assertEq(address(crew.token()), address(nymo));
        assertEq(crew.owner(), address(timelock));
        assertEq(crew.guardian(), safe);
        assertEq(crew.thresholds(0), 50_000e18);
        assertEq(crew.thresholds(1), 250_000e18);
        assertEq(crew.thresholds(2), 1_000_000e18);
        assertEq(crew.TWAB_WINDOW(), 7 days);
    }

    function test_stakeUnstake_balancesAndEvents() public {
        vm.expectEmit(address(crew));
        emit CrewTiers.Staked(alice, 100e18, 100e18);
        _stake(alice, 100e18);
        assertEq(crew.stakedOf(alice), 100e18);
        assertEq(crew.totalStaked(), 100e18);
        assertEq(nymo.balanceOf(address(crew)), 100e18);
        vm.expectEmit(address(crew));
        emit CrewTiers.Unstaked(alice, 40e18, 60e18);
        vm.prank(alice);
        crew.unstake(40e18);
        assertEq(crew.stakedOf(alice), 60e18);
        assertEq(nymo.balanceOf(address(crew)), 60e18);
    }

    function test_unstake_moreThanStakedReverts() public {
        _stake(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CrewTiers.InsufficientStake.selector, 1e18));
        crew.unstake(2e18);
    }

    function test_twab_rampsOverSevenDays() public {
        _stake(alice, 700e18);
        assertEq(crew.twabOf(alice), 0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(crew.twabOf(alice), 100e18);
        vm.warp(vm.getBlockTimestamp() + 2.5 days);
        assertEq(crew.twabOf(alice), 350e18);
        vm.warp(vm.getBlockTimestamp() + 3.5 days);
        assertEq(crew.twabOf(alice), 700e18);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertEq(crew.twabOf(alice), 700e18);
        // Unstake half: the average falls linearly over the next 7 days.
        vm.prank(alice);
        crew.unstake(350e18);
        vm.warp(vm.getBlockTimestamp() + 3.5 days);
        assertEq(crew.twabOf(alice), 525e18);
        vm.warp(vm.getBlockTimestamp() + 3.5 days);
        assertEq(crew.twabOf(alice), 350e18);
    }

    function test_twabAt_pastWindowsAndFutureReverts() public {
        uint256 t0 = vm.getBlockTimestamp();
        _stake(alice, 70e18);
        vm.warp(t0 + 7 days);
        _stake(alice, 70e18);
        vm.warp(t0 + 20 days);
        assertEq(crew.twabAt(alice, t0 + 7 days), 70e18);
        assertEq(crew.twabAt(alice, t0 + 14 days), 140e18);
        assertEq(crew.twabAt(alice, t0 + 3.5 days), 35e18);
        assertEq(crew.twabAt(alice, t0 - 1), 0);
        assertEq(crew.totalTwabAt(t0 + 14 days), 140e18);
        vm.expectRevert(CrewTiers.FutureTimestamp.selector);
        crew.twabAt(alice, vm.getBlockTimestamp() + 1);
    }

    function test_sameBlockUpdatesOverwrite() public {
        _stake(alice, 10e18);
        _stake(alice, 10e18);
        vm.prank(alice);
        crew.unstake(5e18);
        assertEq(crew.checkpointCount(alice), 1);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(crew.twabOf(alice), 15e18);
    }

    function test_tiers() public {
        _stake(alice, 49_999e18);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(crew.tierOf(alice), crew.SOLO());
        _stake(alice, 1e18);
        assertEq(crew.tierOf(alice), crew.SOLO()); // the average has not caught up yet
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(crew.tierOf(alice), crew.CREW());
        assertEq(crew.tierFor(250_000e18), crew.GANG());
        assertEq(crew.tierFor(999_999e18), crew.GANG());
        assertEq(crew.tierFor(1_000_000e18), crew.SYNDICATE());
    }

    function test_flashStakeEarnsNoTier() public {
        _stake(bob, 5_000_000e18);
        assertEq(crew.tierOf(bob), crew.SOLO());
        vm.prank(bob);
        crew.unstake(5_000_000e18);
        assertEq(crew.tierOf(bob), crew.SOLO());
    }

    function test_pause_stopsStakeNotUnstake() public {
        _stake(alice, 10e18);
        vm.prank(safe);
        crew.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        crew.stake(1e18);
        vm.prank(alice);
        crew.unstake(10e18);
        assertEq(crew.stakedOf(alice), 0);
    }

    function test_thresholds_onlyThroughTimelock() public {
        vm.prank(safe);
        vm.expectRevert();
        crew.setThresholds(1, 2, 3);
        _viaTimelock(address(crew), abi.encodeCall(CrewTiers.setThresholds, (1e18, 2e18, 3e18)));
        assertEq(crew.thresholds(2), 3e18);
    }

    function test_thresholds_mustIncrease() public {
        bytes memory bad = abi.encodeCall(CrewTiers.setThresholds, (2e18, 2e18, 3e18));
        bytes32 salt = _schedule(address(crew), bad);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert();
        _execute(address(crew), bad, salt);
    }

    /// TWAB matches a brute-force integral for random stake / unstake sequences.
    function testFuzz_twabMatchesReference(uint256 seed) public {
        uint256 bal;
        uint256 n = 12;
        uint256[] memory times = new uint256[](n + 1);
        uint256[] memory bals = new uint256[](n + 1);
        uint256 t = vm.getBlockTimestamp();
        for (uint256 i; i < n; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 amt = bound(seed, 1, 500_000e18);
            if (seed % 3 == 0 && bal != 0) {
                amt = bound(amt, 1, bal);
                vm.prank(alice);
                crew.unstake(amt);
                bal -= amt;
            } else {
                _stake(alice, amt);
                bal += amt;
            }
            times[i] = t;
            bals[i] = bal;
            t += bound(seed >> 128, 1, 3 days);
            vm.warp(t);
        }
        // Reference: integrate the step function over [t - 7 days, t].
        uint256 start = t - 7 days;
        uint256 area;
        for (uint256 i; i < n; ++i) {
            uint256 a = times[i];
            uint256 b = i + 1 < n ? times[i + 1] : t;
            if (b <= start) continue;
            if (a < start) a = start;
            area += bals[i] * (b - a);
        }
        assertEq(crew.twabOf(alice), area / 7 days);
        assertEq(crew.totalTwab(), area / 7 days);
    }
}

contract BuildFuelTest is VenturesBase {
    address alice = makeAddr("alice");

    function setUp() public {
        _deployVentures();
        _fundNymo(alice, 1_000_000e18);
    }

    function test_lockUnlock_events() public {
        vm.expectEmit(address(fuel));
        emit BuildFuel.Locked(alice, 100e18, 100e18);
        vm.prank(alice);
        fuel.lock(100e18);
        assertEq(fuel.lockedOf(alice), 100e18);
        assertEq(fuel.dailyFuelOf(alice), 1_000e18);
        vm.expectEmit(address(fuel));
        emit BuildFuel.Unlocked(alice, 30e18, 70e18);
        vm.prank(alice);
        fuel.unlock(30e18);
        assertEq(fuel.totalLocked(), 70e18);
        assertEq(nymo.balanceOf(address(fuel)), 70e18);
    }

    function test_pause_stopsLockNotUnlock() public {
        vm.prank(alice);
        fuel.lock(5e18);
        vm.prank(safe);
        fuel.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        fuel.lock(1e18);
        vm.prank(alice);
        fuel.unlock(5e18);
        assertEq(nymo.balanceOf(alice), 1_000_000e18);
    }

    function test_unlock_tooMuchReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BuildFuel.InsufficientLock.selector, 0));
        fuel.unlock(1);
    }

    function test_fuelRate_throughTimelock() public {
        vm.prank(safe);
        vm.expectRevert();
        fuel.setFuelRate(1);
        bytes memory data = abi.encodeCall(BuildFuel.setFuelRate, (3e18));
        bytes32 salt = _schedule(address(fuel), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectEmit(address(fuel));
        emit BuildFuel.FuelRateSet(3e18);
        _execute(address(fuel), data, salt);
        assertEq(fuel.fuelRate(), 3e18);
    }

    function testFuzz_lockUnlockRoundTrip(uint256 a, uint256 b) public {
        a = bound(a, 1, 1_000_000e18);
        b = bound(b, 1, a);
        vm.startPrank(alice);
        fuel.lock(a);
        fuel.unlock(b);
        vm.stopPrank();
        assertEq(fuel.lockedOf(alice), a - b);
        assertEq(nymo.balanceOf(address(fuel)), a - b);
        assertEq(nymo.balanceOf(alice), 1_000_000e18 - (a - b));
    }
}
