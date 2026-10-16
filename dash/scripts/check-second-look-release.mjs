import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import ts from 'typescript';
export const secondLookTools = [
  'fomo',
  'token',
  'wallet',
  'signature',
  'follow',
  'plan',
  'movement',
  'tax',
  'inbox',
  'steady',
  'guarded',
  'rooms',
  'networks',
  'telegram',
  'mcp',
  'stockToken',
  'perp',
  'perpPlan',
];
export function checkSecondLookRelease(source, manifest, outerManifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.approved));
  const approved = new Set(manifest.approved);
  assert.equal(approved.size, manifest.approved.length);
  for (const name of approved)
    assert.ok(secondLookTools.includes(name), 'Unknown Second Look approval');
  const file = ts.createSourceFile(
    'releases.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(file.parseDiagnostics.length, 0);
  const declarations = file.statements
    .flatMap((s) =>
      ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [],
    )
    .filter((d) => d.name.getText(file) === 'SECOND_LOOK_SWITCHES');
  assert.equal(declarations.length, 1);
  let value = declarations[0].initializer;
  if (value && ts.isSatisfiesExpression(value)) value = value.expression;
  assert.ok(
    value && ts.isObjectLiteralExpression(value),
    'Tool switches must be literal',
  );
  const enabled = new Map();
  for (const property of value.properties) {
    assert.ok(
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name),
    );
    assert.ok(!enabled.has(property.name.text));
    assert.ok(
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(
        property.initializer.kind,
      ),
    );
    enabled.set(
      property.name.text,
      property.initializer.kind === ts.SyntaxKind.TrueKeyword,
    );
  }
  assert.deepEqual([...enabled.keys()].sort(), [...secondLookTools].sort());
  for (const [name, on] of enabled)
    assert.equal(
      on,
      approved.has(name),
      `Second Look approval mismatch: ${name}`,
    );
  assert.equal(
    outerManifest.approved.includes('secondLook'),
    approved.size > 0,
    'The suite and individual approvals must agree',
  );
  // Shared account services must have been approved as updates of their own.
  for (const tool of ['plan', 'tax', 'rooms', 'guarded'])
    if (approved.has(tool))
      assert.ok(
        approved.has('wallet'),
        `${tool} requires the approved Wallet update`,
      );
  if (approved.has('telegram'))
    for (const dependency of ['token', 'signature'])
      assert.ok(
        approved.has(dependency),
        `Telegram requires the approved ${dependency} update`,
      );
  return {
    approved: [...approved],
    held: secondLookTools.filter((t) => !approved.has(t)),
  };
}
export function checkSecondLookReleaseFiles() {
  return checkSecondLookRelease(
    readFileSync(
      new URL('../lib/second-look/releases.ts', import.meta.url),
      'utf8',
    ),
    JSON.parse(
      readFileSync(
        new URL('../second-look-releases.json', import.meta.url),
        'utf8',
      ),
    ),
    JSON.parse(
      readFileSync(
        new URL('../feature-releases.json', import.meta.url),
        'utf8',
      ),
    ),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const r = checkSecondLookReleaseFiles();
    console.log(
      `Second Look release check passed: ${r.approved.length} approved, ${r.held.length} held.`,
    );
  } catch {
    console.error('Second Look release approvals or switches are invalid.');
    process.exitCode = 1;
  }
}
