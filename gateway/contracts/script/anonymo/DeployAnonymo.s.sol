// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ReceiptRoots} from "../../src/anonymo/ReceiptRoots.sol";
import {DepositRouter} from "../../src/anonymo/DepositRouter.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {CreditPass} from "../../src/anonymo/CreditPass.sol";
import {FeeRouter} from "../../src/anonymo/FeeRouter.sol";
import {IStakerCredit} from "../../src/anonymo/interfaces/IAnonymo.sol";
import {MockStable, MockStableNoPermit} from "../../src/anonymo/mocks/MockStable.sol";
import {LocalSafe} from "./LocalSafe.sol";

/// @title DeployAnonymo
/// @notice Deploys the Anonymo contracts (Backend §9) to a LOCAL anvil chain only. It refuses any other chain.
///
///   anvil --port 8546 &
///   forge script script/anonymo/DeployAnonymo.s.sol --rpc-url http://127.0.0.1:8546 --broadcast
///
/// Layout (every privileged role sits behind the Safe and a 48-hour timelock, nothing is upgradeable):
///  - LocalSafe, 2 of 3 (stands in for the treasury Safe; production uses a real Safe).
///  - TimelockController, 48 hours, proposer and executor = the Safe, no admin. Owner of every contract.
///  - DepositRouter through the CREATE2 deployer with a fixed salt. Its constructor arguments (timelock, Safe,
///    deployer) are the same on every chain, so its address is too. The deployer sets the local stablecoin
///    allowlist once through `bootstrap`, after which only the timelock can change it.
///  - ReceiptRoots (signer = anvil account #4), ANMO (whole supply to the Safe), CreditPass and FeeRouter
///    (worker pool = anvil account #5, treasury = the Safe).
///  - Two local stablecoins (one with EIP-2612 permit, one without).
/// Accounts come from the anvil default mnemonic: #0 deployer, #1..#3 Safe owners, #4 signer, #5 worker pool.
/// Output: deployments/31337-anonymo-local.json (gitignored).
contract DeployAnonymo is Script {
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 public constant SAFE_SALT = keccak256("anonymo.local-safe.v1");
    bytes32 public constant TIMELOCK_SALT = keccak256("anonymo.timelock.v1");
    bytes32 public constant DEPOSIT_ROUTER_SALT = keccak256("anonymo.deposit-router.v1");
    uint256 public constant TIMELOCK_DELAY = 48 hours;
    uint256 public constant SAFE_THRESHOLD = 2;

    struct Params {
        uint256 deployerKey;
        address[3] safeOwners;
        address signer;
        address workerPool;
        uint256 microUsdPerAnmoPerDay;
        string outPath; // empty: write nothing
    }

    struct Deployment {
        address deployer;
        address safe;
        address timelock;
        address depositRouter;
        address receiptRoots;
        address anmo;
        address creditPass;
        address feeRouter;
        address usdc;
        address usdt;
    }

    function run() external returns (Deployment memory d) {
        d = deploy(localParams());
    }

    /// @notice Anvil defaults.
    function localParams() public pure returns (Params memory p) {
        p.deployerKey = vm.deriveKey(ANVIL_MNEMONIC, 0);
        for (uint32 i; i < 3; ++i) {
            p.safeOwners[i] = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, i + 1));
        }
        p.signer = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, 4));
        p.workerPool = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, 5));
        p.microUsdPerAnmoPerDay = 1_000; // 0.001 USD per staked ANMO per day
        p.outPath = "deployments/31337-anonymo-local.json";
    }

    function deploy(Params memory p) public returns (Deployment memory d) {
        require(block.chainid == LOCAL_CHAIN_ID, "DeployAnonymo: local anvil (31337) only");
        require(CREATE2_DEPLOYER.code.length != 0, "DeployAnonymo: CREATE2 deployer missing");
        d.deployer = vm.addr(p.deployerKey);

        vm.startBroadcast(p.deployerKey);

        d.safe = _create2(SAFE_SALT, safeInitCode(p.safeOwners));
        d.timelock = _create2(TIMELOCK_SALT, timelockInitCode(d.safe));
        d.depositRouter = _create2(DEPOSIT_ROUTER_SALT, depositRouterInitCode(d.timelock, d.safe, d.deployer));

        d.usdc = address(new MockStable("USD Coin (local)", "USDC"));
        d.usdt = address(new MockStableNoPermit("Tether USD (local)", "USDT"));
        address[] memory tokens = new address[](2);
        tokens[0] = d.usdc;
        tokens[1] = d.usdt;
        // On a re-run against the same chain the router already exists and was bootstrapped by the first run.
        if (DepositRouter(d.depositRouter).bootstrapper() == d.deployer) {
            DepositRouter(d.depositRouter).bootstrap(tokens);
        }

        d.receiptRoots = address(new ReceiptRoots(d.timelock, p.signer));
        d.anmo = address(new ANMO(d.safe));

        // CreditPass and FeeRouter point at each other: CreditPass takes the FeeRouter's address, known in
        // advance from the deployer's nonce.
        address predictedFeeRouter = vm.computeCreateAddress(d.deployer, vm.getNonce(d.deployer) + 1);
        d.creditPass = address(
            new CreditPass(IERC20(d.anmo), d.timelock, d.safe, predictedFeeRouter, p.microUsdPerAnmoPerDay)
        );
        d.feeRouter = address(
            new FeeRouter(IERC20(d.anmo), IStakerCredit(d.creditPass), d.timelock, p.workerPool, d.safe)
        );

        vm.stopBroadcast();

        require(d.feeRouter == predictedFeeRouter, "DeployAnonymo: FeeRouter address mismatch");
        check(d);
        if (bytes(p.outPath).length != 0) _write(p.outPath, d);
        _log(d);
    }

    /// @notice Post-deploy checks: the Safe is 2 of 3, the timelock is 48 hours and owned by nobody but
    /// itself, the Safe is its only proposer and executor, and the timelock owns every contract.
    function check(Deployment memory d) public view {
        LocalSafe safe = LocalSafe(payable(d.safe));
        require(safe.getOwners().length == 3 && safe.getThreshold() == SAFE_THRESHOLD, "check: Safe is not 2 of 3");
        TimelockController t = TimelockController(payable(d.timelock));
        require(t.getMinDelay() == TIMELOCK_DELAY, "check: timelock delay");
        require(t.hasRole(t.PROPOSER_ROLE(), d.safe) && t.hasRole(t.EXECUTOR_ROLE(), d.safe), "check: Safe roles");
        require(!t.hasRole(t.EXECUTOR_ROLE(), address(0)), "check: open executor");
        require(!t.hasRole(t.DEFAULT_ADMIN_ROLE(), d.deployer), "check: deployer is timelock admin");
        require(t.hasRole(t.DEFAULT_ADMIN_ROLE(), d.timelock), "check: timelock self-admin");
        address[4] memory owned = [d.depositRouter, d.receiptRoots, d.creditPass, d.feeRouter];
        for (uint256 i; i < owned.length; ++i) {
            require(ReceiptRoots(owned[i]).owner() == d.timelock, "check: owner is not the timelock");
        }
        require(DepositRouter(d.depositRouter).bootstrapper() == address(0), "check: bootstrap not done");
        require(DepositRouter(d.depositRouter).guardian() == d.safe, "check: router guardian");
        require(DepositRouter(d.depositRouter).treasury() == d.safe, "check: router treasury");
        require(CreditPass(d.creditPass).feeRouter() == d.feeRouter, "check: CreditPass fee router");
        require(IERC20(d.anmo).balanceOf(d.safe) == IERC20(d.anmo).totalSupply(), "check: ANMO supply");
    }

    // ------------------------------------------------------------ init code and addresses

    function safeInitCode(address[3] memory owners) public pure returns (bytes memory) {
        address[] memory o = new address[](3);
        for (uint256 i; i < 3; ++i) {
            o[i] = owners[i];
        }
        return abi.encodePacked(type(LocalSafe).creationCode, abi.encode(o, SAFE_THRESHOLD));
    }

    /// @dev Proposer, canceller and executor: the Safe only. No admin, so the timelock administers itself.
    function timelockInitCode(address safe) public pure returns (bytes memory) {
        address[] memory s = new address[](1);
        s[0] = safe;
        return abi.encodePacked(type(TimelockController).creationCode, abi.encode(TIMELOCK_DELAY, s, s, address(0)));
    }

    function depositRouterInitCode(address timelock, address safe, address deployer)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(type(DepositRouter).creationCode, abi.encode(timelock, safe, safe, deployer));
    }

    /// @notice The DepositRouter address for a given Safe and deployer. It does not depend on the chain.
    function predictDepositRouter(address safe, address deployer) public pure returns (address) {
        address timelock = _predict(TIMELOCK_SALT, timelockInitCode(safe));
        return _predict(DEPOSIT_ROUTER_SALT, depositRouterInitCode(timelock, safe, deployer));
    }

    function _predict(bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
    }

    function _create2(bytes32 salt, bytes memory initCode) internal returns (address addr) {
        addr = _predict(salt, initCode);
        if (addr.code.length != 0) return addr; // already deployed with the same code and salt
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && ret.length == 20 && address(bytes20(ret)) == addr, "DeployAnonymo: CREATE2 failed");
    }

    // ------------------------------------------------------------ output

    function _write(string memory path, Deployment memory d) internal {
        string memory k = "anonymo";
        vm.serializeString(k, "schema", "anonymo.deployments/v1");
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "safe", d.safe);
        vm.serializeAddress(k, "timelock", d.timelock);
        vm.serializeAddress(k, "depositRouter", d.depositRouter);
        vm.serializeAddress(k, "receiptRoots", d.receiptRoots);
        vm.serializeAddress(k, "anmo", d.anmo);
        vm.serializeAddress(k, "creditPass", d.creditPass);
        vm.serializeAddress(k, "feeRouter", d.feeRouter);
        vm.serializeAddress(k, "usdc", d.usdc);
        string memory json = vm.serializeAddress(k, "usdt", d.usdt);
        vm.writeJson(json, path);
    }

    function _log(Deployment memory d) internal pure {
        console2.log("Safe (2 of 3)     ", d.safe);
        console2.log("Timelock (48h)    ", d.timelock);
        console2.log("DepositRouter     ", d.depositRouter);
        console2.log("ReceiptRoots      ", d.receiptRoots);
        console2.log("ANMO              ", d.anmo);
        console2.log("CreditPass        ", d.creditPass);
        console2.log("FeeRouter         ", d.feeRouter);
        console2.log("USDC (local)      ", d.usdc);
        console2.log("USDT (local)      ", d.usdt);
    }
}
