// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {console2} from "forge-std/console2.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {CrewTiers} from "../../src/ventures/CrewTiers.sol";
import {BuildFuel} from "../../src/ventures/BuildFuel.sol";
import {Checkout} from "../../src/ventures/Checkout.sol";
import {VenturesFeeRouter} from "../../src/ventures/VenturesFeeRouter.sol";
import {RecipeRegistry} from "../../src/ventures/RecipeRegistry.sol";
import {ForkFund} from "../../src/ventures/ForkFund.sol";
import {VenturesGuarded} from "../../src/ventures/VenturesOwned.sol";
import {MockUSDG} from "../../src/ventures/mocks/MockUSDG.sol";
import {MockPriceOracle} from "../../src/ventures/mocks/MockPriceOracle.sol";
import {VenturesBase} from "./VenturesBase.sol";

struct Deps {
    ANMO nymo;
    MockUSDG usdg;
    MockPriceOracle oracle;
    VenturesFeeRouter router;
    CrewTiers crew;
    BuildFuel fuel;
    Checkout checkout;
    RecipeRegistry recipes;
    ForkFund fork;
    address timelock;
    address guardian;
    address signer;
    address funder;
}

/// Random stakes, unstakes, locks, unlocks, USDG and NYMO payments (with random TWAP/spot gaps), ForkFund
/// opens, contributions, withdrawals, triggers and refunds, recipe runs, funding and claims, pauses, unpauses and
/// time jumps. Every exit (unstake, unlock, withdraw, refund, claim) is called without try/catch, so with
/// fail_on_revert a revert there, paused or not, fails the run. Calls that must be refused (a payment while
/// paused, a NYMO payment over the 5% gap) go through try/catch and raise a flag if they succeed.
contract VenturesHandler is CommonBase, StdUtils {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant PRICE = 5e16;

    Deps internal d;
    address[] public actors;
    uint256[] internal keys;
    bytes32[] internal skus;
    uint256[] public fundIds;
    uint256[] internal recipeIds;

    // FeeRouter ghosts
    uint256 public routed;
    uint256 public toWorkers;
    uint256 public toTreasury;
    uint256 public toStakers;
    uint256 public toBuyBurn;
    // burn ghosts
    uint256 public burned;
    uint256 public lastOutside;
    bool public supplyIncreased;
    // ForkFund ghosts
    mapping(uint256 => uint256) public inUsdg;
    mapping(uint256 => uint256) public outUsdg;
    mapping(uint256 => uint256) public inNymo;
    mapping(uint256 => uint256) public outNymo;
    // RecipeRegistry ghosts
    uint256 public funded;
    uint256 private _orderSeq;
    uint256 private _salt;
    // flags and counters
    bool public pausedPaymentSucceeded;
    bool public gapPaymentSucceeded;
    uint256 public exitsWhilePaused;
    uint256 public gapRefusals;

    constructor(Deps memory deps, address[] memory a, uint256[] memory k, bytes32[] memory s) {
        d = deps;
        actors = a;
        keys = k;
        skus = s;
        lastOutside = _outside();
    }

    modifier checked() {
        _;
        uint256 cur = _outside();
        if (cur > lastOutside) supplyIncreased = true;
        lastOutside = cur;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function fundCount() external view returns (uint256) {
        return fundIds.length;
    }

    function _outside() internal view returns (uint256) {
        return d.nymo.totalSupply() - d.nymo.balanceOf(DEAD);
    }

    function _pick(uint256 i) internal view returns (address, uint256) {
        uint256 j = i % actors.length;
        return (actors[j], keys[j]);
    }

    function _routedSplit(uint256 amount) internal {
        (uint256 w, uint256 t, uint256 s, uint256 b) = d.router.split(amount);
        routed += amount;
        toWorkers += w;
        toTreasury += t;
        toStakers += s;
        toBuyBurn += b;
    }

    // ------------------------------------------------------------ CrewTiers / BuildFuel

    function stake(uint256 who, uint256 amount) external checked {
        (address a,) = _pick(who);
        uint256 bal = d.nymo.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        bool paused = d.crew.paused();
        vm.prank(a);
        if (paused) {
            try d.crew.stake(amount) {
                pausedPaymentSucceeded = true;
            } catch {}
        } else {
            d.crew.stake(amount);
        }
    }

    function unstake(uint256 who, uint256 amount) external checked {
        (address a,) = _pick(who);
        uint256 staked = d.crew.stakedOf(a);
        if (staked == 0) return;
        amount = bound(amount, 1, staked);
        if (d.crew.paused()) ++exitsWhilePaused;
        vm.prank(a);
        d.crew.unstake(amount); // must never revert
    }

    function lock(uint256 who, uint256 amount) external checked {
        (address a,) = _pick(who);
        uint256 bal = d.nymo.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        bool paused = d.fuel.paused();
        vm.prank(a);
        if (paused) {
            try d.fuel.lock(amount) {
                pausedPaymentSucceeded = true;
            } catch {}
        } else {
            d.fuel.lock(amount);
        }
    }

    function unlock(uint256 who, uint256 amount) external checked {
        (address a,) = _pick(who);
        uint256 locked = d.fuel.lockedOf(a);
        if (locked == 0) return;
        amount = bound(amount, 1, locked);
        if (d.fuel.paused()) ++exitsWhilePaused;
        vm.prank(a);
        d.fuel.unlock(amount); // must never revert
    }

    // ------------------------------------------------------------ Checkout

    function payUSDG(uint256 who, uint256 skuIdx, uint256 qty, bytes32 ventureId) external checked {
        (address a, uint256 k) = _pick(who);
        bytes32 sku = skus[skuIdx % skus.length];
        qty = bound(qty, 1, 5);
        uint256 amount = d.checkout.priceOf(sku, qty);
        if (d.usdg.balanceOf(a) < amount) d.usdg.mint(a, amount);
        Checkout.ReceiveAuth memory auth = _auth(a, k, sku, qty, ventureId, amount);
        if (d.checkout.paused()) {
            try d.checkout.payUSDG(sku, qty, ventureId, auth) {
                pausedPaymentSucceeded = true;
            } catch {}
            return;
        }
        d.checkout.payUSDG(sku, qty, ventureId, auth);
        _routedSplit(amount);
    }

    function payNYMO(uint256 who, uint256 skuIdx, uint256 qty, uint256 gapBps, bool above) external checked {
        (address a,) = _pick(who);
        bytes32 sku = skus[skuIdx % skus.length];
        qty = bound(qty, 1, 3);
        gapBps = bound(gapBps, 0, 1_000);
        uint256 spot = above ? PRICE + (PRICE * gapBps) / 10_000 : PRICE - (PRICE * gapBps) / 10_000;
        d.oracle.set(PRICE, spot);
        uint256 gap = spot > PRICE ? spot - PRICE : PRICE - spot;
        bool tooFar = gap * 10_000 > PRICE * 500;
        Checkout.Permit memory p; // existing max allowance, no permit
        p.value = type(uint256).max;
        if (tooFar || d.checkout.paused()) {
            vm.prank(a);
            try d.checkout.payNYMO(sku, qty, 0, p) {
                if (tooFar) gapPaymentSucceeded = true;
                else pausedPaymentSucceeded = true;
            } catch {
                if (tooFar) ++gapRefusals;
            }
        } else {
            uint256 due = d.checkout.quoteNYMO(sku, qty);
            if (d.nymo.balanceOf(a) >= due) {
                vm.prank(a);
                d.checkout.payNYMO(sku, qty, 0, p);
                burned += due;
            }
        }
        d.oracle.set(PRICE, PRICE);
    }

    function _auth(address a, uint256 k, bytes32 sku, uint256 qty, bytes32 ventureId, uint256 amount)
        internal
        returns (Checkout.ReceiveAuth memory auth)
    {
        auth.from = a;
        auth.value = amount;
        auth.validBefore = vm.getBlockTimestamp() + 1 hours;
        auth.salt = bytes32(++_salt);
        auth.nonce = d.checkout.orderNonce(sku, qty, ventureId, auth.salt);
        bytes32 h = keccak256(
            abi.encode(
                d.usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                a,
                address(d.checkout),
                amount,
                uint256(0),
                auth.validBefore,
                auth.nonce
            )
        );
        (auth.v, auth.r, auth.s) = vm.sign(k, keccak256(abi.encodePacked("\x19\x01", d.usdg.DOMAIN_SEPARATOR(), h)));
    }

    // ------------------------------------------------------------ ForkFund

    function open(uint256 who, uint256 goal) external checked {
        (address a,) = _pick(who);
        goal = bound(goal, d.fork.minCashUsdg(), 5_000e6);
        if (d.fork.paused()) {
            vm.prank(a);
            try d.fork.open(keccak256("t"), keccak256("s"), goal) {
                pausedPaymentSucceeded = true;
            } catch {}
            return;
        }
        vm.prank(a);
        fundIds.push(d.fork.open(keccak256(abi.encode("target", fundIds.length)), keccak256("spec"), goal));
    }

    function contribute(uint256 who, uint256 f, bool inNymo_, uint256 amount) external checked {
        if (fundIds.length == 0) return;
        (address a,) = _pick(who);
        uint256 id = fundIds[f % fundIds.length];
        ForkFund.Fund memory fund = d.fork.funds(id);
        if (fund.status != ForkFund.Status.Open || vm.getBlockTimestamp() >= fund.deadline) return;
        ForkFund.Currency c = inNymo_ ? ForkFund.Currency.NYMO : ForkFund.Currency.USDG;
        if (inNymo_) {
            uint256 bal = d.nymo.balanceOf(a);
            if (bal == 0) return;
            amount = bound(amount, 1, bal < 100_000e18 ? bal : 100_000e18);
        } else {
            amount = bound(amount, 1, 3_000e6);
            if (d.usdg.balanceOf(a) < amount) d.usdg.mint(a, amount);
        }
        bool paused = d.fork.paused();
        vm.prank(a);
        if (paused) {
            try d.fork.contribute(id, c, amount) {
                pausedPaymentSucceeded = true;
            } catch {}
            return;
        }
        d.fork.contribute(id, c, amount);
        if (inNymo_) inNymo[id] += amount;
        else inUsdg[id] += amount;
    }

    function withdraw(uint256 who, uint256 f) external checked {
        if (fundIds.length == 0) return;
        (address a,) = _pick(who);
        uint256 id = fundIds[f % fundIds.length];
        if (d.fork.funds(id).status != ForkFund.Status.Open) return;
        (uint256 u, uint256 n,) = d.fork.contributions(id, a);
        if (u == 0 && n == 0) return;
        if (d.fork.paused()) ++exitsWhilePaused;
        vm.prank(a);
        d.fork.withdraw(id); // must never revert before the trigger
        outUsdg[id] += u;
        outNymo[id] += n;
    }

    function refund(uint256 who, uint256 f) external checked {
        if (fundIds.length == 0) return;
        (address a,) = _pick(who);
        uint256 id = fundIds[f % fundIds.length];
        ForkFund.Fund memory fund = d.fork.funds(id);
        if (fund.status != ForkFund.Status.Open || vm.getBlockTimestamp() < fund.deadline) return;
        (uint256 u, uint256 n,) = d.fork.contributions(id, a);
        if (u == 0 && n == 0) return;
        if (d.fork.paused()) ++exitsWhilePaused;
        d.fork.refund(id, a); // must never revert after the deadline
        outUsdg[id] += u;
        outNymo[id] += n;
    }

    function trigger(uint256 f) external checked {
        if (fundIds.length == 0) return;
        uint256 id = fundIds[f % fundIds.length];
        ForkFund.Fund memory fund = d.fork.funds(id);
        if (fund.status != ForkFund.Status.Open || vm.getBlockTimestamp() >= fund.deadline) return;
        if (fund.usdgRaised + fund.nymoValueUsdg < fund.goalUsdg) return;
        if (fund.usdgRaised < d.fork.minCashUsdg()) return; // NYMO is burned: the USDG alone must cover the build
        if (d.fork.paused()) {
            try d.fork.trigger(id) {
                pausedPaymentSucceeded = true;
            } catch {}
            return;
        }
        d.fork.trigger(id);
        if (fund.usdgRaised != 0) _routedSplit(fund.usdgRaised);
        burned += fund.nymoRaised;
    }

    // ------------------------------------------------------------ RecipeRegistry

    function publish(uint256 who, uint256 price) external checked {
        if (d.recipes.paused()) return;
        (address a,) = _pick(who);
        price = bound(price, 0, 50e6);
        vm.prank(a);
        recipeIds.push(d.recipes.publish(keccak256(abi.encode("recipe", recipeIds.length)), price, a));
    }

    function recordRun(uint256 r) external checked {
        if (recipeIds.length == 0) return;
        vm.prank(d.signer);
        d.recipes.recordRun(recipeIds[r % recipeIds.length], bytes32(++_orderSeq));
    }

    function fundRecipes(uint256 amount) external checked {
        amount = bound(amount, 1, 200e6);
        d.usdg.mint(d.funder, amount);
        vm.prank(d.funder);
        d.recipes.fund(amount);
        funded += amount;
    }

    function claim(uint256 who) external checked {
        (address a,) = _pick(who);
        if (d.recipes.paused()) ++exitsWhilePaused;
        vm.prank(a);
        d.recipes.claim(); // never reverts
    }

    // ------------------------------------------------------------ pause and time

    function pause(uint256 which) external checked {
        VenturesGuarded g = _guarded(which);
        if (g.paused()) return;
        vm.prank(d.guardian);
        g.pause();
    }

    /// @dev Stands in for an executed timelock entry (the timelock queue itself is covered by the governance
    /// invariant below).
    function unpause(uint256 which) external checked {
        VenturesGuarded g = _guarded(which);
        if (!g.paused()) return;
        vm.prank(d.timelock);
        g.unpause();
    }

    function advance(uint256 s) external checked {
        vm.warp(vm.getBlockTimestamp() + bound(s, 1, 3 days));
    }

    function _guarded(uint256 which) internal view returns (VenturesGuarded) {
        uint256 w = which % 5;
        if (w == 0) return d.crew;
        if (w == 1) return d.fuel;
        if (w == 2) return d.checkout;
        if (w == 3) return d.recipes;
        return d.fork;
    }
}

contract VenturesInvariantTest is VenturesBase {
    VenturesHandler handler;
    address funder = makeAddr("recipe-funder");
    uint256 outside0;

    function setUp() public {
        _deployVentures();
        address[] memory a = new address[](4);
        uint256[] memory k = new uint256[](4);
        string[4] memory names = ["actor-a", "actor-b", "actor-c", "actor-d"];
        for (uint256 i; i < 4; ++i) {
            (a[i], k[i]) = makeAddrAndKey(names[i]);
            _fundNymo(a[i], i == 3 ? 1_000e18 : 3_000_000e18);
            _fundUsdg(a[i], 10_000e6);
        }
        vm.prank(funder);
        usdg.approve(address(recipes), type(uint256).max);
        bytes32[] memory s = new bytes32[](2);
        s[0] = SKU;
        s[1] = keccak256("sku.host.month");
        _setSkuPrice(s[0], SKU_PRICE);
        _setSkuPrice(s[1], 3_333_333); // odd price: rounding dust in every split
        Deps memory deps = Deps(
            nymo, usdg, oracle, router, crew, fuel, checkout, recipes, fork, address(timelock), safe, signer, funder
        );
        handler = new VenturesHandler(deps, a, k, s);
        outside0 = _outsideBurn();
        targetContract(address(handler));
    }

    /// Pause gates new payments, stakes, locks, opens, contributions and triggers.
    function invariant_pauseGatesNewMoney() public view {
        assertFalse(handler.pausedPaymentSucceeded());
    }

    /// payNYMO never succeeds when |twap - spot| / twap > 5%.
    function invariant_payNymoRefusesGapAboveFivePercent() public view {
        assertFalse(handler.gapPaymentSucceeded());
    }

    /// NYMO held outside the burn address never goes up, and the burn address holds exactly what was burned.
    function invariant_supplyOutsideBurnNonIncreasing() public view {
        assertFalse(handler.supplyIncreased());
        assertLe(_outsideBurn(), outside0);
        assertEq(nymo.balanceOf(DEAD), handler.burned());
        assertEq(nymo.totalSupply(), nymo.TOTAL_SUPPLY());
    }

    /// The bps sum to 10,000 and every routed amount splits exactly (dust to the treasury); the router keeps
    /// nothing.
    function invariant_feeRouterConserves() public view {
        assertEq(
            router.WORKERS_BPS() + router.TREASURY_BPS() + router.STAKER_CREDITS_BPS() + router.BUY_BURN_BPS(),
            10_000
        );
        assertEq(handler.toWorkers() + handler.toTreasury() + handler.toStakers() + handler.toBuyBurn(), handler.routed());
        assertEq(usdg.balanceOf(workers), handler.toWorkers());
        assertEq(usdg.balanceOf(treasury), handler.toTreasury());
        assertEq(usdg.balanceOf(stakerCredits), handler.toStakers());
        assertEq(usdg.balanceOf(buyBurn), handler.toBuyBurn());
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(usdg.balanceOf(address(checkout)), 0);
    }

    /// Each open fund's escrow equals its contributions minus withdrawals and refunds, and the contract holds
    /// exactly the escrow of the open funds.
    function invariant_forkFundEscrow() public view {
        uint256 u;
        uint256 n;
        uint256 count = handler.fundCount();
        for (uint256 i; i < count; ++i) {
            uint256 id = handler.fundIds(i);
            ForkFund.Fund memory f = fork.funds(id);
            if (f.status != ForkFund.Status.Open) continue;
            assertEq(f.usdgRaised, handler.inUsdg(id) - handler.outUsdg(id));
            assertEq(f.nymoRaised, handler.inNymo(id) - handler.outNymo(id));
            u += f.usdgRaised;
            n += f.nymoRaised;
        }
        assertEq(usdg.balanceOf(address(fork)), u);
        assertEq(nymo.balanceOf(address(fork)), n);
    }

    /// Stakes and locks are fully backed and the totals match the positions.
    function invariant_stakesAndLocksBacked() public view {
        uint256 s;
        uint256 l;
        uint256 count = handler.actorCount();
        for (uint256 i; i < count; ++i) {
            s += crew.stakedOf(handler.actors(i));
            l += fuel.lockedOf(handler.actors(i));
        }
        assertEq(crew.totalStaked(), s);
        assertEq(fuel.totalLocked(), l);
        assertEq(nymo.balanceOf(address(crew)), s);
        assertEq(nymo.balanceOf(address(fuel)), l);
    }

    /// Creator payouts: owed totals match, and the pool is what was funded minus what was paid.
    function invariant_recipePayouts() public view {
        uint256 owed;
        uint256 paid;
        uint256 count = handler.actorCount();
        for (uint256 i; i < count; ++i) {
            owed += recipes.owedOf(handler.actors(i));
            paid += recipes.paidOf(handler.actors(i));
        }
        assertEq(recipes.totalOwed(), owed);
        assertEq(usdg.balanceOf(address(recipes)), handler.funded() - paid);
    }

    function afterInvariant() external view {
        // Report-only (-vv): shows the paused-exit, refused-gap, trigger and burn paths are exercised.
        console2.log("exits while paused", handler.exitsWhilePaused());
        console2.log("gap refusals", handler.gapRefusals());
        console2.log("USDG routed", handler.routed());
        console2.log("NYMO burned", handler.burned());
    }
}
