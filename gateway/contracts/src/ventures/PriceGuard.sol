// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "./interfaces/IVentures.sol";

/// @title PriceGuard
/// @notice Reads the 30-minute NYMO TWAP and refuses it when spot is more than 5% away (|twap - spot| / twap >
/// 5%). Exactly 5% is accepted. Prices are USDG per whole NYMO, 18-decimal fixed point; USDG has 6 decimals and
/// NYMO 18, so `usdgUnits = nymoWei * price / 1e30`.
library PriceGuard {
    uint32 internal constant TWAP_WINDOW = 30 minutes;
    uint256 internal constant MAX_GAP_BPS = 500;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SCALE = 1e30; // 1e18 (price) * 1e18 (NYMO wei) / 1e6 (USDG units)

    error BadPrice();
    error PriceGap(uint256 twap, uint256 spot);

    /// @notice The guarded 30-minute TWAP.
    function guardedTwap(IPriceOracle oracle) internal view returns (uint256 twap) {
        twap = oracle.twap(TWAP_WINDOW);
        uint256 spot = oracle.spot();
        if (twap == 0 || spot == 0) revert BadPrice();
        uint256 gap = twap > spot ? twap - spot : spot - twap;
        if (gap * BPS > twap * MAX_GAP_BPS) revert PriceGap(twap, spot);
    }

    /// @notice NYMO wei worth `usdgUnits` at `price`, rounded up (the payer never underpays).
    function nymoFor(uint256 usdgUnits, uint256 price) internal pure returns (uint256) {
        return Math.mulDiv(usdgUnits, SCALE, price, Math.Rounding.Ceil);
    }

    /// @notice USDG units that `nymoWei` is worth at `price`, rounded down.
    function usdgFor(uint256 nymoWei, uint256 price) internal pure returns (uint256) {
        return Math.mulDiv(nymoWei, price, SCALE);
    }
}
