// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title ANMO
/// @notice $ANMO, the Anonymo utility token (the ticker is a placeholder). 1,000,000,000 ANMO (18 decimals) are
/// minted once in the constructor and never again: no mint, no owner, no pause. Holders can burn their own coins
/// (ERC20Burnable), which lowers `totalSupply()`; CoinPay burns every coin spent on usage.
contract ANMO is ERC20, ERC20Permit, ERC20Burnable {
    /// @notice The supply at deploy; it only goes down, through burns.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    error ZeroAddress();

    /// @param recipient Receives the whole supply (the treasury Safe), which distributes it.
    constructor(address recipient) ERC20("Anonymo", "ANMO") ERC20Permit("Anonymo") {
        if (recipient == address(0)) revert ZeroAddress();
        _mint(recipient, TOTAL_SUPPLY);
    }
}
