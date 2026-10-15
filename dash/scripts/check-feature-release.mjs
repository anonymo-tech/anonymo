import { checkSecondLookReleaseFiles } from './check-second-look-release.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const featureNames = [
  'cleanRead', 'codeClip', 'projectView', 'canvasMemory', 'libraryFilter', 'quoteReply', 'askAgain', 'projectLabels', 'tidyCanvas', 'briefStars', 'threadMap', 'runTotal', 'archiveRecovery', 'decisionDrafts', 'studioReuse', 'readingRoom', 'sendYourWay', 'decisionImport', 'decisionCompare', 'studioSearch',
  'frontRow', 'modelPanels', 'modelFinder', 'quickPhrases', 'recall', 'takeaway', 'sayIt', 'readToMe', 'pictureThis', 'paperTrail',
  'flywheel',
  'moreModels',
  'savedCouncils',
  'pdfReferences',
  'secondLook',
  'projects',
  'canvas',
  'library',
  'decisions',
  'help',
  'routes',
  'purse',
  'receipts',
  'crosscheck',
  'synthesis',
  'explainer',
  'studio',
  'chapters',
  'agents',
  'connections',
  'answerCosts',
  'answerSources',
  'onlyOneSaid',
  'blindRecord',
  'failureReasons',
  'explorerLinks',
  'shareTarget',
];

export function checkFeatureRelease(source, manifest) {
  assert.equal(manifest.schemaVersion, 1, 'Unknown feature release schema');
  assert(Array.isArray(manifest.approved), 'Missing approved feature list');
  const approved = new Set(manifest.approved);
  assert.equal(approved.size, manifest.approved.length, 'Duplicate approval');
  for (const name of approved) assert(featureNames.includes(name), 'Unknown approved feature');

  const file = ts.createSourceFile('feature-switches.ts', source, ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0, 'Invalid feature-switch syntax');
  const declarations = file.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
  ).filter((declaration) => declaration.name.getText(file) === 'FEATURE_SWITCHES');
  assert.equal(declarations.length, 1, 'Expected one FEATURE_SWITCHES declaration');
  let value = declarations[0].initializer;
  if (value && ts.isSatisfiesExpression(value)) value = value.expression;
  assert(value && ts.isObjectLiteralExpression(value), 'Switches must be a static object');
  const switches = new Map();
  for (const property of value.properties) {
    assert(ts.isPropertyAssignment(property) && ts.isIdentifier(property.name), 'Only named boolean switches are allowed');
    const name = property.name.text;
    assert(!switches.has(name), 'Duplicate feature switch');
    assert([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(property.initializer.kind), 'Switches must be literal booleans');
    switches.set(name, property.initializer.kind === ts.SyntaxKind.TrueKeyword);
  }
  assert.deepEqual([...switches.keys()].sort(), [...featureNames].sort(), 'All release switches are required');
  for (const [name, enabled] of switches) {
    assert.equal(enabled, approved.has(name), `Release approval does not match switch: ${name}`);
  }
  return { approved: [...approved], held: featureNames.filter((name) => !approved.has(name)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkFeatureRelease(
      readFileSync(new URL('../components/dashboard/feature-switches.ts', import.meta.url), 'utf8'),
      JSON.parse(readFileSync(new URL('../feature-releases.json', import.meta.url), 'utf8')),
    );
    checkSecondLookReleaseFiles();
    console.log(`Feature release check passed: ${result.approved.length} approved, ${result.held.length} held.`);
  } catch (error) {
    console.error(`Feature release check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
