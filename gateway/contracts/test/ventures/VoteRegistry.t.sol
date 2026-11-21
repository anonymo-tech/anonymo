// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VoteRegistry} from "../../src/ventures/VoteRegistry.sol";
import {VenturesBase} from "./VenturesBase.sol";

contract VoteRegistryTest is VenturesBase {
    address whale = makeAddr("whale");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address small = makeAddr("small");
    bytes32 constant OPT_A = keccak256("family.a");
    bytes32 constant OPT_B = keccak256("family.b");
    VoteRegistry.BallotKind constant CREW_FAMILY = VoteRegistry.BallotKind.CrewFamily;
    VoteRegistry.BallotKind constant FORK_TARGET = VoteRegistry.BallotKind.ForkTarget;

    function setUp() public {
        _deployVentures();
        _fundNymo(whale, 10_000_000e18);
        _fundNymo(alice, 1_000_000e18);
        _fundNymo(bob, 1_000_000e18);
        _fundNymo(small, 1_000e18);
        vm.prank(whale);
        crew.stake(9_000_000e18);
        vm.prank(alice);
        crew.stake(300_000e18); // Gang
        vm.prank(bob);
        crew.stake(100_000e18);
        vm.prank(small);
        crew.stake(1_000e18);
        // Register options for epoch 1 through the timelock (7 days = one epoch ahead).
        bytes32[] memory opts = new bytes32[](2);
        opts[0] = OPT_A;
        opts[1] = OPT_B;
        _viaTimelock(address(votes), abi.encodeCall(VoteRegistry.registerOptions, (1, CREW_FAMILY, opts)));
        assertEq(votes.currentEpoch(), 1);
    }

    function test_weight_isCappedAtTwoPercentOfTotal() public view {
        // Measured over the 7 days before epoch 1 starts: the full stake of everyone.
        uint256 total = 9_401_000e18;
        uint256 cap = (total * 200) / 10_000;
        assertEq(votes.weightOf(whale, 1), cap);
        assertEq(votes.weightOf(small, 1), 1_000e18);
        assertEq(votes.weightOf(alice, 1), cap < 300_000e18 ? cap : 300_000e18);
    }

    function test_vote_tallyAndChangeWithinEpoch() public {
        uint256 wSmall = votes.weightOf(small, 1);
        uint256 wWhale = votes.weightOf(whale, 1);
        vm.prank(small);
        votes.vote(CREW_FAMILY, OPT_A);
        vm.prank(whale);
        votes.vote(CREW_FAMILY, OPT_A);
        assertEq(votes.tally(1, CREW_FAMILY, OPT_A), wSmall + wWhale);
        vm.expectEmit(address(votes));
        emit VoteRegistry.Voted(1, CREW_FAMILY, whale, OPT_B, wWhale, OPT_A);
        vm.prank(whale);
        votes.vote(CREW_FAMILY, OPT_B);
        (bytes32[] memory o, uint256[] memory t) = votes.results(1, CREW_FAMILY);
        assertEq(o.length, 2);
        assertEq(o[0], OPT_A);
        assertEq(t[0], wSmall);
        assertEq(t[1], wWhale);
        (bytes32 lead, uint256 lw) = votes.leader(1, CREW_FAMILY);
        assertEq(lead, OPT_B);
        assertEq(lw, wWhale);
        (bytes32 mine, uint256 w) = votes.voteOf(1, CREW_FAMILY, whale);
        assertEq(mine, OPT_B);
        assertEq(w, wWhale);
    }

    function test_vote_stakeMovedDuringEpochCannotVoteTwice() public {
        address fresh = makeAddr("fresh");
        vm.prank(small);
        votes.vote(CREW_FAMILY, OPT_A);
        vm.prank(small);
        crew.unstake(1_000e18);
        vm.prank(small);
        nymo.transfer(fresh, 1_000e18);
        vm.startPrank(fresh);
        nymo.approve(address(crew), type(uint256).max);
        crew.stake(1_000e18);
        vm.warp(vm.getBlockTimestamp() + 6 days); // still epoch 1
        vm.expectRevert(VoteRegistry.NoWeight.selector);
        votes.vote(CREW_FAMILY, OPT_A);
        vm.stopPrank();
    }

    function test_vote_unknownOptionAndBallotKinds() public {
        vm.prank(small);
        vm.expectRevert(abi.encodeWithSelector(VoteRegistry.UnknownOption.selector, OPT_A));
        votes.vote(FORK_TARGET, OPT_A);
        vm.prank(makeAddr("nobody"));
        vm.expectRevert(VoteRegistry.NoWeight.selector);
        votes.vote(CREW_FAMILY, OPT_A);
    }

    function test_propose_gangTierOnly() public {
        bytes32 target = keccak256("fork.target");
        vm.prank(bob); // 100k: Crew, not above it
        vm.expectRevert(abi.encodeWithSelector(VoteRegistry.TierTooLow.selector, uint8(1)));
        votes.propose(1, FORK_TARGET, target);
        vm.prank(alice);
        votes.propose(1, FORK_TARGET, target);
        assertTrue(votes.isOption(votes.ballotKey(1, FORK_TARGET), target));
        vm.prank(alice);
        vm.expectRevert(VoteRegistry.AlreadyProposed.selector);
        votes.propose(1, FORK_TARGET, keccak256("another"));
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(VoteRegistry.DuplicateOption.selector, target));
        votes.propose(1, FORK_TARGET, target);
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(VoteRegistry.PastEpoch.selector, 0));
        votes.propose(0, FORK_TARGET, keccak256("late"));
        vm.prank(bob);
        votes.vote(FORK_TARGET, target);
    }

    function test_registerOptions_onlyTimelockAndNotPast() public {
        bytes32[] memory opts = new bytes32[](1);
        opts[0] = keccak256("x");
        vm.prank(safe);
        vm.expectRevert();
        votes.registerOptions(2, CREW_FAMILY, opts);
        bytes memory past = abi.encodeCall(VoteRegistry.registerOptions, (1, FORK_TARGET, opts));
        bytes32 salt = _schedule(address(votes), past);
        vm.warp(vm.getBlockTimestamp() + DELAY); // now epoch 2
        vm.expectRevert();
        _execute(address(votes), past, salt);
    }

    function test_maxOptions() public {
        bytes32[] memory opts = new bytes32[](65);
        for (uint256 i; i < 65; ++i) {
            opts[i] = bytes32(i + 1);
        }
        bytes memory data = abi.encodeCall(VoteRegistry.registerOptions, (5, FORK_TARGET, opts));
        bytes32 salt = _schedule(address(votes), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert();
        _execute(address(votes), data, salt);
    }

    /// The tally of each option always equals the sum of the weights currently cast for it.
    function testFuzz_tallyEqualsCastWeights(uint8[8] memory picks) public {
        address[4] memory voters = [whale, alice, bob, small];
        for (uint256 i; i < picks.length; ++i) {
            address v = voters[picks[i] % 4];
            bytes32 opt = picks[i] % 2 == 0 ? OPT_A : OPT_B;
            vm.prank(v);
            votes.vote(CREW_FAMILY, opt);
        }
        uint256 a;
        uint256 b;
        for (uint256 i; i < 4; ++i) {
            (bytes32 o, uint256 w) = votes.voteOf(1, CREW_FAMILY, voters[i]);
            if (o == OPT_A) a += w;
            else if (o == OPT_B) b += w;
        }
        assertEq(votes.tally(1, CREW_FAMILY, OPT_A), a);
        assertEq(votes.tally(1, CREW_FAMILY, OPT_B), b);
    }
}
