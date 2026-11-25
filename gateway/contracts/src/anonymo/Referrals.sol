// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EverydayOwned} from "./EverydayOwned.sol";
import {EverydayTimelock} from "./EverydayTimelock.sol";

/// @notice The funding service registers a referral once after the first confirmed funding on any rail.
contract Referrals is EverydayOwned {
    uint256 public constant CREDIT_WINDOW = 90 days;

    address public registrar;

    event Registered(bytes32 indexed inviterHash);
    event RegistrarSet(address indexed registrar);

    error InvalidRegistrar();
    error NotRegistrar();
    error InvalidInviter();

    constructor(EverydayTimelock timelock_, address registrar_) EverydayOwned(timelock_) {
        _setRegistrar(registrar_);
    }

    /// @dev First-funding eligibility, deduplication and credit accrual belong to the off-chain funding service.
    function register(bytes32 inviterHash) external {
        if (msg.sender != registrar) revert NotRegistrar();
        if (inviterHash == bytes32(0)) revert InvalidInviter();
        emit Registered(inviterHash);
    }

    function setRegistrar(address registrar_) external onlyOwner {
        _setRegistrar(registrar_);
    }

    function _setRegistrar(address registrar_) private {
        if (registrar_ == address(0)) revert InvalidRegistrar();
        registrar = registrar_;
        emit RegistrarSet(registrar_);
    }
}
