import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  CustodyPlanError,
  MAINNET_CUSTODY_PINS,
  validateCustodyPlan,
} from '../server/solana/custody.ts';

// Published RFC 8032 public test vectors only; no private keys are used here.
const publicKeys = [
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
  'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
].map((hex) => bs58.encode(Buffer.from(hex, 'hex')));
const fixture = () => ({
  version: 1,
  kind: 'squads-treasury-plan',
  ...MAINNET_CUSTODY_PINS,
  members: publicKeys.map((publicKey, index) => ({
    publicKey,
    custodianId: `custodian-${index + 1}`,
    independentlySupplied: true,
    permissions: 7,
  })),
  threshold: 2,
  configAuthority: null,
  spendingLimits: [],
  vaultIndex: 0,
  addresses: null,
});
// Syntactic address fixtures, deliberately not derived or deployed accounts.
const roles = () => ({
  multisigConfig: bs58.encode(new Uint8Array(32).fill(41)),
  vaultOwner: bs58.encode(new Uint8Array(32).fill(42)),
  usdcTokenAccount: bs58.encode(new Uint8Array(32).fill(43)),
});
const rejected = (change, code) => {
  const plan = fixture();
  change(plan);
  assert.throws(
    () => validateCustodyPlan(plan),
    (error) => error instanceof CustodyPlanError && error.code === code,
  );
};

void test('a valid declaration remains explicitly unverified and cannot activate deposits', () => {
  const input = fixture();
  const result = validateCustodyPlan(input);
  assert.equal(result.status, 'offline_plan_validated');
  assert.equal(result.custody, 'operator-controlled-treasury');
  for (const key of [
    'activationReady',
    'contractEnforcedEscrow',
    'custodianIndependenceVerified',
    'signingControlVerified',
    'addressDerivationsVerified',
    'onChainStateVerified',
  ])
    assert.equal(result[key], false);
  input.members[0].permissions = 1;
  assert.equal(result.plan.members[0].permissions, 7);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.plan));
  assert.ok(Object.isFrozen(result.plan.members));
  assert.ok(Object.isFrozen(result.plan.members[0]));
  assert.ok(Object.isFrozen(result.plan.spendingLimits));
});

void test('every network and program reference is pinned without fallback', () => {
  for (const key of Object.keys(MAINNET_CUSTODY_PINS))
    rejected((plan) => {
      plan[key] = 'other';
    }, 'incorrect_mainnet_pins');
  rejected((plan) => {
    plan.cluster = 'devnet';
  }, 'incorrect_mainnet_pins');
});

void test('unknown fields and malformed objects cannot smuggle authority or secrets', () => {
  for (const value of [
    null,
    [],
    true,
    'plan',
    1,
    Object.create({ version: 1 }),
  ])
    assert.throws(() => validateCustodyPlan(value), CustodyPlanError);
  rejected((plan) => {
    plan.activationReady = true;
  }, 'invalid_plan');
  rejected((plan) => {
    plan.members[0].extra = 'not echoed';
  }, 'invalid_plan');
  rejected((plan) => {
    delete plan.addresses;
  }, 'invalid_plan');
  rejected((plan) => {
    plan.kind = 'contract-escrow';
  }, 'invalid_plan');
  let accessed = false;
  const plan = fixture();
  Object.defineProperty(plan, 'threshold', {
    get() {
      accessed = true;
      return 2;
    },
  });
  assert.throws(() => validateCustodyPlan(plan), CustodyPlanError);
  assert.equal(accessed, false);
});

void test('members require canonical prime-order signing keys, not PDAs or weak points', () => {
  const badKeys = [
    '',
    publicKeys[0] + ' ',
    '0'.repeat(44),
    bs58.encode(new Uint8Array(31)),
    bs58.encode(new Uint8Array(32)),
    bs58.encode(ed25519.Point.ZERO.toBytes()),
    bs58.encode(
      ed25519.Point.BASE.add(
        ed25519.Point.fromBytes(new Uint8Array(32)),
      ).toBytes(),
    ),
    bs58.encode(new Uint8Array(32).fill(255)),
  ];
  for (const key of badKeys)
    rejected((plan) => {
      plan.members[0].publicKey = key;
    }, 'invalid_member');
});

void test('duplicate keys and repeated or missing custodian declarations fail closed', () => {
  rejected((plan) => {
    plan.members[1].publicKey = plan.members[0].publicKey;
  }, 'duplicate_member');
  rejected((plan) => {
    plan.members[1].custodianId = plan.members[0].custodianId;
  }, 'independent_custodians_required');
  for (const value of [false, 'true', null])
    rejected((plan) => {
      plan.members[0].independentlySupplied = value;
    }, 'independent_custodians_required');
  rejected((plan) => {
    plan.members[0].custodianId = 'personal label';
  }, 'independent_custodians_required');
  rejected((plan) => {
    plan.members = plan.members.slice(0, 2);
  }, 'invalid_member');
  rejected((plan) => {
    plan.members = Array(33).fill(plan.members[0]);
  }, 'invalid_member');
  rejected((plan) => {
    delete plan.members[1];
  }, 'invalid_plan');
});

void test('threshold counts only voters and requires quorum plus a spare voter', () => {
  for (const threshold of [0, 1, 3, 4, 2.5, '2', NaN])
    rejected((plan) => {
      plan.threshold = threshold;
    }, 'invalid_threshold');
  rejected((plan) => {
    plan.members[2].permissions = 5;
  }, 'invalid_threshold');
  const plan = fixture();
  plan.members[1].permissions = 2;
  plan.members[2].permissions = 2;
  assert.equal(validateCustodyPlan(plan).plan.threshold, 2);
});

void test('proposal and execution permissions must exist without unknown permission bits', () => {
  for (const permissions of [0, 8, -1, 2.5, '7', null])
    rejected((plan) => {
      plan.members[0].permissions = permissions;
    }, 'invalid_member');
  for (const permissions of [2, 3, 6])
    rejected((plan) => {
      for (const member of plan.members) member.permissions = permissions;
    }, 'missing_permissions');
});

void test('configuration authority and spending-limit bypasses are rejected', () => {
  for (const authority of [publicKeys[0], '', false, undefined])
    rejected((plan) => {
      plan.configAuthority = authority;
    }, 'consensus_bypass');
  for (const limits of [[{}], {}, null, undefined])
    rejected((plan) => {
      plan.spendingLimits = limits;
    }, 'consensus_bypass');
});

void test('address roles are all or none, distinct and never reported as derived or controlled', () => {
  const plan = fixture();
  plan.addresses = roles();
  const result = validateCustodyPlan(plan);
  assert.deepEqual(result.plan.addresses, plan.addresses);
  assert.ok(Object.isFrozen(result.plan.addresses));
  assert.equal(result.addressDerivationsVerified, false);
  assert.equal(result.onChainStateVerified, false);
  for (const value of [
    {},
    { vaultOwner: roles().vaultOwner },
    { ...roles(), vaultOwner: roles().multisigConfig },
    { ...roles(), vaultOwner: publicKeys[0] },
    { ...roles(), vaultOwner: MAINNET_CUSTODY_PINS.squadsProgram },
    { ...roles(), usdcTokenAccount: MAINNET_CUSTODY_PINS.usdcMint },
    { ...roles(), vaultOwner: '11111111111111111111111111111111' },
    { ...roles(), vaultOwner: 'invalid' },
    { ...roles(), derived: true },
  ])
    rejected((plan) => {
      plan.addresses = value;
    }, 'invalid_address_roles');
  for (const vaultIndex of [-1, 256, '0', 0.5])
    rejected((plan) => {
      plan.vaultIndex = vaultIndex;
    }, 'invalid_plan');
});

void test('validation never contacts a network and errors disclose only fixed codes', () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Network access forbidden');
  };
  try {
    assert.equal(validateCustodyPlan(fixture()).activationReady, false);
    const plan = fixture();
    plan.members[0].publicKey = 'private-input-must-not-be-echoed';
    assert.throws(
      () => validateCustodyPlan(plan),
      (error) => {
        assert.equal(error.message, 'invalid_member');
        assert.equal(error.cause, undefined);
        return error instanceof CustodyPlanError;
      },
    );
  } finally {
    globalThis.fetch = previous;
  }
});
