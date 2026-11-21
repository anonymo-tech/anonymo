// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {AnonymoTimelock} from "../../src/anonymo/AnonymoTimelock.sol";
import {CrewTiers} from "../../src/ventures/CrewTiers.sol";
import {BuildFuel} from "../../src/ventures/BuildFuel.sol";
import {Checkout} from "../../src/ventures/Checkout.sol";
import {VenturesFeeRouter} from "../../src/ventures/VenturesFeeRouter.sol";
import {RecipeRegistry} from "../../src/ventures/RecipeRegistry.sol";
import {ForkFund} from "../../src/ventures/ForkFund.sol";
import {VenturesGuarded} from "../../src/ventures/VenturesOwned.sol";
import {VenturesBase} from "./VenturesBase.sol";

/// Random direct setter calls (from the Safe, the guardian, the gateway signer, the deployer or anyone), random
/// schedules through the 7-day timelock, early execution attempts and on-time executions. A model of every
/// setting changes only when the handler executes a queued entry after its delay.
contract GovernanceHandler is CommonBase, StdUtils {
    struct Op {
        uint8 kind;
        uint256 value;
        bytes32 salt;
        uint256 readyAt;
        bool done;
    }

    uint256 constant DELAY = 7 days;
    bytes32 constant SKU = keccak256("sku.build.small");
    uint8 constant KINDS = 7;

    AnonymoTimelock public timelock;
    address public safe;
    CrewTiers public crew;
    BuildFuel public fuel;
    Checkout public checkout;
    VenturesFeeRouter public router;
    RecipeRegistry public recipes;
    ForkFund public fork;
    address[] internal callers;

    Op[] internal ops;
    uint256 private _salt;

    // the model
    uint256 public expCrewThreshold;
    uint256 public expFuelRate;
    uint256 public expSkuPrice;
    address public expWorkers;
    address public expSigner;
    address public expFulfiller;
    address public expGuardian;

    bool public directSetterApplied;
    bool public earlyExecutionApplied;
    uint256 public executed;

    constructor(
        AnonymoTimelock t,
        address safe_,
        CrewTiers c,
        BuildFuel f,
        Checkout co,
        VenturesFeeRouter r,
        RecipeRegistry rr,
        ForkFund ff,
        address[] memory callers_
    ) {
        timelock = t;
        safe = safe_;
        crew = c;
        fuel = f;
        checkout = co;
        router = r;
        recipes = rr;
        fork = ff;
        callers = callers_;
        expCrewThreshold = c.thresholds(0);
        expFuelRate = f.fuelRate();
        expSkuPrice = co.skuPrice(SKU);
        expWorkers = r.workers();
        expSigner = rr.signer();
        expFulfiller = ff.fulfiller();
        expGuardian = c.guardian();
    }

    function _call(uint8 kind, uint256 v) internal view returns (address target, bytes memory data) {
        address a = address(uint160(bound(v, 1, type(uint160).max)));
        if (kind == 0) return (address(crew), abi.encodeCall(CrewTiers.setThresholds, (v, v + 1, v + 2)));
        if (kind == 1) return (address(fuel), abi.encodeCall(BuildFuel.setFuelRate, (v)));
        if (kind == 2) return (address(checkout), abi.encodeCall(Checkout.setSkuPrice, (SKU, v)));
        if (kind == 3) return (address(router), abi.encodeCall(VenturesFeeRouter.setWorkers, (a)));
        if (kind == 4) return (address(recipes), abi.encodeCall(RecipeRegistry.setSigner, (a)));
        if (kind == 5) return (address(fork), abi.encodeCall(ForkFund.setFulfiller, (a)));
        return (address(crew), abi.encodeCall(VenturesGuarded.setGuardian, (a)));
    }

    function _apply(uint8 kind, uint256 v) internal {
        address a = address(uint160(bound(v, 1, type(uint160).max)));
        if (kind == 0) expCrewThreshold = v;
        else if (kind == 1) expFuelRate = v;
        else if (kind == 2) expSkuPrice = v;
        else if (kind == 3) expWorkers = a;
        else if (kind == 4) expSigner = a;
        else if (kind == 5) expFulfiller = a;
        else expGuardian = a;
    }

    function direct(uint256 who, uint8 kind, uint256 v) external {
        kind = uint8(bound(kind, 0, KINDS - 1));
        v = bound(v, 1, 1e30);
        (address target, bytes memory data) = _call(kind, v);
        vm.prank(callers[who % callers.length]);
        (bool ok,) = target.call(data);
        if (ok) directSetterApplied = true;
    }

    function schedule(uint8 kind, uint256 v) external {
        kind = uint8(bound(kind, 0, KINDS - 1));
        v = bound(v, 1, 1e30);
        (address target, bytes memory data) = _call(kind, v);
        bytes32 salt = bytes32(++_salt);
        vm.prank(safe);
        timelock.schedule(target, 0, data, bytes32(0), salt, DELAY);
        ops.push(Op(kind, v, salt, vm.getBlockTimestamp() + DELAY, false));
    }

    function executeEarly(uint256 i) external {
        if (ops.length == 0) return;
        Op storage op = ops[i % ops.length];
        if (op.done || vm.getBlockTimestamp() >= op.readyAt) return;
        (address target, bytes memory data) = _call(op.kind, op.value);
        vm.prank(safe);
        try timelock.execute(target, 0, data, bytes32(0), op.salt) {
            earlyExecutionApplied = true;
        } catch {}
    }

    function execute(uint256 i) external {
        if (ops.length == 0) return;
        Op storage op = ops[i % ops.length];
        if (op.done) return;
        if (vm.getBlockTimestamp() < op.readyAt) vm.warp(op.readyAt);
        (address target, bytes memory data) = _call(op.kind, op.value);
        vm.prank(safe);
        timelock.execute(target, 0, data, bytes32(0), op.salt);
        op.done = true;
        _apply(op.kind, op.value);
        ++executed;
    }

    function advance(uint256 s) external {
        vm.warp(vm.getBlockTimestamp() + bound(s, 1, 3 days));
    }
}

contract VenturesTimelockInvariantTest is VenturesBase {
    GovernanceHandler handler;

    function setUp() public {
        _deployVentures();
        address[] memory callers = new address[](5);
        callers[0] = safe; // also the guardian
        callers[1] = signer;
        callers[2] = address(this); // the deployer
        callers[3] = makeAddr("anyone");
        callers[4] = workers;
        handler = new GovernanceHandler(timelock, safe, crew, fuel, checkout, router, recipes, fork, callers);
        targetContract(address(handler));
    }

    /// No setter applies without a queued timelock entry that waited the full 7 days.
    function invariant_noSetterWithoutQueuedEntry() public view {
        assertFalse(handler.directSetterApplied());
        assertFalse(handler.earlyExecutionApplied());
        assertEq(crew.thresholds(0), handler.expCrewThreshold());
        assertEq(fuel.fuelRate(), handler.expFuelRate());
        assertEq(checkout.skuPrice(SKU), handler.expSkuPrice());
        assertEq(router.workers(), handler.expWorkers());
        assertEq(recipes.signer(), handler.expSigner());
        assertEq(fork.fulfiller(), handler.expFulfiller());
        assertEq(crew.guardian(), handler.expGuardian());
        assertEq(timelock.getMinDelay(), DELAY);
    }

    function afterInvariant() external view {
        handler.executed();
    }
}
