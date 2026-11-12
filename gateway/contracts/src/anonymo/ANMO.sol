// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title ANMO
/// @notice $ANMO, the Anonymo utility token. Adapted from AnmoToken: a fixed supply of 1,000,000,000 ANMO
/// (18 decimals) minted once in the constructor. No mint, no burn, no owner, no pause, so `totalSupply()`
/// never changes. The FeeRouter "burns" by sending to the dead address, which leaves the supply constant.
contract ANMO is ERC20, ERC20Permit {
    /// @notice Total (and only ever) supply.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    error ZeroAddress();

    /// @param recipient Receives the whole supply (the treasury Safe), which distributes it.
    constructor(address recipient) ERC20("Anonymo", "ANMO") ERC20Permit("Anonymo") {
        if (recipient == address(0)) revert ZeroAddress();
        _mint(recipient, TOTAL_SUPPLY);
    }
}
