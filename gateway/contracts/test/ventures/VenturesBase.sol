// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AnonymoTimelock} from "../../src/anonymo/AnonymoTimelock.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {CrewTiers} from "../../src/ventures/CrewTiers.sol";
import {BuildFuel} from "../../src/ventures/BuildFuel.sol";
import {Checkout} from "../../src/ventures/Checkout.sol";
import {VenturesFeeRouter} from "../../src/ventures/VenturesFeeRouter.sol";
import {RecipeRegistry} from "../../src/ventures/RecipeRegistry.sol";
import {ForkFund} from "../../src/ventures/ForkFund.sol";
import {VoteRegistry} from "../../src/ventures/VoteRegistry.sol";
import {IPriceOracle, IVenturesFeeRouter, ICrewTiers} from "../../src/ventures/interfaces/IVentures.sol";
import {MockUSDG} from "../../src/ventures/mocks/MockUSDG.sol";
import {MockPriceOracle} from "../../src/ventures/mocks/MockPriceOracle.sol";

/// @notice Shared fixture: every Ventures contract owned by a 7-day AnonymoTimelock whose only proposer,
/// canceller and executor is `safe` (which is also the pause guardian). NYMO is this repo's ANMO.
abstract contract VenturesBase is Test {
    uint256 internal constant DELAY = 7 days;
    uint256 internal constant PRICE = 5e16; // 0.05 USDG per NYMO
    uint256 internal constant FUEL_RATE = 10e18; // 10 build credits a day per NYMO
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 internal constant SKU = keccak256("sku.build.small");
    uint256 internal constant SKU_PRICE = 20e6; // 20 USDG

    address internal safe = makeAddr("safe");
    address internal nymoTreasury = makeAddr("nymo-treasury");
    address internal workers = makeAddr("workers");
    address internal treasury = makeAddr("treasury");
    address internal stakerCredits = makeAddr("staker-credits");
    address internal buyBurn = makeAddr("buy-burn");
    address internal signer = makeAddr("gateway-signer");

    AnonymoTimelock internal timelock;
    ANMO internal nymo;
    MockUSDG internal usdg;
    MockPriceOracle internal oracle;
    VenturesFeeRouter internal router;
    CrewTiers internal crew;
    BuildFuel internal fuel;
    Checkout internal checkout;
    RecipeRegistry internal recipes;
    ForkFund internal fork;
    VoteRegistry internal votes;

    uint256 private _salt;

    function _deployVentures() internal {
        vm.warp(1_790_000_000);
        address[] memory s = new address[](1);
        s[0] = safe;
        timelock = new AnonymoTimelock(DELAY, s, s, address(0));
        nymo = new ANMO(nymoTreasury);
        usdg = new MockUSDG();
        oracle = new MockPriceOracle(PRICE, PRICE);
        router = new VenturesFeeRouter(IERC20(address(usdg)), address(timelock), workers, treasury, stakerCredits, buyBurn);
        crew = new CrewTiers(IERC20(address(nymo)), address(timelock), safe);
        fuel = new BuildFuel(IERC20(address(nymo)), address(timelock), safe, FUEL_RATE);
        checkout = new Checkout(
            IERC20(address(usdg)),
            IERC20(address(nymo)),
            IPriceOracle(address(oracle)),
            IVenturesFeeRouter(address(router)),
            address(timelock),
            safe
        );
        recipes = new RecipeRegistry(IERC20(address(usdg)), address(timelock), safe, signer);
        fork = new ForkFund(
            IERC20(address(usdg)),
            IERC20(address(nymo)),
            IPriceOracle(address(oracle)),
            IVenturesFeeRouter(address(router)),
            address(timelock),
            safe,
            signer
        );
        votes = new VoteRegistry(ICrewTiers(address(crew)), address(timelock), 0);
    }

    /// @dev Give `who` NYMO from the treasury and approve every Ventures contract.
    function _fundNymo(address who, uint256 amount) internal {
        vm.prank(nymoTreasury);
        nymo.transfer(who, amount);
        vm.startPrank(who);
        nymo.approve(address(crew), type(uint256).max);
        nymo.approve(address(fuel), type(uint256).max);
        nymo.approve(address(checkout), type(uint256).max);
        nymo.approve(address(fork), type(uint256).max);
        vm.stopPrank();
    }

    function _fundUsdg(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(fork), type(uint256).max);
        usdg.approve(address(recipes), type(uint256).max);
        usdg.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Schedule `data` on `target` as the Safe, wait 7 days, execute.
    function _viaTimelock(address target, bytes memory data) internal {
        bytes32 salt = _schedule(target, data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _execute(target, data, salt);
    }

    function _schedule(address target, bytes memory data) internal returns (bytes32 salt) {
        salt = bytes32(++_salt);
        vm.prank(safe);
        timelock.schedule(target, 0, data, bytes32(0), salt, DELAY);
    }

    function _execute(address target, bytes memory data, bytes32 salt) internal {
        vm.prank(safe);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    function _setSkuPrice(bytes32 sku, uint256 price) internal {
        _viaTimelock(address(checkout), abi.encodeCall(Checkout.setSkuPrice, (sku, price)));
    }

    function _pauseAll() internal {
        vm.startPrank(safe);
        crew.pause();
        fuel.pause();
        checkout.pause();
        recipes.pause();
        fork.pause();
        vm.stopPrank();
    }

    // ------------------------------------------------------------ EIP-3009 helpers

    function _receiveAuth(uint256 key, bytes32 sku, uint256 qty, bytes32 ventureId, bytes32 salt, uint256 value)
        internal
        view
        returns (Checkout.ReceiveAuth memory a)
    {
        a.from = vm.addr(key);
        a.value = value;
        a.validAfter = 0;
        a.validBefore = vm.getBlockTimestamp() + 1 hours;
        a.salt = salt;
        a.nonce = checkout.orderNonce(sku, qty, ventureId, salt);
        (a.v, a.r, a.s) = vm.sign(key, _receiveDigest(a.from, address(checkout), value, a.validAfter, a.validBefore, a.nonce));
    }

    function _receiveDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash));
    }

    function _permit(uint256 key, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (Checkout.Permit memory p)
    {
        address owner = vm.addr(key);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                nymo.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", nymo.DOMAIN_SEPARATOR(), structHash));
        p.value = value;
        p.deadline = deadline;
        (p.v, p.r, p.s) = vm.sign(key, digest);
    }

    function _outsideBurn() internal view returns (uint256) {
        return nymo.totalSupply() - nymo.balanceOf(DEAD);
    }
}
