// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {DeployAnonymo} from "../../script/anonymo/DeployAnonymo.s.sol";
import {DeployAnonymoLive} from "../../script/anonymo/DeployAnonymoLive.s.sol";
import {LocalSafe} from "../../script/anonymo/LocalSafe.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {AnonymoTimelock} from "../../src/anonymo/AnonymoTimelock.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {DepositRouter} from "../../src/anonymo/DepositRouter.sol";
import {ReceiptRoots} from "../../src/anonymo/ReceiptRoots.sol";
import {MockStable, MockStableNoPermit} from "../../src/anonymo/mocks/MockStable.sol";

/// Runs the live deploy script on a non-anvil chain id, with LocalSafe standing in for a real Safe (same getters).
/// The Robinhood Chain fork test (test/fork/) runs it against a real Safe and real USDG.
contract DeployAnonymoLiveTest is Test {
    DeployAnonymoLive script;
    address deployer = makeAddr("deployer");
    address safe;
    address[] stables;
    address coin;

    function setUp() public {
        vm.chainId(8453);
        script = new DeployAnonymoLive();
        safe = _safe(3, 2);
        stables.push(address(new MockStable("USD Coin", "USDC")));
        stables.push(address(new MockStableNoPermit("Tether USD", "USDT")));
        coin = address(new ANMO(address(this))); // stands in for the Pons-launched coin
    }

    function _safe(uint256 owners, uint256 threshold) internal returns (address) {
        address[] memory o = new address[](owners);
        for (uint256 i; i < owners; ++i) {
            o[i] = makeAddr(string.concat("owner", vm.toString(i)));
        }
        return address(new LocalSafe(o, threshold));
    }

    function _params(DeployAnonymoLive.Stage stage) internal returns (DeployAnonymoLive.Params memory p) {
        p.stage = stage;
        p.safe = safe;
        p.deployer = deployer;
        p.stables = stables;
        p.receiptSigner = makeAddr("anchorer");
        p.coin = coin;
    }

    function test_routerStage() public {
        DeployAnonymoLive.Deployment memory d = script.deploy(_params(DeployAnonymoLive.Stage.Router));
        script.checkRouter(d, stables);
        assertEq(d.depositRouter, script.predictDepositRouter(safe, deployer));
        assertEq(d.timelock, script.predictTimelock(safe));

        // A deposit lands in the Safe.
        address user = makeAddr("user");
        MockStable(stables[0]).mint(user, 5e6);
        vm.startPrank(user);
        IERC20(stables[0]).approve(d.depositRouter, 5e6);
        DepositRouter(d.depositRouter).deposit(stables[0], 5e6, keccak256("key"));
        vm.stopPrank();
        assertEq(IERC20(stables[0]).balanceOf(safe), 5e6);
    }

    function test_sameLayoutAsLocalScript() public {
        DeployAnonymo local = new DeployAnonymo();
        assertEq(local.TIMELOCK_SALT(), script.TIMELOCK_SALT());
        assertEq(local.DEPOSIT_ROUTER_SALT(), script.DEPOSIT_ROUTER_SALT());
        assertEq(local.predictDepositRouter(safe, deployer), script.predictDepositRouter(safe, deployer));
    }

    function test_rerunIsIdempotent() public {
        DeployAnonymoLive.Deployment memory a = script.deploy(_params(DeployAnonymoLive.Stage.Router));
        DeployAnonymoLive.Deployment memory b = script.deploy(_params(DeployAnonymoLive.Stage.Router));
        assertEq(a.depositRouter, b.depositRouter);
        assertEq(a.timelock, b.timelock);
    }

    function test_laterStages() public {
        script.deploy(_params(DeployAnonymoLive.Stage.Router));
        DeployAnonymoLive.Deployment memory r = script.deploy(_params(DeployAnonymoLive.Stage.Receipts));
        assertEq(ReceiptRoots(r.receiptRoots).signer(), makeAddr("anchorer"));
        assertEq(ReceiptRoots(r.receiptRoots).owner(), r.timelock);
        DeployAnonymoLive.Deployment memory t = script.deploy(_params(DeployAnonymoLive.Stage.Coin));
        script.checkToken(t);
        assertEq(t.coin, coin);
    }

    function test_coinStageNeedsARealToken() public {
        script.deploy(_params(DeployAnonymoLive.Stage.Router));
        DeployAnonymoLive.Params memory p = _params(DeployAnonymoLive.Stage.Coin);
        p.coin = makeAddr("not-a-token");
        vm.expectRevert(bytes("DeployAnonymoLive: ANONYMO_COIN_TOKEN has no code on this chain"));
        script.deploy(p);
    }

    function test_laterStagesNeedTheRouterStage() public {
        vm.expectRevert(bytes("DeployAnonymoLive: run the router stage on this chain first"));
        script.deploy(_params(DeployAnonymoLive.Stage.Receipts));
    }

    function test_refusesAnvil() public {
        vm.chainId(31337);
        vm.expectRevert(bytes("DeployAnonymoLive: use DeployAnonymo.s.sol on anvil"));
        script.deploy(_params(DeployAnonymoLive.Stage.Router));
    }

    function test_refusesWeakOrMissingSafe() public {
        DeployAnonymoLive.Params memory p = _params(DeployAnonymoLive.Stage.Router);
        p.safe = makeAddr("eoa");
        vm.expectRevert(bytes("check: ANONYMO_SAFE has no code on this chain"));
        script.deploy(p);

        p.safe = _safe(3, 1);
        vm.expectRevert(bytes("check: Safe threshold must be 2"));
        script.deploy(p);

        p.safe = _safe(2, 2);
        vm.expectRevert(bytes("check: Safe must have exactly 3 owners"));
        script.deploy(p);

        p.safe = _safe(4, 2);
        vm.expectRevert(bytes("check: Safe must have exactly 3 owners"));
        script.deploy(p);

        p.safe = _safe(3, 3);
        vm.expectRevert(bytes("check: Safe threshold must be 2"));
        script.deploy(p);
    }

    function test_expectedSafeOwners() public {
        DeployAnonymoLive.Params memory p = _params(DeployAnonymoLive.Stage.Router);
        p.safeOwners = new address[](3);
        for (uint256 i; i < 3; ++i) {
            p.safeOwners[i] = makeAddr(string.concat("owner", vm.toString(i)));
        }
        script.deploy(p); // the right three, in any order
        p.safeOwners[2] = makeAddr("stranger");
        vm.expectRevert(bytes("check: Safe owners differ from ANONYMO_SAFE_OWNERS"));
        script.deploy(p);
    }

    function test_timelockHasAFloorAndExactRoles() public {
        DeployAnonymoLive.Deployment memory d = script.deploy(_params(DeployAnonymoLive.Stage.Router));
        AnonymoTimelock t = AnonymoTimelock(payable(d.timelock));
        assertEq(t.roleMemberCount(t.PROPOSER_ROLE()), 1);
        assertEq(t.roleMemberCount(t.DEFAULT_ADMIN_ROLE()), 1);

        // The audit's L-02 sequence: lowering the delay is refused outright, so no change can skip the 48 hours.
        bytes memory lower = abi.encodeCall(TimelockController.updateDelay, (0));
        vm.prank(safe);
        t.schedule(address(t), 0, lower, bytes32(0), bytes32(uint256(1)), 48 hours);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(safe);
        vm.expectRevert(); // the inner DelayBelowFloor surfaces as a failed call
        t.execute(address(t), 0, lower, bytes32(0), bytes32(uint256(1)));
        assertEq(t.getMinDelay(), 48 hours);

        // L-03: an extra role member, even granted through the timelock itself, fails the check.
        bytes memory grant = abi.encodeCall(t.grantRole, (t.PROPOSER_ROLE(), makeAddr("extra")));
        vm.prank(safe);
        t.schedule(address(t), 0, grant, bytes32(0), bytes32(uint256(2)), 48 hours);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(safe);
        t.execute(address(t), 0, grant, bytes32(0), bytes32(uint256(2)));
        assertEq(t.roleMemberCount(t.PROPOSER_ROLE()), 2);
        vm.expectRevert(bytes("check: timelock role has extra members"));
        script.checkTimelock(d.timelock, safe);
    }

    function test_timelockConstructorFloor() public {
        address[] memory s = new address[](1);
        s[0] = safe;
        vm.expectRevert(abi.encodeWithSelector(AnonymoTimelock.DelayBelowFloor.selector, 48 hours - 1));
        new AnonymoTimelock(48 hours - 1, s, s, address(0));
    }

    function test_refusesBadStablecoins() public {
        DeployAnonymoLive.Params memory p = _params(DeployAnonymoLive.Stage.Router);
        p.stables = new address[](0);
        vm.expectRevert(bytes("DeployAnonymoLive: ANONYMO_STABLES is empty"));
        script.deploy(p);

        p.stables = new address[](1);
        p.stables[0] = makeAddr("not-a-token");
        vm.expectRevert(bytes("DeployAnonymoLive: stablecoin has no code on this chain"));
        script.deploy(p);
    }

    function test_receiptSignerMustBeItsOwnKey() public {
        script.deploy(_params(DeployAnonymoLive.Stage.Router));
        DeployAnonymoLive.Params memory p = _params(DeployAnonymoLive.Stage.Receipts);
        p.receiptSigner = deployer;
        vm.expectRevert(bytes("DeployAnonymoLive: signer must be its own hot key"));
        script.deploy(p);
    }

    function test_guardianPauses() public {
        DeployAnonymoLive.Deployment memory d = script.deploy(_params(DeployAnonymoLive.Stage.Router));
        vm.prank(safe);
        DepositRouter(d.depositRouter).pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        DepositRouter(d.depositRouter).deposit(stables[0], 1, keccak256("key"));
    }

    function test_parseStage() public view {
        assertEq(uint8(script.parseStage("router")), uint8(DeployAnonymoLive.Stage.Router));
        assertEq(uint8(script.parseStage("receipts")), uint8(DeployAnonymoLive.Stage.Receipts));
        assertEq(uint8(script.parseStage("coin")), uint8(DeployAnonymoLive.Stage.Coin));
    }
}
