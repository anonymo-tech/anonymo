// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {AnonymoTimelock} from "../../src/anonymo/AnonymoTimelock.sol";

import {ReceiptRoots} from "../../src/anonymo/ReceiptRoots.sol";
import {DepositRouter} from "../../src/anonymo/DepositRouter.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {CoinPay} from "../../src/anonymo/CoinPay.sol";

/// The parts of a Safe (v1.3 or v1.4.1) the checks read.
interface ISafeView {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

/// @title DeployAnonymoLive
/// @notice Deploys the Anonymo contracts (Backend §9) to a real chain (testnet or mainnet), one rollout stage
/// at a time. It refuses the local anvil chain; use DeployAnonymo.s.sol there.
///
/// Stages (ANONYMO_STAGE), matching HANDOFF.md §4:
///   router   (A0)  48-hour TimelockController + DepositRouter, both through the CREATE2 deployer, then the
///                  one-time stablecoin allowlist. Same Safe + same deployer on every chain = same addresses.
///   receipts (A3)  ReceiptRoots(timelock, signer).
///   token          ANMO (whole supply to the Safe) and CoinPay, which burns every coin paid for usage. Staking
///                  (CreditPass, FeeRouter) is not part of the launch and is not deployed here.
///
/// Inputs (environment; nothing secret, the deployer key never enters the environment):
///   ANONYMO_STAGE        router | receipts | token
///   ANONYMO_SAFE         the treasury Safe on this chain: exactly 2 of 3, no modules, no guard. Create it in the Safe
///                        app first, with the same owners and salt on every chain so its address matches.
///   ANONYMO_SAFE_OWNERS  optional: the three owner addresses, comma-separated; the Safe must have exactly these.
///   ANONYMO_DEPLOYER     the address that signs (a hardware wallet or an encrypted keystore account). Use the same
///                        one on every chain: it is part of the DepositRouter's CREATE2 init code.
///   router:   ANONYMO_STABLES          comma-separated stablecoin addresses for this chain
///   receipts: ANONYMO_RECEIPT_SIGNER   the hot key that posts hourly roots (ANCHORER_PRIVATE_KEY's address)
///
/// Dry run (simulates against the live chain, sends nothing):
///   forge script script/anonymo/DeployAnonymoLive.s.sol --rpc-url $RPC --ledger --sender $ANONYMO_DEPLOYER
/// Broadcast: add --broadcast (and --verify with an explorer key). Output: deployments/<chainId>-anonymo-<stage>.json
/// on a broadcast, deployments/<chainId>-anonymo-<stage>.dryrun.json on a dry run. The manifest has no block number on
/// purpose: on Arbitrum-family chains (Robinhood Chain, Arbitrum One) `block.number` is the L1 block, not the chain's
/// own. Take the gateway's `startBlock` from the broadcast receipts (broadcast/DeployAnonymoLive.s.sol/<chainId>/
/// run-latest.json, `blockNumber`) or an explorer. so a dry run never replaces the
/// record of a real deployment. The receipts and token stages refuse to deploy a second set once a broadcast record
/// exists, unless ANONYMO_ALLOW_REDEPLOY=1.
contract DeployAnonymoLive is Script {
    uint256 internal constant LOCAL_CHAIN_ID = 31337;
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    // The same salts as DeployAnonymo.s.sol, so the local and live layouts match.
    bytes32 public constant TIMELOCK_SALT = keccak256("anonymo.timelock.v1");
    bytes32 public constant DEPOSIT_ROUTER_SALT = keccak256("anonymo.deposit-router.v1");
    uint256 public constant TIMELOCK_DELAY = 48 hours;
    uint256 public constant SAFE_THRESHOLD = 2;
    uint256 public constant SAFE_OWNERS = 3;
    address internal constant SAFE_SENTINEL = address(0x1);
    /// keccak256("guard_manager.guard.address"), the Safe's transaction guard slot.
    uint256 internal constant SAFE_GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

    enum Stage {
        Router,
        Receipts,
        Token
    }

    struct Params {
        Stage stage;
        address safe;
        address[] safeOwners; // optional: the exact owner set
        address deployer;
        address[] stables;
        address receiptSigner;
        bool write;
        bool allowRedeploy;
    }

    struct Deployment {
        address safe;
        address timelock;
        address depositRouter;
        address receiptRoots;
        address anmo;
        address coinPay;
    }

    function run() external returns (Deployment memory d) {
        d = deploy(envParams());
    }

    function envParams() public view returns (Params memory p) {
        p.stage = parseStage(vm.envString("ANONYMO_STAGE"));
        p.safe = vm.envAddress("ANONYMO_SAFE");
        p.safeOwners = vm.envOr("ANONYMO_SAFE_OWNERS", ",", new address[](0));
        p.deployer = vm.envAddress("ANONYMO_DEPLOYER");
        if (p.stage == Stage.Router) p.stables = vm.envAddress("ANONYMO_STABLES", ",");
        if (p.stage == Stage.Receipts) p.receiptSigner = vm.envAddress("ANONYMO_RECEIPT_SIGNER");
        p.write = true;
        p.allowRedeploy = vm.envOr("ANONYMO_ALLOW_REDEPLOY", false);
    }

    function parseStage(string memory s) public pure returns (Stage) {
        bytes32 h = keccak256(bytes(s));
        if (h == keccak256("router")) return Stage.Router;
        if (h == keccak256("receipts")) return Stage.Receipts;
        if (h == keccak256("token")) return Stage.Token;
        revert("DeployAnonymoLive: ANONYMO_STAGE must be router, receipts or token");
    }

    function deploy(Params memory p) public returns (Deployment memory d) {
        require(block.chainid != LOCAL_CHAIN_ID, "DeployAnonymoLive: use DeployAnonymo.s.sol on anvil");
        require(CREATE2_DEPLOYER.code.length != 0, "DeployAnonymoLive: CREATE2 deployer missing on this chain");
        require(p.deployer != address(0), "DeployAnonymoLive: deployer");
        checkSafe(p.safe, p.safeOwners);
        if (p.write && p.stage != Stage.Router && !p.allowRedeploy && _broadcasting()) {
            require(!vm.exists(manifestPath(p.stage, true)), "DeployAnonymoLive: this stage is already deployed on this chain");
        }

        d.safe = p.safe;
        d.timelock = predictTimelock(p.safe);
        d.depositRouter = predictDepositRouter(p.safe, p.deployer);

        if (p.stage == Stage.Router) {
            require(p.stables.length != 0, "DeployAnonymoLive: ANONYMO_STABLES is empty");
            for (uint256 i; i < p.stables.length; ++i) {
                require(p.stables[i].code.length != 0, "DeployAnonymoLive: stablecoin has no code on this chain");
                IERC20(p.stables[i]).totalSupply(); // reverts on a non-token
            }
            vm.startBroadcast(p.deployer);
            _create2(TIMELOCK_SALT, timelockInitCode(p.safe));
            _create2(DEPOSIT_ROUTER_SALT, depositRouterInitCode(d.timelock, p.safe, p.deployer));
            // On a re-run the router already exists and was bootstrapped by the first run.
            if (DepositRouter(d.depositRouter).bootstrapper() == p.deployer) {
                DepositRouter(d.depositRouter).bootstrap(p.stables);
            }
            vm.stopBroadcast();
            checkRouter(d, p.stables);
        } else {
            // Later stages hang off the router stage's timelock.
            require(d.timelock.code.length != 0, "DeployAnonymoLive: run the router stage on this chain first");
            checkTimelock(d.timelock, p.safe);
            if (p.stage == Stage.Receipts) {
                require(p.receiptSigner != address(0), "DeployAnonymoLive: ANONYMO_RECEIPT_SIGNER");
                require(p.receiptSigner != p.safe && p.receiptSigner != p.deployer, "DeployAnonymoLive: signer must be its own hot key");
                vm.startBroadcast(p.deployer);
                d.receiptRoots = address(new ReceiptRoots(d.timelock, p.receiptSigner));
                vm.stopBroadcast();
                require(ReceiptRoots(d.receiptRoots).owner() == d.timelock, "check: ReceiptRoots owner");
                require(ReceiptRoots(d.receiptRoots).signer() == p.receiptSigner, "check: ReceiptRoots signer");
            } else {
                vm.startBroadcast(p.deployer);
                d.anmo = address(new ANMO(p.safe));
                d.coinPay = address(new CoinPay(d.anmo));
                vm.stopBroadcast();
                checkToken(d);
            }
        }

        if (p.write) _write(p.stage, d);
        _log(p.stage, d);
    }

    // ------------------------------------------------------------ checks

    /// @notice The treasury must be exactly 2 of 3 (and, when given, these three owners), with no module that could
    /// execute outside the owner threshold and no transaction guard that could block the owners.
    function checkSafe(address safe, address[] memory expectedOwners) public view {
        require(safe.code.length != 0, "check: ANONYMO_SAFE has no code on this chain");
        ISafeView s = ISafeView(safe);
        address[] memory owners = s.getOwners();
        require(owners.length == SAFE_OWNERS, "check: Safe must have exactly 3 owners");
        require(s.getThreshold() == SAFE_THRESHOLD, "check: Safe threshold must be 2");
        if (expectedOwners.length != 0) {
            require(expectedOwners.length == SAFE_OWNERS, "check: ANONYMO_SAFE_OWNERS must list 3 addresses");
            for (uint256 i; i < expectedOwners.length; ++i) {
                bool found;
                for (uint256 j; j < owners.length; ++j) {
                    if (owners[j] == expectedOwners[i]) found = true;
                }
                require(found, "check: Safe owners differ from ANONYMO_SAFE_OWNERS");
            }
        }
        (address[] memory modules,) = s.getModulesPaginated(SAFE_SENTINEL, 1);
        require(modules.length == 0, "check: Safe has a module enabled");
        bytes memory guard = s.getStorageAt(SAFE_GUARD_SLOT, 1);
        require(guard.length == 32 && abi.decode(guard, (uint256)) == 0, "check: Safe has a transaction guard");
    }

    /// @notice 48 hours, the Safe is the only proposer, executor and canceller, and the timelock is its only admin.
    /// Exact, through AnonymoTimelock's role member counts, so it also holds for a timelock reused from an earlier run.
    function checkTimelock(address timelock, address safe) public view {
        AnonymoTimelock t = AnonymoTimelock(payable(timelock));
        require(t.getMinDelay() == TIMELOCK_DELAY, "check: timelock delay");
        bytes32[4] memory roles = [t.DEFAULT_ADMIN_ROLE(), t.PROPOSER_ROLE(), t.EXECUTOR_ROLE(), t.CANCELLER_ROLE()];
        for (uint256 i; i < roles.length; ++i) {
            require(t.roleMemberCount(roles[i]) == 1, "check: timelock role has extra members");
        }
        require(t.hasRole(t.DEFAULT_ADMIN_ROLE(), timelock), "check: timelock self-admin");
        require(
            t.hasRole(t.PROPOSER_ROLE(), safe) && t.hasRole(t.EXECUTOR_ROLE(), safe) && t.hasRole(t.CANCELLER_ROLE(), safe),
            "check: Safe roles"
        );
    }

    function checkRouter(Deployment memory d, address[] memory stables) public view {
        checkTimelock(d.timelock, d.safe);
        DepositRouter r = DepositRouter(d.depositRouter);
        require(r.owner() == d.timelock, "check: router owner");
        require(r.bootstrapper() == address(0), "check: bootstrap not done");
        require(r.guardian() == d.safe, "check: router guardian");
        require(r.treasury() == d.safe, "check: router treasury");
        for (uint256 i; i < stables.length; ++i) {
            require(r.isAllowed(stables[i]), "check: stablecoin not allowed");
        }
    }

    function checkToken(Deployment memory d) public view {
        require(IERC20(d.anmo).balanceOf(d.safe) == IERC20(d.anmo).totalSupply(), "check: ANMO supply");
        require(address(CoinPay(d.coinPay).coin()) == d.anmo, "check: CoinPay coin");
    }

    // ------------------------------------------------------------ init code and addresses

    /// @dev Proposer, canceller and executor: the Safe only. No admin, so the timelock administers itself.
    function timelockInitCode(address safe) public pure returns (bytes memory) {
        address[] memory s = new address[](1);
        s[0] = safe;
        return abi.encodePacked(type(AnonymoTimelock).creationCode, abi.encode(TIMELOCK_DELAY, s, s, address(0)));
    }

    function depositRouterInitCode(address timelock, address safe, address deployer)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(type(DepositRouter).creationCode, abi.encode(timelock, safe, safe, deployer));
    }

    function predictTimelock(address safe) public pure returns (address) {
        return _predict(TIMELOCK_SALT, timelockInitCode(safe));
    }

    /// @notice The DepositRouter address for a given Safe and deployer. It does not depend on the chain.
    function predictDepositRouter(address safe, address deployer) public pure returns (address) {
        return _predict(DEPOSIT_ROUTER_SALT, depositRouterInitCode(predictTimelock(safe), safe, deployer));
    }

    function _predict(bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
    }

    function _create2(bytes32 salt, bytes memory initCode) internal returns (address addr) {
        addr = _predict(salt, initCode);
        if (addr.code.length != 0) return addr; // already deployed with the same code and salt
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && ret.length == 20 && address(bytes20(ret)) == addr, "DeployAnonymoLive: CREATE2 failed");
    }

    // ------------------------------------------------------------ output

    function stageName(Stage s) public pure returns (string memory) {
        if (s == Stage.Router) return "router";
        if (s == Stage.Receipts) return "receipts";
        return "token";
    }

    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    function manifestPath(Stage stage, bool broadcast) public view returns (string memory) {
        return string.concat(
            "deployments/",
            vm.toString(block.chainid),
            "-anonymo-",
            stageName(stage),
            broadcast ? ".json" : ".dryrun.json"
        );
    }

    function _write(Stage stage, Deployment memory d) internal {
        string memory k = "anonymo-live";
        vm.serializeString(k, "schema", "anonymo.deployments/v1");
        vm.serializeString(k, "stage", stageName(stage));
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "safe", d.safe);
        vm.serializeAddress(k, "timelock", d.timelock);
        string memory json = vm.serializeAddress(k, "depositRouter", d.depositRouter);
        if (stage == Stage.Receipts) json = vm.serializeAddress(k, "receiptRoots", d.receiptRoots);
        if (stage == Stage.Token) {
            vm.serializeAddress(k, "anmo", d.anmo);
            json = vm.serializeAddress(k, "coinPay", d.coinPay);
        }
        vm.writeJson(json, manifestPath(stage, _broadcasting()));
    }

    function _log(Stage stage, Deployment memory d) internal pure {
        console2.log("Stage             ", stageName(stage));
        console2.log("Safe              ", d.safe);
        console2.log("Timelock (48h)    ", d.timelock);
        console2.log("DepositRouter     ", d.depositRouter);
        if (stage == Stage.Receipts) console2.log("ReceiptRoots      ", d.receiptRoots);
        if (stage == Stage.Token) {
            console2.log("ANMO              ", d.anmo);
            console2.log("CoinPay           ", d.coinPay);
        }
    }
}
