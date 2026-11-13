// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title LocalSafe
/// @notice A minimal M-of-N multisig standing in for the Safe on a local anvil chain only. It exposes the
/// parts of the Safe interface the deploy script checks (`getOwners`, `getThreshold`, `nonce`) and executes a
/// call once `threshold` distinct owners have signed it. Production uses a real Safe (2 of 3); this contract
/// is never deployed outside anvil.
contract LocalSafe {
    address[] private _owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;
    uint256 public nonce;

    error BadConfig();
    error NotEnoughSignatures();
    error NotOwnerOrUnsorted();
    error CallFailed(bytes reason);

    constructor(address[] memory owners_, uint256 threshold_) {
        if (threshold_ == 0 || threshold_ > owners_.length) revert BadConfig();
        for (uint256 i; i < owners_.length; ++i) {
            address o = owners_[i];
            if (o == address(0) || isOwner[o]) revert BadConfig();
            isOwner[o] = true;
            _owners.push(o);
        }
        threshold = threshold_;
    }

    receive() external payable {}

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    /// @notice Hash the owners sign (as an EIP-191 personal message).
    function txHash(address to, uint256 value, bytes calldata data, uint256 nonce_) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), to, value, keccak256(data), nonce_));
    }

    /// @notice Execute a call signed by at least `threshold` owners. `signatures` is the concatenation of
    /// 65-byte signatures ordered by strictly increasing signer address.
    function exec(address to, uint256 value, bytes calldata data, bytes calldata signatures)
        external
        returns (bytes memory)
    {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(txHash(to, value, data, nonce));
        uint256 n = signatures.length / 65;
        if (n < threshold || signatures.length % 65 != 0) revert NotEnoughSignatures();
        address last;
        for (uint256 i; i < n; ++i) {
            address s = ECDSA.recover(digest, signatures[i * 65:(i + 1) * 65]);
            if (!isOwner[s] || s <= last) revert NotOwnerOrUnsorted();
            last = s;
        }
        ++nonce;
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        return ret;
    }

    /// @notice Safe-compatible views the live deploy script checks: LocalSafe has no modules and no guard.
    function getModulesPaginated(address, uint256) external pure returns (address[] memory array, address next) {
        array = new address[](0);
        next = address(0x1);
    }

    function getStorageAt(uint256, uint256 length) external pure returns (bytes memory) {
        return new bytes(length * 32);
    }
}
