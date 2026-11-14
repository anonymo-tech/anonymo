// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployAnonymoLive} from "./DeployAnonymoLive.s.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";

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

interface IUniswapV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function initialize(uint160 sqrtPriceX96) external;
    function increaseObservationCardinalityNext(uint16 next) external;
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256, uint256);
}

/// Adds full-range liquidity to a v3 pool from its own balance (the pool calls back for the tokens).
contract PoolSeeder {
    function seed(address pool, uint128 liquidity) external {
        IUniswapV3Pool(pool).mint(address(this), -887220, 887220, liquidity, "");
    }

    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        // Test helper: trusts any caller. Only ever deployed on a local fork or a testnet.
        address t0 = IUniswapV3Pool(msg.sender).token0();
        (bool ok0,) = t0.call(abi.encodeCall(IERC20.transfer, (msg.sender, owed0)));
        (bool ok1,) = _other(t0).call(abi.encodeCall(IERC20.transfer, (msg.sender, owed1)));
        require(ok0 && ok1, "PoolSeeder: pay");
    }

    address internal tokenA;
    address internal tokenB;

    function setTokens(address a, address b) external {
        tokenA = a;
        tokenB = b;
    }

    function _other(address t) internal view returns (address) {
        return t == tokenA ? tokenB : tokenA;
    }
}

/// @title E2ESetup
/// @notice End-to-end fixture for a Robinhood Chain fork or testnet: a real Safe 1.4.1 (2 of 3, test owners), the
/// router and token stages of DeployAnonymoLive, and an ANMO/quote Uniswap v3 pool at a set price with full-range
/// liquidity and observation history room. TEST ONLY: the Safe owners are throwaway keys.
///
/// Env: E2E_DEPLOYER (address), E2E_OWNERS (3 addresses), E2E_QUOTE (USDG or a test stable), E2E_V3_FACTORY,
///      E2E_SAFE_SINGLETON, E2E_SAFE_FACTORY, E2E_SQRT_COIN0 / E2E_SQRT_COIN1 (sqrtPriceX96 when the coin is token0 or
///      token1), E2E_COIN_LIQ (coins), E2E_QUOTE_LIQ (quote units) sent to the seeder, E2E_LIQUIDITY (v3 liquidity).
/// Writes deployments/<chainId>-anonymo-e2e.json.
contract E2ESetup is Script {
    function run() external {
        address deployer = vm.envAddress("E2E_DEPLOYER");
        address[] memory owners = vm.envAddress("E2E_OWNERS", ",");
        address quote = vm.envAddress("E2E_QUOTE");

        vm.startBroadcast(deployer);
        address safe = ISafeProxyFactory(vm.envAddress("E2E_SAFE_FACTORY")).createProxyWithNonce(
            vm.envAddress("E2E_SAFE_SINGLETON"),
            abi.encodeCall(ISafeSetup.setup, (owners, 2, address(0), "", address(0), address(0), 0, address(0))),
            uint256(keccak256(abi.encode("anonymo.e2e", block.number)))
        );
        vm.stopBroadcast();

        DeployAnonymoLive live = new DeployAnonymoLive();
        DeployAnonymoLive.Params memory p;
        p.safe = safe;
        p.deployer = deployer;
        p.stables = new address[](1);
        p.stables[0] = quote;
        p.stage = DeployAnonymoLive.Stage.Router;
        DeployAnonymoLive.Deployment memory r = live.deploy(p);
        // The coin: a real Pons launch token (E2E_COIN, already trading in its v4 pool), or a stand-in minted to the
        // Safe with a fresh v3 pool (chains without Pons, such as testnet).
        address coin = vm.envOr("E2E_COIN", address(0));
        address pool;
        address seeder;
        if (coin == address(0)) {
            vm.startBroadcast(deployer);
            coin = address(new ANMO(safe));
            vm.stopBroadcast();
        }
        p.coin = coin;
        p.stage = DeployAnonymoLive.Stage.Coin;
        DeployAnonymoLive.Deployment memory t = live.deploy(p);
        if (vm.envOr("E2E_COIN", address(0)) == address(0)) {
            vm.startBroadcast(deployer);
            IUniswapV3Factory f = IUniswapV3Factory(vm.envAddress("E2E_V3_FACTORY"));
            pool = f.getPool(coin, quote, 3000);
            if (pool == address(0)) pool = f.createPool(coin, quote, 3000);
            bool coin0 = IUniswapV3Pool(pool).token0() == coin;
            IUniswapV3Pool(pool).initialize(uint160(vm.envUint(coin0 ? "E2E_SQRT_COIN0" : "E2E_SQRT_COIN1")));
            IUniswapV3Pool(pool).increaseObservationCardinalityNext(64);
            PoolSeeder ps = new PoolSeeder();
            ps.setTokens(coin, quote);
            seeder = address(ps);
            vm.stopBroadcast();
        }

        string memory k = "e2e";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "block", block.number);
        vm.serializeAddress(k, "safe", safe);
        vm.serializeAddress(k, "timelock", r.timelock);
        vm.serializeAddress(k, "depositRouter", r.depositRouter);
        vm.serializeAddress(k, "anmo", coin);
        vm.serializeAddress(k, "coinPay", t.coinPay);
        vm.serializeAddress(k, "quote", quote);
        vm.serializeAddress(k, "seeder", seeder);
        string memory json = vm.serializeAddress(k, "pool", pool);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-anonymo-e2e.json"));
        console2.log("safe", safe);
        console2.log("router", r.depositRouter);
        console2.log("coin", coin);
        console2.log("coinPay", t.coinPay);
        console2.log("pool", pool);
        console2.log("seeder", seeder);
    }
}
