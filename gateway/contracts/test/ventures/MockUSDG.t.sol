// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDG} from "../../src/ventures/mocks/MockUSDG.sol";

/// EIP-3009 behaviour of the test USDG.
contract MockUSDGTest is Test {
    MockUSDG usdg;
    address from;
    uint256 key;
    address to = makeAddr("to");

    function setUp() public {
        vm.warp(1_790_000_000);
        usdg = new MockUSDG();
        (from, key) = makeAddrAndKey("from");
        usdg.mint(from, 100e6);
    }

    function _sign(bytes32 typehash, address to_, uint256 value, uint256 after_, uint256 before, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 h = keccak256(abi.encode(typehash, from, to_, value, after_, before, nonce));
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), h)));
    }

    function test_decimals() public view {
        assertEq(usdg.decimals(), 6);
    }

    function test_receive_toMustBeCaller() public {
        bytes32 th = usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH();
        (uint8 v, bytes32 r, bytes32 s) = _sign(th, to, 10e6, 0, vm.getBlockTimestamp() + 60, bytes32("n"));
        vm.expectRevert(MockUSDG.CallerMustBePayee.selector);
        usdg.receiveWithAuthorization(from, to, 10e6, 0, vm.getBlockTimestamp() + 60, bytes32("n"), v, r, s);
        vm.prank(to);
        usdg.receiveWithAuthorization(from, to, 10e6, 0, vm.getBlockTimestamp() + 60, bytes32("n"), v, r, s);
        assertEq(usdg.balanceOf(to), 10e6);
        assertTrue(usdg.authorizationState(from, bytes32("n")));
        vm.prank(to);
        vm.expectRevert(MockUSDG.AuthorizationAlreadyUsed.selector);
        usdg.receiveWithAuthorization(from, to, 10e6, 0, vm.getBlockTimestamp() + 60, bytes32("n"), v, r, s);
    }

    function test_receive_validityWindow() public {
        bytes32 th = usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH();
        uint256 a = vm.getBlockTimestamp() + 10;
        uint256 b = vm.getBlockTimestamp() + 20;
        (uint8 v, bytes32 r, bytes32 s) = _sign(th, to, 1, a, b, bytes32("w"));
        vm.startPrank(to);
        vm.expectRevert(MockUSDG.AuthorizationNotYetValid.selector);
        usdg.receiveWithAuthorization(from, to, 1, a, b, bytes32("w"), v, r, s);
        vm.warp(b);
        vm.expectRevert(MockUSDG.AuthorizationExpired.selector);
        usdg.receiveWithAuthorization(from, to, 1, a, b, bytes32("w"), v, r, s);
        vm.warp(a + 1);
        usdg.receiveWithAuthorization(from, to, 1, a, b, bytes32("w"), v, r, s);
        vm.stopPrank();
    }

    function test_typehashesAreNotInterchangeable() public {
        // A TransferWithAuthorization signature cannot be used through receiveWithAuthorization.
        bytes32 th = usdg.TRANSFER_WITH_AUTHORIZATION_TYPEHASH();
        (uint8 v, bytes32 r, bytes32 s) = _sign(th, to, 1, 0, vm.getBlockTimestamp() + 60, bytes32("t"));
        vm.prank(to);
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        usdg.receiveWithAuthorization(from, to, 1, 0, vm.getBlockTimestamp() + 60, bytes32("t"), v, r, s);
        usdg.transferWithAuthorization(from, to, 1, 0, vm.getBlockTimestamp() + 60, bytes32("t"), v, r, s);
        assertEq(usdg.balanceOf(to), 1);
    }

    function test_cancel() public {
        bytes32 h = keccak256(abi.encode(usdg.CANCEL_AUTHORIZATION_TYPEHASH(), from, bytes32("c")));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), h)));
        usdg.cancelAuthorization(from, bytes32("c"), v, r, s);
        bytes32 th = usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH();
        (v, r, s) = _sign(th, to, 1, 0, vm.getBlockTimestamp() + 60, bytes32("c"));
        vm.prank(to);
        vm.expectRevert(MockUSDG.AuthorizationAlreadyUsed.selector);
        usdg.receiveWithAuthorization(from, to, 1, 0, vm.getBlockTimestamp() + 60, bytes32("c"), v, r, s);
    }
}
