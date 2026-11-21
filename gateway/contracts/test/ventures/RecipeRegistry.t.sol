// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {RecipeRegistry} from "../../src/ventures/RecipeRegistry.sol";
import {VenturesBase} from "./VenturesBase.sol";

contract RecipeRegistryTest is VenturesBase {
    address creator = makeAddr("creator");
    address other = makeAddr("other");
    bytes32 constant RECIPE = keccak256("recipe.sample");

    function setUp() public {
        _deployVentures();
        _fundUsdg(workers, 1_000e6);
    }

    function _publish() internal returns (uint256 id) {
        vm.prank(creator);
        id = recipes.publish(RECIPE, 2e6, creator);
    }

    function test_publish_byCreatorOrSigner() public {
        vm.expectEmit(address(recipes));
        emit RecipeRegistry.Published(1, RECIPE, creator, 2e6);
        assertEq(_publish(), 1);
        vm.prank(signer);
        assertEq(recipes.publish(keccak256("r2"), 1e6, creator), 2);
        vm.prank(other);
        vm.expectRevert(RecipeRegistry.NotCreatorOrSigner.selector);
        recipes.publish(keccak256("r3"), 1e6, creator);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RecipeRegistry.AlreadyPublished.selector, 1));
        recipes.publish(RECIPE, 1e6, creator);
        (bytes32 h, address c, uint256 p, uint256 runs) = recipes.recipes(1);
        assertEq(h, RECIPE);
        assertEq(c, creator);
        assertEq(p, 2e6);
        assertEq(runs, 0);
    }

    function test_recordRun_oncePerOrderAndSignerOnly() public {
        uint256 id = _publish();
        vm.prank(other);
        vm.expectRevert(RecipeRegistry.NotSigner.selector);
        recipes.recordRun(id, bytes32("o1"));
        vm.expectEmit(address(recipes));
        emit RecipeRegistry.RunRecorded(id, bytes32("o1"), creator, 2e6, 1);
        vm.prank(signer);
        recipes.recordRun(id, bytes32("o1"));
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(RecipeRegistry.RunAlreadyRecorded.selector, bytes32("o1")));
        recipes.recordRun(id, bytes32("o1"));
        vm.prank(signer);
        recipes.recordRun(id, bytes32("o2"));
        assertEq(recipes.owedOf(creator), 4e6);
        assertEq(recipes.totalOwed(), 4e6);
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(RecipeRegistry.UnknownRecipe.selector, 9));
        recipes.recordRun(9, bytes32("o3"));
    }

    function test_claim_paysUpToPoolAndNeverReverts() public {
        uint256 id = _publish();
        for (uint256 i; i < 5; ++i) {
            vm.prank(signer);
            recipes.recordRun(id, bytes32(i + 1));
        }
        // Nothing funded: pays 0, no revert.
        vm.prank(creator);
        assertEq(recipes.claim(), 0);
        vm.prank(workers);
        recipes.fund(6e6);
        _pauseAll();
        vm.prank(creator);
        assertEq(recipes.claim(), 6e6);
        assertEq(recipes.owedOf(creator), 4e6);
        vm.prank(workers);
        recipes.fund(100e6);
        vm.prank(creator);
        assertEq(recipes.claim(), 4e6);
        assertEq(usdg.balanceOf(creator), 10e6);
        assertEq(recipes.paidOf(creator), 10e6);
        vm.prank(creator);
        assertEq(recipes.claim(), 0);
        vm.prank(other);
        assertEq(recipes.claim(), 0);
    }

    function test_pause_stopsPublishOnly() public {
        uint256 id = _publish();
        vm.prank(safe);
        recipes.pause();
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        recipes.publish(keccak256("r2"), 1e6, creator);
        vm.prank(signer);
        recipes.recordRun(id, bytes32("paid-before-pause"));
        assertEq(recipes.owedOf(creator), 2e6);
    }

    function test_setSigner_throughTimelock() public {
        vm.prank(safe);
        vm.expectRevert();
        recipes.setSigner(other);
        _viaTimelock(address(recipes), abi.encodeCall(RecipeRegistry.setSigner, (other)));
        assertEq(recipes.signer(), other);
    }
}
