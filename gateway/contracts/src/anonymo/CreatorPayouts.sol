// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EverydayPausable} from "./EverydayOwned.sol";
import {EverydayTimelock} from "./EverydayTimelock.sol";
import {EverydayFeeRouter} from "./EverydayFeeRouter.sol";

/// @notice Workers fund weekly creator shares. A sum-committed Merkle root makes every valid leaf payable
/// from its own funded week. Tips are reserved by recipient independently of the signer's allocation.
contract CreatorPayouts is EverydayPausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Node {
        bytes32 hash;
        uint256 sum;
    }

    uint256 public constant WEEK = 7 days;
    uint256 public constant HOLD = 7 days;
    bytes32 public constant EMPTY_ROOT = keccak256(abi.encode(bytes32(0), uint256(0)));

    IERC20 public immutable usdg;
    EverydayFeeRouter public immutable feeRouter;
    address public signer;

    mapping(uint256 week => bytes32) public rootOf;
    mapping(uint256 week => uint256) public funded;
    mapping(uint256 week => uint256) public claimedShares;
    mapping(uint256 week => mapping(bytes32 leaf => bool)) public claimed;
    mapping(uint256 week => mapping(address creator => uint256)) public tips;

    event SignerSet(address indexed signer);
    event Funded(uint256 indexed week, uint256 amount);
    event RootPosted(uint256 indexed week, bytes32 indexed root, uint256 total);
    event Tipped(uint256 indexed week, address indexed creator, uint256 amount);
    event Claimed(uint256 indexed week, address indexed creator, uint256 share, uint256 tipAmount);

    error InvalidAddress();
    error InvalidAmount();
    error NotWorkers();
    error NotSigner();
    error HoldActive();
    error RootExists();
    error MissingRoot();
    error InvalidRoot();
    error InvalidProof();
    error AlreadyClaimed();

    constructor(EverydayFeeRouter feeRouter_, address signer_, EverydayTimelock timelock_)
        EverydayPausable(timelock_)
    {
        if (address(feeRouter_).code.length == 0) revert InvalidAddress();
        feeRouter = feeRouter_;
        usdg = feeRouter_.usdg();
        _setSigner(signer_);
    }

    function currentWeek() public view returns (uint256) {
        return block.timestamp / WEEK;
    }

    /// @notice The worker bucket allocates the exact sum of the week's creator-share leaves.
    function fund(uint256 week, uint256 amount) external nonReentrant {
        if (msg.sender != feeRouter.workers()) revert NotWorkers();
        if (rootOf[week] != bytes32(0)) revert RootExists();
        funded[week] += amount;
        _receive(amount);
        emit Funded(week, amount);
    }

    /// @notice Finalize a week after it closes and the full hold elapses. Weeks start at Unix-epoch multiples of WEEK.
    /// Use EMPTY_ROOT for a week with tips and no worker-funded creator share.
    function postRoot(uint256 week, bytes32 root) external {
        if (msg.sender != signer) revert NotSigner();
        uint256 nowWeek = currentWeek();
        if (nowWeek < 2 || week > nowWeek - 2) revert HoldActive();
        if (rootOf[week] != bytes32(0)) revert RootExists();
        if (root == bytes32(0) || (root == EMPTY_ROOT) != (funded[week] == 0)) revert InvalidRoot();
        rootOf[week] = root;
        emit RootPosted(week, root, funded[week]);
    }

    /// @notice Escrow the whole tip for the creator in the root for the current accrual week.
    function tip(address creator, uint256 amount) external whenNotPaused nonReentrant {
        if (creator == address(0) || creator == address(this)) revert InvalidAddress();
        uint256 week = currentWeek();
        tips[week][creator] += amount;
        _receive(amount);
        emit Tipped(week, creator, amount);
    }

    /// @notice A wallet claims a share leaf and any outstanding tips, or just its tips with amount zero.
    function claim(uint256 week, uint256 amount, Node[] calldata proof) external nonReentrant {
        bytes32 root = rootOf[week];
        if (root == bytes32(0)) revert MissingRoot();
        uint256 tipAmount = tips[week][msg.sender];
        if (amount == 0) {
            if (proof.length != 0 || tipAmount == 0) revert InvalidAmount();
        } else {
            _claimShare(week, amount, proof, root);
        }
        delete tips[week][msg.sender];
        usdg.safeTransfer(msg.sender, amount + tipAmount);
        emit Claimed(week, msg.sender, amount, tipAmount);
    }

    function setSigner(address signer_) external onlyOwner {
        _setSigner(signer_);
    }

    /// @notice A leaf is the double hash of the ABI-encoded creator wallet and USDG share.
    function leafFor(address creator, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(creator, amount))));
    }

    /// @notice Pair a Merkle-sum node with its sibling, sorting by hash and then sum.
    function combine(Node memory a, Node memory b) public pure returns (Node memory) {
        if (a.hash > b.hash || (a.hash == b.hash && a.sum > b.sum)) (a, b) = (b, a);
        return Node(keccak256(abi.encode(a.hash, a.sum, b.hash, b.sum)), a.sum + b.sum);
    }

    function _claimShare(uint256 week, uint256 amount, Node[] calldata proof, bytes32 root) private {
        bytes32 leaf = leafFor(msg.sender, amount);
        if (claimed[week][leaf]) revert AlreadyClaimed();
        uint256 budget = funded[week];
        if (amount > budget - claimedShares[week]) revert InvalidAmount();
        Node memory node = Node(leaf, amount);
        for (uint256 i; i < proof.length; ++i) {
            if (proof[i].sum > budget - node.sum) revert InvalidProof();
            node = combine(node, proof[i]);
        }
        if (node.sum != budget || keccak256(abi.encode(node.hash, node.sum)) != root) revert InvalidProof();
        claimed[week][leaf] = true;
        claimedShares[week] += amount;
    }

    function _receive(uint256 amount) private {
        if (amount == 0) revert InvalidAmount();
        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        if (usdg.balanceOf(address(this)) - before != amount) revert InvalidAmount();
    }

    function _setSigner(address signer_) private {
        if (signer_ == address(0)) revert InvalidAddress();
        signer = signer_;
        emit SignerSet(signer_);
    }
}
