// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {DeployAnonymo} from "../../script/anonymo/DeployAnonymo.s.sol";
import {LocalSafe} from "../../script/anonymo/LocalSafe.sol";
import {ReceiptRoots} from "../../src/anonymo/ReceiptRoots.sol";
import {DepositRouter} from "../../src/anonymo/DepositRouter.sol";
import {MockStable} from "../../src/anonymo/mocks/MockStable.sol";

contract DeployAnonymoTest is Test {
    string constant MNEMONIC = "test test test test test test test test test test test junk";

    DeployAnonymo script;
    DeployAnonymo.Deployment d;
    uint256[3] ownerKeys;

    function setUp() public {
        script = new DeployAnonymo();
        DeployAnonymo.Params memory p = script.localParams();
        p.outPath = "";
        d = script.deploy(p);
        for (uint32 i; i < 3; ++i) {
            ownerKeys[i] = vm.deriveKey(MNEMONIC, i + 1);
        }
    }

    function test_layout() public view {
        script.check(d);
        assertEq(TimelockController(payable(d.timelock)).getMinDelay(), 48 hours);
        assertEq(LocalSafe(payable(d.safe)).getThreshold(), 2);
        assertEq(LocalSafe(payable(d.safe)).getOwners().length, 3);
        assertEq(d.depositRouter, script.predictDepositRouter(d.safe, d.deployer));
        assertTrue(DepositRouter(d.depositRouter).isAllowed(d.usdc));
        assertTrue(DepositRouter(d.depositRouter).isAllowed(d.usdt));
    }

    function test_refusesNonLocalChains() public {
        uint256[4] memory chains = [uint256(1), 8453, 42161, 4663];
        for (uint256 i; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            DeployAnonymo fresh = new DeployAnonymo();
            DeployAnonymo.Params memory p = fresh.localParams();
            vm.expectRevert(bytes("DeployAnonymo: local anvil (31337) only"));
            fresh.deploy(p);
        }
    }

    function test_rerunIsIdempotentForCreate2Contracts() public {
        DeployAnonymo again = new DeployAnonymo();
        DeployAnonymo.Params memory p = again.localParams();
        p.outPath = "";
        DeployAnonymo.Deployment memory d2 = again.deploy(p);
        assertEq(d2.safe, d.safe);
        assertEq(d2.timelock, d.timelock);
        assertEq(d2.depositRouter, d.depositRouter);
    }

    function test_depositEndToEnd() public {
        address user = makeAddr("user");
        MockStable(d.usdc).mint(user, 10e6);
        vm.startPrank(user);
        IERC20(d.usdc).approve(d.depositRouter, 10e6);
        DepositRouter(d.depositRouter).deposit(d.usdc, 10e6, keccak256("key"));
        vm.stopPrank();
        assertEq(IERC20(d.usdc).balanceOf(d.safe), 10e6);
    }

    // ------------------------------------------------------------ Safe (2 of 3) -> timelock (48 h)

    function _sigs(address to, bytes memory data, uint256 a, uint256 b) internal view returns (bytes memory) {
        LocalSafe safe = LocalSafe(payable(d.safe));
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(safe.txHash(to, 0, data, safe.nonce()));
        (uint256 k1, uint256 k2) = vm.addr(ownerKeys[a]) < vm.addr(ownerKeys[b])
            ? (ownerKeys[a], ownerKeys[b])
            : (ownerKeys[b], ownerKeys[a]);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(k1, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(k2, digest);
        return abi.encodePacked(r1, s1, v1, r2, s2, v2);
    }

    function test_signerChange_safeTwoOfThreeThenTimelock() public {
        address next = makeAddr("next-signer");
        bytes memory call = abi.encodeCall(ReceiptRoots.setSigner, (next));
        TimelockController t = TimelockController(payable(d.timelock));
        bytes memory schedule = abi.encodeCall(t.schedule, (d.receiptRoots, 0, call, bytes32(0), bytes32(0), 48 hours));
        bytes memory execute = abi.encodeCall(t.execute, (d.receiptRoots, 0, call, bytes32(0), bytes32(0)));

        LocalSafe safe = LocalSafe(payable(d.safe));
        // One signature is not enough.
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(safe.txHash(d.timelock, 0, schedule, safe.nonce()));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKeys[0], digest);
        vm.expectRevert(LocalSafe.NotEnoughSignatures.selector);
        safe.exec(d.timelock, 0, schedule, abi.encodePacked(r, s, v));

        safe.exec(d.timelock, 0, schedule, _sigs(d.timelock, schedule, 0, 2));

        // Not before 48 hours.
        vm.warp(block.timestamp + 48 hours - 1);
        bytes memory early = _sigs(d.timelock, execute, 1, 2);
        vm.expectRevert();
        safe.exec(d.timelock, 0, execute, early);

        vm.warp(block.timestamp + 1);
        safe.exec(d.timelock, 0, execute, _sigs(d.timelock, execute, 1, 2));
        assertEq(ReceiptRoots(d.receiptRoots).signer(), next);
    }

    /// The deployer keeps no power: it cannot schedule on the timelock or call any owner function.
    function test_deployerHasNoPower() public {
        TimelockController t = TimelockController(payable(d.timelock));
        vm.startPrank(d.deployer);
        vm.expectRevert();
        t.schedule(d.receiptRoots, 0, "", bytes32(0), bytes32(0), 48 hours);
        vm.expectRevert();
        ReceiptRoots(d.receiptRoots).setSigner(d.deployer);
        address[] memory tokens = new address[](0);
        vm.expectRevert(DepositRouter.NotBootstrapper.selector);
        DepositRouter(d.depositRouter).bootstrap(tokens);
        vm.stopPrank();
    }
}
