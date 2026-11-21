// Generated from the compiled Foundry artifacts in gateway/contracts/out (forge build, solc 0.8.26).
// Only the functions and events the gateway reads or calls are kept. Regenerate after any contract change.
// NYMO is the repo's ANMO token; USDG amounts have 6 decimals, NYMO amounts 18.

export const crewTiersAbi = [
  {
    type: "function",
    name: "tierOf",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "twabOf",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Staked",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "total",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Unstaked",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "total",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
] as const;

export const buildFuelAbi = [
  {
    type: "event",
    name: "Locked",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "total",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Unlocked",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "total",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "function",
    name: "lockedOf",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "fuelRate",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
] as const;

export const checkoutAbi = [
  {
    type: "event",
    name: "Paid",
    inputs: [
      {
        name: "orderId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "sku",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "payer",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "qty",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "currency",
        type: "uint8",
        indexed: false,
        internalType: "enum Checkout.Currency",
      },
      {
        name: "ventureId",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "function",
    name: "skuPrice",
    inputs: [
      {
        name: "sku",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
] as const;

export const recipeRegistryAbi = [
  {
    type: "function",
    name: "publish",
    inputs: [
      {
        name: "recipeHash",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "priceUsdg",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "creator",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "recipeId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "recordRun",
    inputs: [
      {
        name: "recipeId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "orderId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "RunRecorded",
    inputs: [
      {
        name: "recipeId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "orderId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "creator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "priceUsdg",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "runs",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
] as const;

export const forkFundAbi = [
  {
    type: "event",
    name: "Opened",
    inputs: [
      {
        name: "fundId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "opener",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "targetCommit",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "specHash",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "goalUsdg",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "deadline",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Contributed",
    inputs: [
      {
        name: "fundId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "contributor",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "currency",
        type: "uint8",
        indexed: false,
        internalType: "enum ForkFund.Currency",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "usdgValue",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Triggered",
    inputs: [
      {
        name: "fundId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "usdgRouted",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "nymoBurned",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "raisedUsdgValue",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Fulfilled",
    inputs: [
      {
        name: "fundId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "repoHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "receiptHash",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      {
        name: "fundId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "contributor",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "usdg",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "nymo",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "function",
    name: "fulfil",
    inputs: [
      {
        name: "fundId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "repoHash",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "receipt",
        type: "tuple",
        internalType: "struct ForkFund.CleanRoomReceipt",
        components: [
          {
            name: "targetCommit",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "repoHash",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "licenceSpdxHash",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "reportHash",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "issuedAt",
            type: "uint64",
            internalType: "uint64",
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const voteRegistryAbi = [
  {
    type: "function",
    name: "results",
    inputs: [
      {
        name: "epoch",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "kind",
        type: "uint8",
        internalType: "enum VoteRegistry.BallotKind",
      },
    ],
    outputs: [
      {
        name: "options",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
      {
        name: "tallies",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tally",
    inputs: [
      {
        name: "epoch",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "kind",
        type: "uint8",
        internalType: "enum VoteRegistry.BallotKind",
      },
      {
        name: "option",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
] as const;
