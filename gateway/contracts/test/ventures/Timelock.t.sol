// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {AnonymoTimelock} from "../../src/anonymo/AnonymoTimelock.sol";
import {TimelockOwned} from "../../src/anonymo/TimelockOwned.sol";
import {CrewTiers} from "../../src/ventures/CrewTiers.sol";
import {BuildFuel} from "../../src/ventures/BuildFuel.sol";
import {Checkout} from "../../src/ventures/Checkout.sol";
import {VenturesFeeRouter} from "../../src/ventures/VenturesFeeRouter.sol";
import {RecipeRegistry} from "../../src/ventures/RecipeRegistry.sol";
import {ForkFund} from "../../src/ventures/ForkFund.sol";
import {VoteRegistry} from "../../src/ventures/VoteRegistry.sol";
import {VenturesGuarded} from "../../src/ventures/VenturesOwned.sol";
import {IPriceOracle} from "../../src/ventures/interfaces/IVentures.sol";
import {MockPriceOracle} from "../../src/ventures/mocks/MockPriceOracle.sol";
import {VenturesBase} from "./VenturesBase.sol";

/// Every setter on every Ventures contract: refused when called directly (by the Safe, the guardian or anyone),
/// refused when executed before the 7-day delay, applied after it.
contract VenturesTimelockTest is VenturesBase {
    struct Call {
        address target;
        bytes data;
    }

    address next = makeAddr("next");

    function setUp() public {
        _deployVentures();
    }

    function _setters() internal returns (Call[] memory c) {
        MockPriceOracle o2 = new MockPriceOracle(PRICE, PRICE);
        bytes32[] memory opts = new bytes32[](1);
        opts[0] = keccak256("opt");
        c = new Call[](20);
        c[0] = Call(address(crew), abi.encodeCall(CrewTiers.setThresholds, (1e18, 2e18, 3e18)));
        c[1] = Call(address(crew), abi.encodeCall(VenturesGuarded.setGuardian, (next)));
        c[2] = Call(address(fuel), abi.encodeCall(BuildFuel.setFuelRate, (1)));
        c[3] = Call(address(fuel), abi.encodeCall(VenturesGuarded.setGuardian, (next)));
        c[4] = Call(address(checkout), abi.encodeCall(Checkout.setSkuPrice, (SKU, 1)));
        c[5] = Call(address(checkout), abi.encodeCall(Checkout.setOracle, (IPriceOracle(address(o2)))));
        c[6] = Call(address(checkout), abi.encodeCall(VenturesGuarded.setGuardian, (next)));
        c[7] = Call(address(router), abi.encodeCall(VenturesFeeRouter.setWorkers, (next)));
        c[8] = Call(address(router), abi.encodeCall(VenturesFeeRouter.setTreasury, (next)));
        c[9] = Call(address(router), abi.encodeCall(VenturesFeeRouter.setStakerCredits, (next)));
        c[10] = Call(address(router), abi.encodeCall(VenturesFeeRouter.setBuyBurn, (next)));
        c[11] = Call(address(recipes), abi.encodeCall(RecipeRegistry.setSigner, (next)));
        c[12] = Call(address(recipes), abi.encodeCall(VenturesGuarded.setGuardian, (next)));
        c[13] = Call(address(fork), abi.encodeCall(ForkFund.setOracle, (IPriceOracle(address(o2)))));
        c[14] = Call(address(fork), abi.encodeCall(ForkFund.setFulfiller, (next)));
        c[15] = Call(address(fork), abi.encodeCall(VenturesGuarded.setGuardian, (next)));
        c[16] = Call(address(votes), abi.encodeCall(VoteRegistry.registerOptions, (1000, VoteRegistry.BallotKind.CrewFamily, opts)));
        c[17] = Call(address(crew), abi.encodeWithSignature("unpause()"));
        c[18] = Call(address(checkout), abi.encodeWithSignature("unpause()"));
        c[19] = Call(address(fork), abi.encodeWithSignature("unpause()"));
    }

    function test_everySetter_needsAQueuedTimelockEntry() public {
        _pauseAll(); // so that unpause() has something to do
        Call[] memory c = _setters();
        address[3] memory callers = [safe, makeAddr("anyone"), signer];
        for (uint256 i; i < c.length; ++i) {
            for (uint256 j; j < callers.length; ++j) {
                vm.prank(callers[j]);
                (bool ok,) = c[i].target.call(c[i].data);
                assertFalse(ok, "direct setter call succeeded");
            }
            bytes32 salt = _schedule(c[i].target, c[i].data);
            vm.warp(vm.getBlockTimestamp() + DELAY - 1);
            vm.prank(safe);
            vm.expectRevert();
            timelock.execute(c[i].target, 0, c[i].data, bytes32(0), salt);
            vm.warp(vm.getBlockTimestamp() + 1);
            _execute(c[i].target, c[i].data, salt);
        }
        assertEq(crew.thresholds(0), 1e18);
        assertEq(fuel.fuelRate(), 1);
        assertEq(checkout.skuPrice(SKU), 1);
        assertEq(router.buyBurn(), next);
        assertEq(recipes.signer(), next);
        assertEq(fork.fulfiller(), next);
        assertEq(crew.guardian(), next);
        assertFalse(checkout.paused());
        assertTrue(votes.isOption(votes.ballotKey(1000, VoteRegistry.BallotKind.CrewFamily), keccak256("opt")));
    }

    function test_onlyTheSafeCanSchedule() public {
        vm.prank(makeAddr("anyone"));
        vm.expectRevert();
        timelock.schedule(address(fuel), 0, abi.encodeCall(BuildFuel.setFuelRate, (1)), bytes32(0), 0, DELAY);
    }

    function test_constructor_refuses48HourTimelock() public {
        address[] memory s = new address[](1);
        s[0] = safe;
        AnonymoTimelock short = new AnonymoTimelock(48 hours, s, s, address(0));
        vm.expectRevert(abi.encodeWithSelector(TimelockOwned.NotTimelock.selector, address(short)));
        new BuildFuel(IERC20(address(nymo)), address(short), safe, 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockOwned.NotTimelock.selector, safe));
        new BuildFuel(IERC20(address(nymo)), safe, safe, 1);
    }

    function test_transferOwnership_refusesShortTimelock() public {
        address[] memory s = new address[](1);
        s[0] = safe;
        AnonymoTimelock short = new AnonymoTimelock(3 days, s, s, address(0));
        bytes memory data = abi.encodeCall(Ownable.transferOwnership, (address(short)));
        bytes32 salt = _schedule(address(fuel), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert();
        _execute(address(fuel), data, salt);
    }

    function test_settersFreezeIfDelayDropsBelowSevenDays() public {
        _viaTimelock(address(timelock), abi.encodeCall(TimelockController.updateDelay, (3 days)));
        assertEq(timelock.getMinDelay(), 3 days);
        bytes memory data = abi.encodeCall(BuildFuel.setFuelRate, (1));
        bytes32 salt = bytes32(uint256(999));
        vm.prank(safe);
        timelock.schedule(address(fuel), 0, data, bytes32(0), salt, 3 days);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(fuel), 0, data, bytes32(0), salt);
        assertEq(fuel.fuelRate(), FUEL_RATE);
    }

    function test_renounceDisabled() public {
        bytes memory data = abi.encodeWithSignature("renounceOwnership()");
        bytes32 salt = _schedule(address(crew), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert();
        _execute(address(crew), data, salt);
    }

    function test_pause_guardianOrOwnerOnly() public {
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(VenturesGuarded.NotGuardian.selector);
        crew.pause();
        vm.prank(safe);
        crew.pause();
        assertTrue(crew.paused());
        vm.prank(safe);
        vm.expectRevert();
        crew.unpause();
    }
}
