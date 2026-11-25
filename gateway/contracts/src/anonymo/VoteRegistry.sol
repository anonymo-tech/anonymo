// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {StakeCredits} from "./StakeCredits.sol";
import {EverydayOwned} from "./EverydayOwned.sol";
import {EverydayTimelock} from "./EverydayTimelock.sol";

/// @notice Weekly ballots use the seven days ending at epoch start, so intra-epoch transfers cannot move votes.
contract VoteRegistry is EverydayOwned {
    enum Ballot {
        Voice,
        FeaturedCharacter,
        ModelFamily
    }

    struct Vote {
        bytes32 option;
        uint256 weight;
    }

    uint256 public constant EPOCH = 7 days;
    uint256 public constant WEIGHT_CAP_BPS = 200;
    uint256 private constant BPS = 10_000;
    StakeCredits public immutable stakeCredits;

    mapping(uint256 epoch => mapping(Ballot ballot => mapping(bytes32 option => bool))) public isOption;
    mapping(uint256 epoch => mapping(Ballot ballot => mapping(bytes32 option => uint256))) public tally;
    mapping(uint256 epoch => mapping(Ballot ballot => mapping(address voter => Vote))) public voteOf;

    event OptionRegistered(uint256 indexed epoch, Ballot indexed ballot, bytes32 indexed option);
    event Voted(
        uint256 indexed epoch, Ballot indexed ballot, address indexed voter, bytes32 option, uint256 weight
    );

    error InvalidStakeCredits();
    error InvalidOption();
    error PastEpoch();
    error NoWeight();

    constructor(StakeCredits stakeCredits_, EverydayTimelock timelock_) EverydayOwned(timelock_) {
        if (address(stakeCredits_).code.length == 0) revert InvalidStakeCredits();
        stakeCredits = stakeCredits_;
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH;
    }

    function weightOf(address voter, uint256 epoch) public view returns (uint256) {
        uint256 start = epoch * EPOCH;
        uint256 cap = Math.mulDiv(stakeCredits.totalTwabAt(start), WEIGHT_CAP_BPS, BPS);
        return Math.min(stakeCredits.twabAt(voter, start), cap);
    }

    function registerOption(uint256 epoch, Ballot ballot, bytes32 option) external onlyOwner {
        if (epoch < currentEpoch()) revert PastEpoch();
        if (option == bytes32(0) || isOption[epoch][ballot][option]) revert InvalidOption();
        isOption[epoch][ballot][option] = true;
        emit OptionRegistered(epoch, ballot, option);
    }

    function vote(Ballot ballot, bytes32 option) external {
        uint256 epoch = currentEpoch();
        if (!isOption[epoch][ballot][option]) revert InvalidOption();
        uint256 weight = weightOf(msg.sender, epoch);
        if (weight == 0) revert NoWeight();
        Vote storage previous = voteOf[epoch][ballot][msg.sender];
        if (previous.weight != 0) tally[epoch][ballot][previous.option] -= previous.weight;
        previous.option = option;
        previous.weight = weight;
        tally[epoch][ballot][option] += weight;
        emit Voted(epoch, ballot, msg.sender, option, weight);
    }
}
