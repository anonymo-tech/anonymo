// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {VenturesOwned} from "./VenturesOwned.sol";
import {ICrewTiers} from "./interfaces/IVentures.sol";

/// @title VoteRegistry
/// @notice Weekly ballots for crew families and ForkFund targets.
///  - Options are bytes32 ids registered per epoch and ballot kind by the owner (the 7-day timelock, so it
///    registers a week ahead), or proposed by stakers at Gang tier or higher (one proposal per wallet per ballot).
///  - One vote per wallet per epoch per ballot kind; voting again in the same epoch moves the vote.
///  - Weight = min(the voter's CrewTiers 7-day TWAB, 2% of the total stake's 7-day TWAB), both measured over the
///    7 days that end when the epoch starts. Stake moved during an epoch therefore cannot vote twice.
/// Voting is never paused.
contract VoteRegistry is VenturesOwned {
    enum BallotKind {
        CrewFamily,
        ForkTarget
    }

    struct Vote {
        bytes32 option;
        uint256 weight;
    }

    uint256 public constant EPOCH = 7 days;
    uint256 public constant WEIGHT_CAP_BPS = 200; // 2% of total stake
    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_OPTIONS = 64;
    /// @notice Lowest CrewTiers tier that may propose options (2 = Gang, the first tier above Crew).
    uint8 public constant PROPOSER_MIN_TIER = 2;

    ICrewTiers public immutable crewTiers;
    uint256 public immutable genesis;

    mapping(bytes32 ballot => bytes32[]) private _options;
    mapping(bytes32 ballot => mapping(bytes32 option => bool)) public isOption;
    mapping(bytes32 ballot => mapping(bytes32 option => uint256)) private _tally;
    mapping(bytes32 ballot => mapping(address voter => Vote)) private _votes;
    mapping(bytes32 ballot => mapping(address proposer => bool)) public hasProposed;

    event OptionRegistered(uint256 indexed epoch, BallotKind indexed kind, bytes32 indexed option, address proposer);
    event Voted(
        uint256 indexed epoch,
        BallotKind indexed kind,
        address indexed voter,
        bytes32 option,
        uint256 weight,
        bytes32 previousOption
    );

    error ZeroAddress();
    error PastEpoch(uint256 epoch);
    error ZeroOption();
    error DuplicateOption(bytes32 option);
    error TooManyOptions();
    error TierTooLow(uint8 tier);
    error AlreadyProposed();
    error UnknownOption(bytes32 option);
    error NoWeight();
    error NotStarted();

    /// @param genesis_ Start of epoch 0 (0 = now). May not be in the future.
    constructor(ICrewTiers crewTiers_, address timelock_, uint256 genesis_) VenturesOwned(timelock_) {
        if (address(crewTiers_) == address(0)) revert ZeroAddress();
        if (genesis_ > block.timestamp) revert NotStarted();
        crewTiers = crewTiers_;
        genesis = genesis_ == 0 ? block.timestamp : genesis_;
    }

    // ---------------------------------------------------------------- options

    /// @notice Register options for a current or future ballot (owner, through the 7-day timelock).
    function registerOptions(uint256 epoch, BallotKind kind, bytes32[] calldata options) external onlyOwner {
        if (epoch < currentEpoch()) revert PastEpoch(epoch);
        bytes32 b = ballotKey(epoch, kind);
        for (uint256 i; i < options.length; ++i) {
            _add(b, epoch, kind, options[i], msg.sender);
        }
    }

    /// @notice Propose an option for a current or future ballot (stakers at Gang tier or higher, once each).
    function propose(uint256 epoch, BallotKind kind, bytes32 option) external {
        if (epoch < currentEpoch()) revert PastEpoch(epoch);
        uint8 tier = crewTiers.tierOf(msg.sender);
        if (tier < PROPOSER_MIN_TIER) revert TierTooLow(tier);
        bytes32 b = ballotKey(epoch, kind);
        if (hasProposed[b][msg.sender]) revert AlreadyProposed();
        hasProposed[b][msg.sender] = true;
        _add(b, epoch, kind, option, msg.sender);
    }

    // ---------------------------------------------------------------- voting

    /// @notice Vote for `option` in this epoch's `kind` ballot, or move an earlier vote to it.
    function vote(BallotKind kind, bytes32 option) external {
        uint256 epoch = currentEpoch();
        bytes32 b = ballotKey(epoch, kind);
        if (!isOption[b][option]) revert UnknownOption(option);
        uint256 weight = weightOf(msg.sender, epoch);
        if (weight == 0) revert NoWeight();
        Vote storage v = _votes[b][msg.sender];
        bytes32 previous = v.option;
        if (v.weight != 0) _tally[b][previous] -= v.weight;
        _tally[b][option] += weight;
        v.option = option;
        v.weight = weight;
        emit Voted(epoch, kind, msg.sender, option, weight, previous);
    }

    // ---------------------------------------------------------------- views

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - genesis) / EPOCH;
    }

    function epochStart(uint256 epoch) public view returns (uint256) {
        return genesis + epoch * EPOCH;
    }

    function ballotKey(uint256 epoch, BallotKind kind) public pure returns (bytes32) {
        return keccak256(abi.encode(epoch, kind));
    }

    /// @notice A wallet's weight in `epoch` (which must have started).
    function weightOf(address voter, uint256 epoch) public view returns (uint256) {
        uint256 start = epochStart(epoch);
        uint256 cap = (crewTiers.totalTwabAt(start) * WEIGHT_CAP_BPS) / BPS;
        return Math.min(crewTiers.twabAt(voter, start), cap);
    }

    /// @notice A ballot's options and their tallies, in registration order.
    function results(uint256 epoch, BallotKind kind)
        external
        view
        returns (bytes32[] memory options, uint256[] memory tallies)
    {
        bytes32 b = ballotKey(epoch, kind);
        options = _options[b];
        tallies = new uint256[](options.length);
        for (uint256 i; i < options.length; ++i) {
            tallies[i] = _tally[b][options[i]];
        }
    }

    function tally(uint256 epoch, BallotKind kind, bytes32 option) external view returns (uint256) {
        return _tally[ballotKey(epoch, kind)][option];
    }

    /// @notice The leading option (the earliest registered wins a tie; zero when nobody voted).
    function leader(uint256 epoch, BallotKind kind) external view returns (bytes32 option, uint256 weight) {
        bytes32 b = ballotKey(epoch, kind);
        bytes32[] storage opts = _options[b];
        for (uint256 i; i < opts.length; ++i) {
            uint256 t = _tally[b][opts[i]];
            if (t > weight) (option, weight) = (opts[i], t);
        }
    }

    function voteOf(uint256 epoch, BallotKind kind, address voter) external view returns (bytes32, uint256) {
        Vote storage v = _votes[ballotKey(epoch, kind)][voter];
        return (v.option, v.weight);
    }

    // ---------------------------------------------------------------- internal

    function _add(bytes32 b, uint256 epoch, BallotKind kind, bytes32 option, address proposer) private {
        if (option == bytes32(0)) revert ZeroOption();
        if (isOption[b][option]) revert DuplicateOption(option);
        if (_options[b].length >= MAX_OPTIONS) revert TooManyOptions();
        isOption[b][option] = true;
        _options[b].push(option);
        emit OptionRegistered(epoch, kind, option, proposer);
    }
}
