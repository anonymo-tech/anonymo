// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ANMO} from "../../src/anonymo/ANMO.sol";

contract ANMOTest is Test {
    ANMO anmo;
    address treasury = makeAddr("treasury");

    function setUp() public {
        anmo = new ANMO(treasury);
    }

    function test_constructor() public view {
        assertEq(anmo.name(), "Anonymo");
        assertEq(anmo.symbol(), "ANMO");
        assertEq(anmo.decimals(), 18);
        assertEq(anmo.totalSupply(), 1_000_000_000e18);
        assertEq(anmo.TOTAL_SUPPLY(), 1_000_000_000e18);
        assertEq(anmo.balanceOf(treasury), anmo.TOTAL_SUPPLY());
    }

    function test_constructor_rejectsZeroRecipient() public {
        vm.expectRevert(ANMO.ZeroAddress.selector);
        new ANMO(address(0));
    }

    /// No mint and no owner exist after deploy; holders can burn only their own coins (or with an allowance).
    function test_noMintNoOwnerAndBurnLowersSupply() public {
        bytes4[3] memory sels =
            [bytes4(keccak256("mint(address,uint256)")), bytes4(keccak256("mint(uint256)")), bytes4(keccak256("owner()"))];
        for (uint256 i; i < sels.length; ++i) {
            (bool ok,) = address(anmo).call(abi.encodeWithSelector(sels[i], treasury, 1));
            assertFalse(ok);
        }
        vm.prank(treasury);
        anmo.burn(5e18);
        assertEq(anmo.totalSupply(), anmo.TOTAL_SUPPLY() - 5e18);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        anmo.burnFrom(treasury, 1);
    }

    function test_permit() public {
        uint256 key = 0xB0B;
        address bob = vm.addr(key);
        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp + 1;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                bob,
                spender,
                7e18,
                anmo.nonces(bob),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", anmo.DOMAIN_SEPARATOR(), structHash)));
        anmo.permit(bob, spender, 7e18, deadline, v, r, s);
        assertEq(anmo.allowance(bob, spender), 7e18);
    }

    function testFuzz_transfersNeverChangeSupply(address to, uint256 amount) public {
        vm.assume(to != address(0));
        amount = bound(amount, 0, anmo.TOTAL_SUPPLY());
        vm.prank(treasury);
        anmo.transfer(to, amount);
        assertEq(anmo.totalSupply(), anmo.TOTAL_SUPPLY());
    }
}
