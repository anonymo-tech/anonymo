// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AnonymoTimelock} from "../../src/anonymo/AnonymoTimelock.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {LocalSafe} from "../../script/anonymo/LocalSafe.sol";
import {DeployVentures} from "../../script/DeployVentures.s.sol";
import {BuildFuel} from "../../src/ventures/BuildFuel.sol";
import {VenturesFeeRouter} from "../../src/ventures/VenturesFeeRouter.sol";
import {MockUSDG} from "../../src/ventures/mocks/MockUSDG.sol";
import {MockPriceOracle} from "../../src/ventures/mocks/MockPriceOracle.sol";

/// Dry run of the deploy script inside the test EVM (no network).
contract DeployVenturesTest is Test {
    DeployVentures script;
    DeployVentures.Params p;
    address deployer = makeAddr("deployer");

    function _safe(uint256 owners, uint256 threshold) internal returns (address) {
        address[] memory o = new address[](owners);
        for (uint256 i; i < owners; ++i) {
            o[i] = makeAddr(string(abi.encodePacked("safe-owner-", vm.toString(i))));
        }
        return address(new LocalSafe(o, threshold));
    }

    function setUp() public {
        vm.warp(1_790_000_000);
        script = new DeployVentures();
        p.safe = _safe(5, 3);
        p.deployer = deployer;
        p.nymo = address(new ANMO(makeAddr("nymo-treasury")));
        p.usdg = address(new MockUSDG());
        p.oracle = address(new MockPriceOracle(5e16, 5e16));
        p.signer = makeAddr("gateway-signer");
        p.workers = makeAddr("workers");
        p.treasury = makeAddr("treasury");
        p.stakerCredits = makeAddr("staker-credits");
        p.buyBurn = makeAddr("buy-burn");
        p.fuelRate = 1e18;
    }

    function test_deploy_newTimelock() public {
        DeployVentures.Deployment memory d = script.deploy(p);
        script.check(d, deployer);
        assertEq(AnonymoTimelock(payable(d.timelock)).getMinDelay(), 7 days);
        assertEq(VenturesFeeRouter(d.feeRouter).workers(), p.workers);
        assertEq(BuildFuel(d.buildFuel).fuelRate(), 1e18);
        assertEq(BuildFuel(d.buildFuel).owner(), d.timelock);
    }

    function test_deploy_existingTimelock() public {
        address[] memory s = new address[](1);
        s[0] = p.safe;
        p.timelock = address(new AnonymoTimelock(14 days, s, s, address(0)));
        DeployVentures.Deployment memory d = script.deploy(p);
        assertEq(d.timelock, p.timelock);
    }

    function test_refusesShortExistingTimelock() public {
        address[] memory s = new address[](1);
        s[0] = p.safe;
        p.timelock = address(new AnonymoTimelock(48 hours, s, s, address(0)));
        vm.expectRevert(); // the first constructor refuses a sub-7-day owner
        script.deploy(p);
    }

    function test_refusesTimelockWithExtraProposer() public {
        address[] memory s = new address[](2);
        s[0] = p.safe;
        s[1] = makeAddr("extra");
        p.timelock = address(new AnonymoTimelock(7 days, s, s, address(0)));
        vm.expectRevert(bytes("check: timelock role has other members"));
        script.deploy(p);
    }

    function test_refusesWrongSafe() public {
        p.safe = _safe(3, 2);
        vm.expectRevert(bytes("check: Safe must have 5 owners"));
        script.deploy(p);
        p.safe = _safe(5, 2);
        vm.expectRevert(bytes("check: Safe threshold must be 3"));
        script.deploy(p);
        p.safe = makeAddr("eoa");
        vm.expectRevert(bytes("check: VENTURES_SAFE has no code"));
        script.deploy(p);
    }

    function test_refusesSignerReuse() public {
        p.signer = p.safe;
        vm.expectRevert(bytes("DeployVentures: signer must be its own hot key"));
        script.deploy(p);
    }

    function test_envParams() public {
        vm.setEnv("VENTURES_SAFE", vm.toString(p.safe));
        vm.setEnv("VENTURES_DEPLOYER", vm.toString(deployer));
        vm.setEnv("VENTURES_NYMO", vm.toString(p.nymo));
        vm.setEnv("VENTURES_USDG", vm.toString(p.usdg));
        vm.setEnv("VENTURES_ORACLE", vm.toString(p.oracle));
        vm.setEnv("VENTURES_GATEWAY_SIGNER", vm.toString(p.signer));
        vm.setEnv("VENTURES_WORKERS", vm.toString(p.workers));
        vm.setEnv("VENTURES_TREASURY", vm.toString(p.treasury));
        vm.setEnv("VENTURES_STAKER_CREDITS", vm.toString(p.stakerCredits));
        vm.setEnv("VENTURES_BUY_BURN", vm.toString(p.buyBurn));
        DeployVentures.Params memory e = script.envParams();
        assertEq(e.safe, p.safe);
        assertEq(e.timelock, address(0));
        assertEq(e.fuelRate, 1e18);
        assertEq(e.buyBurn, p.buyBurn);
        script.deploy(e);
    }
}
