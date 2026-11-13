// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Backend §9. The receipts signer posts one Merkle root per UTC hour; roots are never overwritten.
interface IReceiptRoots {
    event RootPosted(uint64 indexed hour, bytes32 root);
    event SignerSet(address indexed signer);

    error NotSigner();
    error EmptyRoot();
    error FutureHour();
    error RootExists(uint64 hour);

    function post(uint64 hour, bytes32 root) external; // receipts signer only
    function rootOf(uint64 hour) external view returns (bytes32);
}

/// @notice Backend §9. Stablecoin deposits forwarded straight to the treasury Safe.
interface IDepositRouter {
    /// @dev WS05's watcher decodes exactly this signature. Do not change it.
    event Deposited(bytes32 indexed keyCommit, address indexed token, address indexed payer, uint256 amount);

    function deposit(address token, uint256 amount, bytes32 keyCommit) external;
    function depositWithPermit(
        address token,
        uint256 amount,
        bytes32 keyCommit,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice Backend §9. Stake ANMO for a daily API credit allowance.
interface ICreditPass {
    function stake(uint256 amount) external;
    function requestUnstake() external;
    function withdraw() external; // after cooldown; never pausable
    /// @return microUsdPerDay Daily credit from the active stake (0 while nothing is staked or after
    /// `requestUnstake`).
    /// @return rolloverCapMicroUsd The most unused credit that can carry over: 3 days of allowance.
    function allowanceOf(address user) external view returns (uint256 microUsdPerDay, uint256 rolloverCapMicroUsd);
}

/// @notice Receives the stakers' 5% share from the FeeRouter as API credit.
interface IStakerCredit {
    function totalStaked() external view returns (uint256);
    function notifyCredit(uint256 amount) external;
}

interface ICoinPay {
    /// @notice `amount` coins were burned from `payer` to pay for the API key behind `keyCommit`.
    event Paid(bytes32 indexed keyCommit, address indexed payer, uint256 amount);

    /// @notice Burn `amount` of the caller's coins (needs an allowance) for the key behind `keyCommit`.
    function pay(uint256 amount, bytes32 keyCommit) external;

    /// @notice As `pay`, setting the allowance with an EIP-2612 permit in the same call.
    function payWithPermit(uint256 amount, bytes32 keyCommit, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
