// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Price source for NYMO (the spec's $NYMO is this repo's ANMO token). Both functions return USDG per
/// whole NYMO as an 18-decimal fixed-point number: 0.05 USDG per NYMO is 5e16.
interface IPriceOracle {
    /// @notice Time-weighted average price over the trailing `window` seconds.
    function twap(uint32 window) external view returns (uint256);

    /// @notice Current price.
    function spot() external view returns (uint256);
}

/// @notice EIP-3009 receive path (USDC/USDG style). The token must check `to == msg.sender`.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice What VoteRegistry reads from CrewTiers.
interface ICrewTiers {
    function twabAt(address account, uint256 timestamp) external view returns (uint256);
    function totalTwabAt(uint256 timestamp) external view returns (uint256);
    function tierOf(address account) external view returns (uint8);
}

/// @notice What Checkout and ForkFund call on the VenturesFeeRouter.
interface IVenturesFeeRouter {
    function route(uint256 amount, bytes32 ref) external;
}
