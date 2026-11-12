// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ReceiptRoots} from "../../src/anonymo/ReceiptRoots.sol";
import {TimelockOwned} from "../../src/anonymo/TimelockOwned.sol";
import {IReceiptRoots} from "../../src/anonymo/interfaces/IAnonymo.sol";
import {AnonymoBase} from "./AnonymoBase.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

contract ReceiptRootsTest is AnonymoBase {
    ReceiptRoots roots;
    address signer = makeAddr("signer");
    uint64 hourNow;

    function setUp() public {
        vm.warp(1_790_000_000);
        hourNow = uint64(block.timestamp / 1 hours);
        timelock = _deployTimelock();
        roots = new ReceiptRoots(address(timelock), signer);
    }

    function test_constructor() public view {
        assertEq(roots.owner(), address(timelock));
        assertEq(roots.signer(), signer);
        assertEq(roots.rootOf(hourNow), bytes32(0));
    }

    function test_post_storesAndEmits() public {
        vm.expectEmit(address(roots));
        emit IReceiptRoots.RootPosted(hourNow - 1, keccak256("r"));
        vm.prank(signer);
        roots.post(hourNow - 1, keccak256("r"));
        assertEq(roots.rootOf(hourNow - 1), keccak256("r"));
    }

    function test_post_currentHourAllowed() public {
        vm.prank(signer);
        roots.post(hourNow, keccak256("r"));
        assertEq(roots.rootOf(hourNow), keccak256("r"));
    }

    function test_post_futureHourRejected() public {
        vm.prank(signer);
        vm.expectRevert(IReceiptRoots.FutureHour.selector);
        roots.post(hourNow + 1, keccak256("r"));
    }

    function test_post_onlySigner() public {
        vm.expectRevert(IReceiptRoots.NotSigner.selector);
        roots.post(hourNow, keccak256("r"));
        // not even the owner
        vm.prank(address(timelock));
        vm.expectRevert(IReceiptRoots.NotSigner.selector);
        roots.post(hourNow, keccak256("r"));
    }

    function test_post_emptyRootRejected() public {
        vm.prank(signer);
        vm.expectRevert(IReceiptRoots.EmptyRoot.selector);
        roots.post(hourNow, bytes32(0));
    }

    /// A ReceiptRoots root can't be overwritten.
    function test_rootCannotBeOverwritten() public {
        vm.startPrank(signer);
        roots.post(hourNow, keccak256("first"));
        vm.expectRevert(abi.encodeWithSelector(IReceiptRoots.RootExists.selector, hourNow));
        roots.post(hourNow, keccak256("second"));
        vm.expectRevert(abi.encodeWithSelector(IReceiptRoots.RootExists.selector, hourNow));
        roots.post(hourNow, keccak256("first"));
        vm.stopPrank();
        assertEq(roots.rootOf(hourNow), keccak256("first"));
    }

    function testFuzz_rootCannotBeOverwritten(uint64 hour, bytes32 a, bytes32 b) public {
        hour = uint64(bound(hour, 0, hourNow));
        vm.assume(a != bytes32(0) && b != bytes32(0));
        vm.prank(signer);
        roots.post(hour, a);
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(IReceiptRoots.RootExists.selector, hour));
        roots.post(hour, b);
        assertEq(roots.rootOf(hour), a);
    }

    /// A new signer still cannot overwrite the old signer's roots.
    function test_newSignerCannotOverwrite() public {
        vm.prank(signer);
        roots.post(hourNow, keccak256("first"));
        address next = makeAddr("next");
        _viaTimelock(address(roots), abi.encodeCall(ReceiptRoots.setSigner, (next)));
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(IReceiptRoots.RootExists.selector, hourNow));
        roots.post(hourNow, keccak256("second"));
    }

    function test_signerChange_goesThroughTimelock() public {
        address next = makeAddr("next");
        // Direct calls fail, even from the Safe.
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        roots.setSigner(next);

        bytes memory data = abi.encodeCall(ReceiptRoots.setSigner, (next));
        bytes32 salt = _schedule(address(roots), data);
        // One second short of 48 hours: not ready.
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(roots), 0, data, bytes32(0), salt);
        assertEq(roots.signer(), signer);

        vm.warp(block.timestamp + 1);
        vm.prank(safe);
        timelock.execute(address(roots), 0, data, bytes32(0), salt);
        assertEq(roots.signer(), next);

        vm.prank(signer);
        vm.expectRevert(IReceiptRoots.NotSigner.selector);
        roots.post(uint64(block.timestamp / 1 hours), keccak256("x"));
        vm.prank(next);
        roots.post(uint64(block.timestamp / 1 hours), keccak256("x"));
    }

    function test_constructor_rejectsShortTimelockAndEoa() public {
        TimelockController short = _deployTimelock(DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockOwned.NotTimelock.selector, address(short)));
        new ReceiptRoots(address(short), signer);
        vm.expectRevert(abi.encodeWithSelector(TimelockOwned.NotTimelock.selector, safe));
        new ReceiptRoots(safe, signer);
    }

    function test_ownership_onlyToAnotherTimelock_andNeverRenounced() public {
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(TimelockOwned.NotTimelock.selector, safe));
        roots.transferOwnership(safe);

        vm.prank(address(timelock));
        vm.expectRevert(TimelockOwned.RenounceDisabled.selector);
        roots.renounceOwnership();

        TimelockController next = _deployTimelock();
        _viaTimelock(address(roots), abi.encodeCall(Ownable.transferOwnership, (address(next))));
        assertEq(roots.pendingOwner(), address(next));
    }

    /// If the timelock's delay is lowered below 48 hours, owner calls stop working.
    function test_ownerCallsStopIfDelayLowered() public {
        _viaTimelock(address(timelock), abi.encodeCall(TimelockController.updateDelay, (1 hours)));
        assertEq(timelock.getMinDelay(), 1 hours);
        bytes memory data = abi.encodeCall(ReceiptRoots.setSigner, (makeAddr("next")));
        vm.prank(safe);
        timelock.schedule(address(roots), 0, data, bytes32(0), bytes32("low"), 1 hours);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(roots), 0, data, bytes32(0), bytes32("low"));
        assertEq(roots.signer(), signer);
    }
}

/// Invariant: once posted, a root never changes.
contract ReceiptRootsHandler is CommonBase, StdUtils {
    ReceiptRoots public roots;
    address public signer;
    uint64[] public hours_;
    mapping(uint64 => bytes32) public first;

    constructor(ReceiptRoots roots_, address signer_) {
        roots = roots_;
        signer = signer_;
    }

    function post(uint64 hour, bytes32 root) external {
        uint64 nowHour = uint64(block.timestamp / 1 hours);
        hour = uint64(bound(hour, nowHour > 50 ? nowHour - 50 : 0, nowHour));
        if (root == bytes32(0)) root = bytes32(uint256(1));
        vm.prank(signer);
        try roots.post(hour, root) {
            first[hour] = root;
            hours_.push(hour);
        } catch {
            require(first[hour] != bytes32(0), "post failed on an empty hour");
        }
    }

    function repost(uint256 i, bytes32 root) external {
        if (hours_.length == 0) return;
        uint64 hour = hours_[i % hours_.length];
        vm.prank(signer);
        try roots.post(hour, root) {
            revert("overwrote a root");
        } catch {}
    }

    function advance(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 3 hours));
    }

    function count() external view returns (uint256) {
        return hours_.length;
    }
}

contract ReceiptRootsInvariantTest is AnonymoBase {
    ReceiptRoots roots;
    ReceiptRootsHandler handler;

    function setUp() public {
        vm.warp(1_790_000_000);
        timelock = _deployTimelock();
        address signer = makeAddr("signer");
        roots = new ReceiptRoots(address(timelock), signer);
        handler = new ReceiptRootsHandler(roots, signer);
        targetContract(address(handler));
    }

    function invariant_postedRootsNeverChange() public view {
        uint256 n = handler.count();
        for (uint256 i; i < n; ++i) {
            uint64 h = handler.hours_(i);
            assertEq(roots.rootOf(h), handler.first(h));
        }
    }
}
