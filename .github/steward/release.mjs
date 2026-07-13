import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CONTRACT_VERSION = 1;
const VERSION_FILE = 'release/version.json';
const SCENARIOS = new Set(['success', 'adapter-failure', 'invalid-assets']);

function fail(message, options) {
  throw new Error(`Steward installation E2E Release adapter: ${message}`, options);
}

function parseArguments(values) {
  const [phase, ...rest] = values;
  if (phase !== 'plan' && phase !== 'build') fail('phase must be plan or build');
  if (rest.length % 2 !== 0) fail('options must use name/value pairs');

  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      fail('options must use non-empty name/value pairs');
    }
    if (options.has(name)) fail(`duplicate option: ${name}`);
    options.set(name, value);
  }

  const expected = phase === 'plan'
    ? new Set(['--context', '--output'])
    : new Set(['--context', '--output-dir', '--manifest']);
  for (const name of options.keys()) {
    if (!expected.has(name)) fail(`unsupported option: ${name}`);
  }
  for (const name of expected) {
    if (!options.has(name)) fail(`missing option: ${name}`);
  }
  return { phase, options };
}

async function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail(`unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

async function writeOutput(file, contents, label) {
  try {
    await writeFile(file, contents);
  } catch (error) {
    fail(`unable to write ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${label} contains unknown properties: ${unknown.sort().join(', ')}`);
}

function validateContext(value) {
  exactKeys(value, ['contractVersion', 'repository', 'pullRequest'], 'context');
  if (value.contractVersion !== CONTRACT_VERSION) {
    fail(`context contractVersion must equal ${CONTRACT_VERSION}`);
  }
  if (!value.repository || typeof value.repository !== 'object' || Array.isArray(value.repository)) {
    fail('context repository must be an object');
  }
  exactKeys(value.repository, ['id', 'fullName'], 'context repository');
  if (!Number.isSafeInteger(value.repository.id) || value.repository.id <= 0) {
    fail('context repository id must be positive');
  }
  if (typeof value.repository.fullName !== 'string' || !/^[^\s/]+\/[^\s/]+$/.test(value.repository.fullName)) {
    fail('context repository fullName must use owner/repository form');
  }
  if (!value.pullRequest || typeof value.pullRequest !== 'object' || Array.isArray(value.pullRequest)) {
    fail('context pullRequest must be an object');
  }
  exactKeys(value.pullRequest, ['number', 'mergeSha'], 'context pullRequest');
  if (!Number.isSafeInteger(value.pullRequest.number) || value.pullRequest.number <= 0) {
    fail('context pullRequest number must be positive');
  }
  if (typeof value.pullRequest.mergeSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.pullRequest.mergeSha)) {
    fail('context pullRequest mergeSha must be a lowercase 40-character SHA');
  }
  return value;
}

function validateConfiguration(value) {
  exactKeys(value, ['version', 'scenario'], VERSION_FILE);
  if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) {
    fail(`${VERSION_FILE} version must be a SemVer-shaped version without a leading v`);
  }
  if (!SCENARIOS.has(value.scenario)) fail(`${VERSION_FILE} scenario is unsupported`);
  return value;
}

function releasePlan(configuration, context) {
  return {
    contractVersion: CONTRACT_VERSION,
    displayVersion: configuration.version,
    buildId: `${configuration.version}+${context.pullRequest.mergeSha.slice(0, 12)}`,
    tagName: `install-e2e-v${configuration.version}`,
    releaseTitle: `Steward Installation E2E v${configuration.version}`,
  };
}

const { phase, options } = parseArguments(process.argv.slice(2));
const context = validateContext(await readJson(options.get('--context'), 'context'));
const configuration = validateConfiguration(await readJson(VERSION_FILE, VERSION_FILE));

if (phase === 'plan') {
  await writeOutput(
    options.get('--output'),
    `${JSON.stringify(releasePlan(configuration, context), null, 2)}\n`,
    'release plan',
  );
} else {
  if (configuration.scenario === 'adapter-failure') fail('controlled adapter failure fixture');

  const assetName = `steward-install-e2e-v${configuration.version}.json`;
  const asset = Buffer.from(`${JSON.stringify({
    contractVersion: CONTRACT_VERSION,
    repository: context.repository.fullName,
    pullRequest: context.pullRequest.number,
    mergeSha: context.pullRequest.mergeSha,
    version: configuration.version,
  }, null, 2)}\n`);
  await writeOutput(path.join(options.get('--output-dir'), assetName), asset, 'release asset');

  const digest = createHash('sha256').update(asset).digest('hex');
  await writeOutput(options.get('--manifest'), `${JSON.stringify({
    contractVersion: CONTRACT_VERSION,
    assets: [{
      path: assetName,
      name: assetName,
      mediaType: 'application/json',
      size: asset.length,
      sha256: configuration.scenario === 'invalid-assets' ? '0'.repeat(64) : digest,
    }],
  }, null, 2)}\n`, 'release assets manifest');
}
