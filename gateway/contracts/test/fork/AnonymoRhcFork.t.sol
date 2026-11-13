// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployAnonymoLive} from "../../script/anonymo/DeployAnonymoLive.s.sol";
import {DepositRouter} from "../../src/anonymo/DepositRouter.sol";
import {IDepositRouter, ICoinPay} from "../../src/anonymo/interfaces/IAnonymo.sol";
import {ReceiptRoots} from "../../src/anonymo/ReceiptRoots.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address paymentReceiver
    ) external;
}

/// @notice M9: every rollout stage of the live deploy script against a Robinhood Chain (4663) mainnet fork, with a
/// real Safe v1.4.1 (2 of 3, from the canonical factory) as the treasury and real USDG as the deposit token.
/// Nothing is broadcast. Run with:
///   RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/fork/*'
/// Skipped when RHC_RPC_URL is unset (CI excludes test/fork/).
contract AnonymoRhcForkTest is Test {
    // config/rhc-mainnet.json
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    uint256 constant RHC = 4663;

    DeployAnonymoLive script;
    address deployer = makeAddr("deployer");
    address safe;
    address[] stables;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == RHC, "fork: RHC_RPC_URL is not Robinhood Chain mainnet");
        script = new DeployAnonymoLive();

        address[] memory owners = new address[](3);
        owners[0] = makeAddr("owner0");
        owners[1] = makeAddr("owner1");
        owners[2] = makeAddr("owner2");
        bytes memory init = abi.encodeCall(
            ISafeSetup.setup, (owners, 2, address(0), "", address(0), address(0), 0, address(0))
        );
        safe = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_SINGLETON, init, uint256(keccak256("anonymo.fork")));
        stables.push(USDG);
    }

    function _params(DeployAnonymoLive.Stage stage) internal returns (DeployAnonymoLive.Params memory p) {
        p.stage = stage;
        p.safe = safe;
        p.deployer = deployer;
        p.stables = stables;
        p.receiptSigner = makeAddr("anchorer");
    }

    function test_fork_allStagesAndAUsdgDeposit() public {
        DeployAnonymoLive.Deployment memory d = script.deploy(_params(DeployAnonymoLive.Stage.Router));
        script.checkRouter(d, stables);

        // A real USDG deposit is forwarded to the Safe and emits Deposited(keyCommit, token, received).
        address user = makeAddr("user");
        deal(USDG, user, 25e6);
        uint256 before = IERC20(USDG).balanceOf(safe);
        bytes32 keyCommit = keccak256("fork-key");
        vm.startPrank(user);
        IERC20(USDG).approve(d.depositRouter, 25e6);
        vm.expectEmit(true, true, true, true, d.depositRouter);
        emit IDepositRouter.Deposited(keyCommit, USDG, user, 25e6);
        DepositRouter(d.depositRouter).deposit(USDG, 25e6, keyCommit);
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(safe) - before, 25e6);
        assertEq(IERC20(USDG).balanceOf(d.depositRouter), 0);

        DeployAnonymoLive.Deployment memory r = script.deploy(_params(DeployAnonymoLive.Stage.Receipts));
        vm.prank(makeAddr("anchorer"));
        ReceiptRoots(r.receiptRoots).post(uint64(block.timestamp / 3600), keccak256("root"));
        assertEq(ReceiptRoots(r.receiptRoots).rootOf(uint64(block.timestamp / 3600)), keccak256("root"));

        DeployAnonymoLive.Deployment memory t = script.deploy(_params(DeployAnonymoLive.Stage.Token));
        script.checkToken(t);

        // Paying with the coin burns it: supply and the payer's balance drop, and Paid names the key and payer.
        vm.prank(safe);
        IERC20(t.anmo).transfer(user, 1_000e18);
        uint256 supply = IERC20(t.anmo).totalSupply();
        vm.startPrank(user);
        IERC20(t.anmo).approve(t.coinPay, 400e18);
        vm.expectEmit(true, true, false, true, t.coinPay);
        emit ICoinPay.Paid(keyCommit, user, 400e18);
        ICoinPay(t.coinPay).pay(400e18, keyCommit);
        vm.stopPrank();
        assertEq(IERC20(t.anmo).totalSupply(), supply - 400e18);
        assertEq(IERC20(t.anmo).balanceOf(user), 600e18);
    }
}
