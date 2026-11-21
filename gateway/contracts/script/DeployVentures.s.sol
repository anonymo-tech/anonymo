// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AnonymoTimelock} from "../src/anonymo/AnonymoTimelock.sol";
import {CrewTiers} from "../src/ventures/CrewTiers.sol";
import {BuildFuel} from "../src/ventures/BuildFuel.sol";
import {Checkout} from "../src/ventures/Checkout.sol";
import {VenturesFeeRouter} from "../src/ventures/VenturesFeeRouter.sol";
import {RecipeRegistry} from "../src/ventures/RecipeRegistry.sol";
import {ForkFund} from "../src/ventures/ForkFund.sol";
import {VoteRegistry} from "../src/ventures/VoteRegistry.sol";
import {VenturesGuarded} from "../src/ventures/VenturesOwned.sol";
import {ICrewTiers, IPriceOracle, IVenturesFeeRouter} from "../src/ventures/interfaces/IVentures.sol";

/// The parts of a Safe the checks read.
interface IVenturesSafeView {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

/// @title DeployVentures
/// @notice Deploys the Ventures contracts (CrewTiers, BuildFuel, Checkout, VenturesFeeRouter, RecipeRegistry,
/// ForkFund, VoteRegistry), every one owned by a 7-day timelock whose only proposer, canceller and executor is
/// a 3-of-5 Safe (also the pause guardian). Nothing is upgradeable. NYMO is this repo's ANMO token.
///
/// Inputs (environment; addresses only, no keys - sign with --ledger or an encrypted keystore):
///   VENTURES_SAFE            the 3-of-5 Safe
///   VENTURES_DEPLOYER        the signing address (keeps no role)
///   VENTURES_TIMELOCK        optional: an existing AnonymoTimelock (>= 7 days, Safe-only roles); unset = deploy one
///   VENTURES_NYMO            the NYMO token (ANMO)
///   VENTURES_USDG            USDG (EIP-3009)
///   VENTURES_ORACLE          IPriceOracle for NYMO in USDG
///   VENTURES_GATEWAY_SIGNER  the gateway hot key: records recipe runs, fulfils forks
///   VENTURES_WORKERS, VENTURES_TREASURY, VENTURES_STAKER_CREDITS, VENTURES_BUY_BURN   the fee router's payees
///   VENTURES_FUEL_RATE       optional: build credits a day per NYMO, 18 decimals (default 1e18)
///
/// Dry run only (simulates, sends nothing):
///   forge script script/DeployVentures.s.sol --rpc-url $RPC --ledger --sender $VENTURES_DEPLOYER
contract DeployVentures is Script {
    uint256 public constant TIMELOCK_DELAY = 7 days;
    uint256 public constant SAFE_OWNERS = 5;
    uint256 public constant SAFE_THRESHOLD = 3;

    struct Params {
        address safe;
        address deployer;
        address timelock; // 0 = deploy a new one
        address nymo;
        address usdg;
        address oracle;
        address signer;
        address workers;
        address treasury;
        address stakerCredits;
        address buyBurn;
        uint256 fuelRate;
    }

    struct Deployment {
        address safe;
        address timelock;
        address feeRouter;
        address crewTiers;
        address buildFuel;
        address checkout;
        address recipeRegistry;
        address forkFund;
        address voteRegistry;
    }

    function run() external returns (Deployment memory d) {
        d = deploy(envParams());
    }

    function envParams() public view returns (Params memory p) {
        p.safe = vm.envAddress("VENTURES_SAFE");
        p.deployer = vm.envAddress("VENTURES_DEPLOYER");
        p.timelock = vm.envOr("VENTURES_TIMELOCK", address(0));
        p.nymo = vm.envAddress("VENTURES_NYMO");
        p.usdg = vm.envAddress("VENTURES_USDG");
        p.oracle = vm.envAddress("VENTURES_ORACLE");
        p.signer = vm.envAddress("VENTURES_GATEWAY_SIGNER");
        p.workers = vm.envAddress("VENTURES_WORKERS");
        p.treasury = vm.envAddress("VENTURES_TREASURY");
        p.stakerCredits = vm.envAddress("VENTURES_STAKER_CREDITS");
        p.buyBurn = vm.envAddress("VENTURES_BUY_BURN");
        p.fuelRate = vm.envOr("VENTURES_FUEL_RATE", uint256(1e18));
    }

    function deploy(Params memory p) public returns (Deployment memory d) {
        require(p.deployer != address(0), "DeployVentures: deployer");
        require(p.signer != p.safe && p.signer != p.deployer, "DeployVentures: signer must be its own hot key");
        checkSafe(p.safe);
        address[3] memory coded = [p.nymo, p.usdg, p.oracle];
        for (uint256 i; i < coded.length; ++i) {
            require(coded[i].code.length != 0, "DeployVentures: token or oracle has no code");
        }
        d.safe = p.safe;

        vm.startBroadcast(p.deployer);
        if (p.timelock == address(0)) {
            address[] memory s = new address[](1);
            s[0] = p.safe;
            d.timelock = address(new AnonymoTimelock(TIMELOCK_DELAY, s, s, address(0)));
        } else {
            d.timelock = p.timelock;
        }
        d.feeRouter = address(
            new VenturesFeeRouter(IERC20(p.usdg), d.timelock, p.workers, p.treasury, p.stakerCredits, p.buyBurn)
        );
        d.crewTiers = address(new CrewTiers(IERC20(p.nymo), d.timelock, p.safe));
        d.buildFuel = address(new BuildFuel(IERC20(p.nymo), d.timelock, p.safe, p.fuelRate));
        d.checkout = address(
            new Checkout(
                IERC20(p.usdg),
                IERC20(p.nymo),
                IPriceOracle(p.oracle),
                IVenturesFeeRouter(d.feeRouter),
                d.timelock,
                p.safe
            )
        );
        d.recipeRegistry = address(new RecipeRegistry(IERC20(p.usdg), d.timelock, p.safe, p.signer));
        d.forkFund = address(
            new ForkFund(
                IERC20(p.usdg),
                IERC20(p.nymo),
                IPriceOracle(p.oracle),
                IVenturesFeeRouter(d.feeRouter),
                d.timelock,
                p.safe,
                p.signer
            )
        );
        d.voteRegistry = address(new VoteRegistry(ICrewTiers(d.crewTiers), d.timelock, 0));
        vm.stopBroadcast();

        check(d, p.deployer);
        _log(d);
    }

    // ------------------------------------------------------------ checks

    /// @notice The Safe must be exactly 3 of 5.
    function checkSafe(address safe) public view {
        require(safe.code.length != 0, "check: VENTURES_SAFE has no code");
        IVenturesSafeView s = IVenturesSafeView(safe);
        require(s.getOwners().length == SAFE_OWNERS, "check: Safe must have 5 owners");
        require(s.getThreshold() == SAFE_THRESHOLD, "check: Safe threshold must be 3");
    }

    /// @notice The timelock waits at least 7 days, the Safe is its only proposer, canceller and executor, it
    /// administers itself, the deployer keeps nothing, and it owns every contract; the Safe guards every pause.
    function check(Deployment memory d, address deployer) public view {
        AnonymoTimelock t = AnonymoTimelock(payable(d.timelock));
        require(t.getMinDelay() >= TIMELOCK_DELAY, "check: timelock delay below 7 days");
        bytes32[3] memory roles = [t.PROPOSER_ROLE(), t.CANCELLER_ROLE(), t.EXECUTOR_ROLE()];
        for (uint256 i; i < roles.length; ++i) {
            require(t.hasRole(roles[i], d.safe), "check: Safe lacks a timelock role");
            require(t.roleMemberCount(roles[i]) == 1, "check: timelock role has other members");
        }
        require(t.hasRole(t.DEFAULT_ADMIN_ROLE(), d.timelock), "check: timelock self-admin");
        require(t.roleMemberCount(t.DEFAULT_ADMIN_ROLE()) == 1, "check: timelock has another admin");
        require(!t.hasRole(t.DEFAULT_ADMIN_ROLE(), deployer), "check: deployer is timelock admin");

        address[7] memory owned =
            [d.feeRouter, d.crewTiers, d.buildFuel, d.checkout, d.recipeRegistry, d.forkFund, d.voteRegistry];
        for (uint256 i; i < owned.length; ++i) {
            require(VoteRegistry(owned[i]).owner() == d.timelock, "check: owner is not the timelock");
        }
        address[5] memory guarded = [d.crewTiers, d.buildFuel, d.checkout, d.recipeRegistry, d.forkFund];
        for (uint256 i; i < guarded.length; ++i) {
            require(VenturesGuarded(guarded[i]).guardian() == d.safe, "check: guardian is not the Safe");
        }
        require(address(Checkout(d.checkout).feeRouter()) == d.feeRouter, "check: Checkout fee router");
        require(address(ForkFund(d.forkFund).feeRouter()) == d.feeRouter, "check: ForkFund fee router");
        require(address(VoteRegistry(d.voteRegistry).crewTiers()) == d.crewTiers, "check: VoteRegistry tiers");
    }

    function _log(Deployment memory d) internal pure {
        console2.log("Safe (3 of 5)     ", d.safe);
        console2.log("Timelock (7 days) ", d.timelock);
        console2.log("VenturesFeeRouter ", d.feeRouter);
        console2.log("CrewTiers         ", d.crewTiers);
        console2.log("BuildFuel         ", d.buildFuel);
        console2.log("Checkout          ", d.checkout);
        console2.log("RecipeRegistry    ", d.recipeRegistry);
        console2.log("ForkFund          ", d.forkFund);
        console2.log("VoteRegistry      ", d.voteRegistry);
    }
}
