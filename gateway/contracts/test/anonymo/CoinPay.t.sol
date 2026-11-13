// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";
import {CoinPay} from "../../src/anonymo/CoinPay.sol";
import {ICoinPay} from "../../src/anonymo/interfaces/IAnonymo.sol";

contract CoinPayTest is Test {
    bytes32 constant PAID_TOPIC = keccak256("Paid(bytes32,address,uint256)");
    ANMO anmo;
    CoinPay pay;
    uint256 aliceKey = 0xA11CE;
    address alice;
    bytes32 commit = keccak256("key");

    function setUp() public {
        alice = vm.addr(aliceKey);
        anmo = new ANMO(address(this));
        pay = new CoinPay(address(anmo));
        anmo.transfer(alice, 1_000e18);
    }

    function test_eventSignatureIsFixed() public pure {
        assertEq(ICoinPay.Paid.selector, PAID_TOPIC);
    }

    function test_payBurnsAndEmits() public {
        uint256 supply = anmo.totalSupply();
        vm.startPrank(alice);
        anmo.approve(address(pay), 250e18);
        vm.expectEmit(true, true, false, true, address(pay));
        emit ICoinPay.Paid(commit, alice, 250e18);
        pay.pay(250e18, commit);
        vm.stopPrank();
        assertEq(anmo.balanceOf(alice), 750e18);
        assertEq(anmo.balanceOf(address(pay)), 0);
        assertEq(anmo.totalSupply(), supply - 250e18);
        assertEq(anmo.allowance(alice, address(pay)), 0);
    }

    function testFuzz_payNeverHoldsCoins(uint256 amount) public {
        amount = bound(amount, 1, 1_000e18);
        uint256 supply = anmo.totalSupply();
        vm.startPrank(alice);
        anmo.approve(address(pay), amount);
        pay.pay(amount, commit);
        vm.stopPrank();
        assertEq(anmo.balanceOf(address(pay)), 0);
        assertEq(anmo.totalSupply(), supply - amount);
    }

    function test_rejectsZeroEmptyAndUnapproved() public {
        vm.startPrank(alice);
        vm.expectRevert(CoinPay.ZeroAmount.selector);
        pay.pay(0, commit);
        vm.expectRevert(CoinPay.EmptyKeyCommit.selector);
        pay.pay(1, bytes32(0));
        vm.expectRevert(); // no allowance
        pay.pay(1, commit);
        vm.stopPrank();
    }

    function test_cannotBurnSomeoneElsesCoins() public {
        vm.prank(alice);
        anmo.approve(address(pay), 100e18);
        // Bob calls pay: burnFrom(bob) needs bob's allowance, never alice's.
        vm.prank(makeAddr("bob"));
        vm.expectRevert();
        pay.pay(100e18, commit);
        assertEq(anmo.balanceOf(alice), 1_000e18);
    }

    function _permit(uint256 amount, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                alice,
                address(pay),
                amount,
                anmo.nonces(alice),
                deadline
            )
        );
        (v, r, s) = vm.sign(aliceKey, keccak256(abi.encodePacked("\x19\x01", anmo.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_payWithPermit() public {
        (uint8 v, bytes32 r, bytes32 s) = _permit(40e18, block.timestamp + 1 hours);
        vm.prank(alice);
        pay.payWithPermit(40e18, commit, block.timestamp + 1 hours, v, r, s);
        assertEq(anmo.balanceOf(alice), 960e18);
    }

    function test_payWithPermit_frontRunPermitStillPays() public {
        (uint8 v, bytes32 r, bytes32 s) = _permit(40e18, block.timestamp + 1 hours);
        anmo.permit(alice, address(pay), 40e18, block.timestamp + 1 hours, v, r, s); // someone submits it first
        vm.prank(alice);
        pay.payWithPermit(40e18, commit, block.timestamp + 1 hours, v, r, s);
        assertEq(anmo.balanceOf(alice), 960e18);
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(CoinPay.ZeroAddress.selector);
        new CoinPay(address(0));
    }
}
