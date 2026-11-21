// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPriceOracle} from "../interfaces/IVentures.sol";

/// @notice Local and test NYMO price oracle with settable TWAP and spot (USDG per NYMO, 18 decimals). Never
/// deploy outside anvil and tests.
contract MockPriceOracle is IPriceOracle {
    uint256 public twapPrice;
    uint256 public spotPrice;

    constructor(uint256 twap_, uint256 spot_) {
        twapPrice = twap_;
        spotPrice = spot_;
    }

    function set(uint256 twap_, uint256 spot_) external {
        twapPrice = twap_;
        spotPrice = spot_;
    }

    function twap(uint32) external view returns (uint256) {
        return twapPrice;
    }

    function spot() external view returns (uint256) {
        return spotPrice;
    }
}
