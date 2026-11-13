// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Vm} from "forge-std/Vm.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {DepositRouter} from "../../src/anonymo/DepositRouter.sol";
import {IDepositRouter} from "../../src/anonymo/interfaces/IAnonymo.sol";
import {MockStable, MockStableNoPermit} from "../../src/anonymo/mocks/MockStable.sol";
import {AnonymoBase} from "./AnonymoBase.sol";

/// 1% fee on every transfer, like a dormant USDT fee switch turned on.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

contract DepositRouterTest is AnonymoBase {
    bytes32 constant DEPOSITED_TOPIC = keccak256("Deposited(bytes32,address,address,uint256)");
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    DepositRouter router;
    MockStable usdc;
    MockStableNoPermit usdt;
    address treasury = makeAddr("treasury");
    address deployer = makeAddr("deployer");
    uint256 aliceKey = 0xA11CE;
    address alice = vm.addr(0xA11CE);
    bytes32 commit = keccak256("key-commit");

    function setUp() public {
        timelock = _deployTimelock();
        router = new DepositRouter(address(timelock), safe, treasury, deployer);
        usdc = new MockStable("USD Coin", "USDC");
        usdt = new MockStableNoPermit("Tether", "USDT");
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(usdt);
        vm.prank(deployer);
        router.bootstrap(tokens);
        usdc.mint(alice, 1_000_000e6);
        usdt.mint(alice, 1_000_000e6);
    }

    function test_eventSignatureIsFixed() public pure {
        assertEq(IDepositRouter.Deposited.selector, DEPOSITED_TOPIC);
    }

    function test_deposit_forwardsToTreasuryAndEmits() public {
        vm.startPrank(alice);
        usdc.approve(address(router), 25e6);
        vm.recordLogs();
        router.deposit(address(usdc), 25e6, commit);
        vm.stopPrank();
        assertEq(usdc.balanceOf(treasury), 25e6);
        assertEq(usdc.balanceOf(address(router)), 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory dep = logs[logs.length - 1];
        assertEq(dep.emitter, address(router));
        assertEq(dep.topics.length, 4);
        assertEq(dep.topics[0], DEPOSITED_TOPIC);
        assertEq(dep.topics[1], commit);
        assertEq(dep.topics[2], bytes32(uint256(uint160(address(usdc)))));
        assertEq(dep.topics[3], bytes32(uint256(uint160(alice))));
        assertEq(abi.decode(dep.data, (uint256)), 25e6);
    }

    function testFuzz_deposit_neverHoldsFunds(uint256 amount, bytes32 keyCommit, bool useUsdt) public {
        amount = bound(amount, 1, 1_000_000e6);
        vm.assume(keyCommit != bytes32(0));
        IERC20 token = useUsdt ? IERC20(address(usdt)) : IERC20(address(usdc));
        vm.startPrank(alice);
        token.approve(address(router), amount);
        vm.expectEmit(address(router));
        emit IDepositRouter.Deposited(keyCommit, address(token), alice, amount);
        router.deposit(address(token), amount, keyCommit);
        vm.stopPrank();
        assertEq(token.balanceOf(treasury), amount);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_deposit_rejectsUnlistedZeroAndEmptyCommit() public {
        MockStable other = new MockStable("Other", "OTH");
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(DepositRouter.TokenNotAllowed.selector, address(other)));
        router.deposit(address(other), 1, commit);
        vm.expectRevert(DepositRouter.ZeroAmount.selector);
        router.deposit(address(usdc), 0, commit);
        vm.expectRevert(DepositRouter.EmptyKeyCommit.selector);
        router.deposit(address(usdc), 1, bytes32(0));
        vm.stopPrank();
    }

    function test_deposit_withoutAllowanceReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        router.deposit(address(usdc), 1e6, commit);
    }

    function test_deposit_feeOnTransferEmitsReceived() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        _viaTimelock(address(router), abi.encodeCall(DepositRouter.setAllowed, (address(fot), true)));
        fot.mint(alice, 100e6);
        vm.startPrank(alice);
        fot.approve(address(router), 100e6);
        vm.expectEmit(address(router));
        emit IDepositRouter.Deposited(commit, address(fot), alice, 99e6);
        router.deposit(address(fot), 100e6, commit);
        vm.stopPrank();
        assertEq(fot.balanceOf(treasury), 99e6);
    }

    // ------------------------------------------------------------ permit

    function _permitSig(uint256 amount, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                alice,
                address(router),
                amount,
                usdc.nonces(alice),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(aliceKey, digest);
    }

    function test_depositWithPermit() public {
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(40e6, block.timestamp + 1 hours);
        vm.expectEmit(address(router));
        emit IDepositRouter.Deposited(commit, address(usdc), alice, 40e6);
        vm.prank(alice);
        router.depositWithPermit(address(usdc), 40e6, commit, block.timestamp + 1 hours, v, r, s);
        assertEq(usdc.balanceOf(treasury), 40e6);
        assertEq(usdc.allowance(alice, address(router)), 0);
    }

    /// Someone submits the permit first: the deposit still goes through on the allowance it set.
    function test_depositWithPermit_frontRunPermitStillDeposits() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(40e6, deadline);
        usdc.permit(alice, address(router), 40e6, deadline, v, r, s);
        vm.prank(alice);
        router.depositWithPermit(address(usdc), 40e6, commit, deadline, v, r, s);
        assertEq(usdc.balanceOf(treasury), 40e6);
    }

    /// A token without permit falls back to the existing allowance.
    function test_depositWithPermit_tokenWithoutPermitUsesAllowance() public {
        vm.startPrank(alice);
        usdt.approve(address(router), 5e6);
        router.depositWithPermit(address(usdt), 5e6, commit, 0, 0, bytes32(0), bytes32(0));
        vm.stopPrank();
        assertEq(usdt.balanceOf(treasury), 5e6);
    }

    function test_depositWithPermit_badSignatureAndNoAllowanceReverts() public {
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(40e6, block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert();
        router.depositWithPermit(address(usdc), 41e6, commit, block.timestamp + 1 hours, v, r, s);
    }

    // ------------------------------------------------------------ pause

    function test_pause_stopsDepositsOnly() public {
        vm.prank(safe);
        router.pause();
        vm.startPrank(alice);
        usdc.approve(address(router), 1e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.deposit(address(usdc), 1e6, commit);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.depositWithPermit(address(usdc), 1e6, commit, 0, 0, bytes32(0), bytes32(0));
        vm.stopPrank();
        // Sweep still works while paused.
        usdc.mint(address(router), 3e6);
        router.sweep(address(usdc));
        assertEq(usdc.balanceOf(treasury), 3e6);
    }

    function test_pause_guardianCannotUnpause_timelockCan() public {
        vm.prank(alice);
        vm.expectRevert(DepositRouter.NotGuardian.selector);
        router.pause();
        vm.prank(safe);
        router.pause();
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        router.unpause();
        _viaTimelock(address(router), abi.encodeCall(DepositRouter.unpause, ()));
        assertFalse(router.paused());
    }

    // ------------------------------------------------------------ admin

    function test_bootstrap_onceOnly() public {
        address[] memory tokens = new address[](1);
        tokens[0] = makeAddr("x");
        vm.prank(deployer);
        vm.expectRevert(DepositRouter.NotBootstrapper.selector);
        router.bootstrap(tokens);
        assertEq(router.bootstrapper(), address(0));
    }

    function test_admin_onlyThroughTimelock() public {
        vm.startPrank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        router.setAllowed(address(usdc), false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        router.setTreasury(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        router.setGuardian(alice);
        vm.stopPrank();

        address newTreasury = makeAddr("new-treasury");
        _viaTimelock(address(router), abi.encodeCall(DepositRouter.setTreasury, (newTreasury)));
        _viaTimelock(address(router), abi.encodeCall(DepositRouter.setAllowed, (address(usdt), false)));
        assertEq(router.treasury(), newTreasury);
        assertFalse(router.isAllowed(address(usdt)));

        vm.startPrank(alice);
        usdc.approve(address(router), 1e6);
        router.deposit(address(usdc), 1e6, commit);
        vm.stopPrank();
        assertEq(usdc.balanceOf(newTreasury), 1e6);
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(DepositRouter.ZeroAddress.selector);
        new DepositRouter(address(timelock), address(0), treasury, deployer);
        vm.expectRevert(DepositRouter.ZeroAddress.selector);
        new DepositRouter(address(timelock), safe, address(0), deployer);
        vm.expectRevert(DepositRouter.ZeroAddress.selector);
        new DepositRouter(address(timelock), safe, treasury, address(0));
    }

    // ------------------------------------------------------------ CREATE2: same address on every chain

    function _deployVia2(bytes32 salt, bytes memory initCode) internal returns (address a) {
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && ret.length == 20, "create2");
        a = address(bytes20(ret));
    }

    function test_create2_sameAddressOnBaseArbitrumAndRobinhood() public {
        assertGt(CREATE2_DEPLOYER.code.length, 0, "CREATE2 deployer present");
        bytes memory initCode = abi.encodePacked(
            type(DepositRouter).creationCode, abi.encode(address(timelock), safe, safe, deployer)
        );
        bytes32 salt = keccak256("anonymo.deposit-router.v1");
        address expected = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        uint256[3] memory chains = [uint256(8453), 42161, 4663];
        for (uint256 i; i < chains.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.chainId(chains[i]);
            assertEq(_deployVia2(salt, initCode), expected);
            assertEq(DepositRouter(expected).owner(), address(timelock));
            vm.revertToState(snap);
        }
    }
}

/// Invariant: the router never holds funds and the treasury receives exactly what was deposited.
contract DepositRouterHandler is CommonBase, StdUtils {
    DepositRouter public router;
    MockStable public usdc;
    address public treasury;
    address public guardian;
    uint256 public deposited;
    uint256 public pausedRejected;

    constructor(DepositRouter router_, MockStable usdc_, address treasury_, address guardian_) {
        router = router_;
        usdc = usdc_;
        treasury = treasury_;
        guardian = guardian_;
    }

    function deposit(uint256 amount, bytes32 keyCommit, uint256 who) external {
        amount = bound(amount, 1, 1e15);
        if (keyCommit == bytes32(0)) keyCommit = bytes32(uint256(1));
        address user = address(uint160(bound(who, 1, 5) + 0x1000));
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(router), amount);
        if (router.paused()) {
            try router.deposit(address(usdc), amount, keyCommit) {
                revert("deposit while paused");
            } catch {
                ++pausedRejected;
            }
        } else {
            router.deposit(address(usdc), amount, keyCommit);
            deposited += amount;
        }
        vm.stopPrank();
    }

    function pause() external {
        if (router.paused()) return;
        vm.prank(guardian);
        router.pause();
    }

    function unpause() external {
        if (!router.paused()) return;
        vm.prank(router.owner());
        router.unpause();
    }
}

contract DepositRouterInvariantTest is AnonymoBase {
    DepositRouter router;
    MockStable usdc;
    DepositRouterHandler handler;
    address treasury = makeAddr("treasury");

    function setUp() public {
        timelock = _deployTimelock();
        router = new DepositRouter(address(timelock), safe, treasury, address(this));
        usdc = new MockStable("USD Coin", "USDC");
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        router.bootstrap(tokens);
        handler = new DepositRouterHandler(router, usdc, treasury, safe);
        targetContract(address(handler));
    }

    function invariant_routerNeverHoldsFunds() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function invariant_treasuryGetsEveryDeposit() public view {
        assertEq(usdc.balanceOf(treasury), handler.deposited());
    }
}
