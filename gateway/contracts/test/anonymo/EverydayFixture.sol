// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {EverydayTimelock} from "../../src/anonymo/EverydayTimelock.sol";
import {EverydayFeeRouter} from "../../src/anonymo/EverydayFeeRouter.sol";
import {Checkout} from "../../src/anonymo/Checkout.sol";
import {StakeCredits} from "../../src/anonymo/StakeCredits.sol";
import {CreatorPayouts} from "../../src/anonymo/CreatorPayouts.sol";
import {Referrals} from "../../src/anonymo/Referrals.sol";
import {VoteRegistry} from "../../src/anonymo/VoteRegistry.sol";
import {Boosts} from "../../src/anonymo/Boosts.sol";
import {MockUSDG} from "../../src/ventures/mocks/MockUSDG.sol";
import {MockPriceOracle} from "../../src/ventures/mocks/MockPriceOracle.sol";

contract EverydayTestSafe {
    uint256 public getThreshold = 3;
    bool public hasModule;

    function getOwners() external pure returns (address[] memory owners) {
        owners = new address[](5);
        for (uint160 i; i < owners.length; ++i) {
            owners[i] = address(i + 10); // gitleaks:allow
        }
    }

    function getModulesPaginated(address, uint256) external view returns (address[] memory, address) {
        address[] memory modules = new address[](hasModule ? 1 : 0);
        if (hasModule) modules[0] = address(20); // gitleaks:allow
        return (modules, address(1)); // gitleaks:allow
    }

    function setThreshold(uint256 threshold) external {
        getThreshold = threshold;
    }

    function setModule(bool enabled) external {
        hasModule = enabled;
    }
}

abstract contract EverydayFixture is Test {
    uint256 internal constant WEEK = 7 days;
    bytes32 internal constant CREATOR = keccak256("creator");
    bytes32 internal constant ORDER = keccak256("order");

    EverydayTestSafe internal safe;
    EverydayTimelock internal timelock;
    EverydayFeeRouter internal router;
    ANMO internal nymo;
    MockUSDG internal usdg;
    MockPriceOracle internal oracle;
    StakeCredits internal stakes;
    Checkout internal checkout;
    CreatorPayouts internal payouts;
    Referrals internal referrals;
    VoteRegistry internal votes;
    Boosts internal boosts;

    address internal payer;
    uint256 internal payerKey;
    address internal workers = makeAddr("workers"); // gitleaks:allow
    address internal treasury = makeAddr("treasury"); // gitleaks:allow
    address internal stakerCredits = makeAddr("staker-credits"); // gitleaks:allow
    address internal buyBurn = makeAddr("buy-burn"); // gitleaks:allow
    address internal signer = makeAddr("payouts-signer"); // gitleaks:allow
    address internal registrar = makeAddr("registrar"); // gitleaks:allow
    address internal second = makeAddr("second"); // gitleaks:allow
    uint256 private _salt;

    function setUp() public virtual {
        vm.warp(10 * WEEK);
        (payer, payerKey) = makeAddrAndKey("everyday-payer"); // gitleaks:allow
        safe = new EverydayTestSafe();
        timelock = new EverydayTimelock(address(safe));
        nymo = new ANMO(address(this));
        usdg = new MockUSDG();
        oracle = new MockPriceOracle(1e18, 1e18);
        router = new EverydayFeeRouter(
            usdg, timelock, EverydayFeeRouter.Recipients(workers, treasury, stakerCredits, buyBurn)
        );
        stakes = new StakeCredits(nymo, timelock, [uint256(1e6), 2e6, 3e6]);
        checkout = new Checkout(nymo, router, oracle, timelock);
        payouts = new CreatorPayouts(router, signer, timelock);
        referrals = new Referrals(timelock, registrar);
        votes = new VoteRegistry(stakes, timelock);
        boosts = new Boosts(nymo, timelock);

        nymo.transfer(payer, 500_000e18);
        nymo.transfer(second, 500_000e18);
        usdg.mint(payer, 10_000e6);
        usdg.mint(workers, 10_000e6);
        vm.startPrank(payer);
        nymo.approve(address(stakes), type(uint256).max);
        nymo.approve(address(boosts), type(uint256).max);
        usdg.approve(address(payouts), type(uint256).max);
        vm.stopPrank();
        vm.prank(workers);
        usdg.approve(address(payouts), type(uint256).max);
    }

    function _queue(address target, bytes memory data) internal returns (bytes32 salt) {
        salt = bytes32(++_salt);
        uint256 delay = timelock.getMinDelay();
        vm.prank(address(safe));
        timelock.schedule(target, 0, data, bytes32(0), salt, delay);
    }

    function _execute(address target, bytes memory data, bytes32 salt) internal {
        vm.prank(address(safe));
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    function _govern(address target, bytes memory data) internal {
        bytes32 salt = _queue(target, data);
        vm.warp(block.timestamp + timelock.getMinDelay());
        _execute(target, data, salt);
    }

    function _authorize(bytes32 sku, uint256 qty, bytes32 ref)
        internal
        view
        returns (Checkout.ReceiveAuth memory a)
    {
        a.from = payer;
        a.value = checkout.priceOf(sku, qty);
        a.validAfter = block.timestamp - 1;
        a.validBefore = block.timestamp + 10 minutes;
        a.orderRef = ref;
        bytes32 payload = keccak256(
            abi.encode(
                usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                payer,
                address(checkout),
                a.value,
                a.validAfter,
                a.validBefore,
                checkout.orderNonce(sku, qty, ref)
            )
        );
        (a.v, a.r, a.s) =
            vm.sign(payerKey, keccak256(abi.encodePacked(hex"1901", usdg.DOMAIN_SEPARATOR(), payload))); // gitleaks:allow
    }

    function _permit(bytes32 ref, uint256 value) internal view returns (Checkout.Permit memory p) {
        p.orderRef = ref;
        p.value = value;
        p.deadline = block.timestamp + 10 minutes;
        bytes32 payload = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                payer,
                address(checkout),
                value,
                nymo.nonces(payer),
                p.deadline
            )
        );
        (p.v, p.r, p.s) =
            vm.sign(payerKey, keccak256(abi.encodePacked(hex"1901", nymo.DOMAIN_SEPARATOR(), payload))); // gitleaks:allow
    }

    function _node(address creator, uint256 amount) internal view returns (CreatorPayouts.Node memory) {
        return CreatorPayouts.Node(payouts.leafFor(creator, amount), amount);
    }

    function _root(CreatorPayouts.Node memory node) internal pure returns (bytes32) {
        return keccak256(abi.encode(node.hash, node.sum));
    }

    function _proof(CreatorPayouts.Node memory sibling)
        internal
        pure
        returns (CreatorPayouts.Node[] memory proof)
    {
        proof = new CreatorPayouts.Node[](1);
        proof[0] = sibling;
    }
}
