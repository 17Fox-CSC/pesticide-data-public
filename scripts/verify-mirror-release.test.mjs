import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));
const productionCli = join(here, 'verify-mirror-release.mjs');
const builder = join(here, 'mirror-public.mjs');
const A = 'v20261101000000-aaaaaaaa';
const B = 'v20261109000000-bbbbbbbb';
const OLD = 'v20261027020308-b7c97104';
const helperCommit = 'fb2cbb49a17f8acd0e8db511265e7313e8b905d5';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = doc => Buffer.from(JSON.stringify(doc) + '\n');
const put = (path, doc) => writeFileSync(path, encode(doc));
const read = path => JSON.parse(readFileSync(path));
const frozen = {
  'registrations.ndjson': '{"test":"approved registration"}\n',
  'manufacturers.ndjson': '{"test":"approved manufacturer"}\n',
  'meta.json': '{"test":"approved metadata"}\n',
};
const protectedFiles = Object.fromEntries(Object.entries(frozen).map(([file, bytes]) => [file, sha(bytes)]));

function prices(issues) {
  const tip = issues.at(-1);
  const points = issues.map(i => ({ date: i.date, dataDate: i.dataDate, id: i.id, price: 1.2 }));
  const index = { 综合: issues.map(i => ({ date: i.dataDate, v: 75 })) };
  const series = p => ({ 示例药: { points: p } });
  return {
    'price-list.json': encode({ items: issues }),
    'price-history.json': encode({ articles: issues, series: series(points), indices: index }),
    'price-lite.json': encode({ series: series(points.map(p => [p.date, p.price, ''])), indices: index }),
    'price-latest.json': encode({ date: tip.date, dataDate: tip.dataDate, breadth: 'omit me', supplyNote: 'omit me',
      quotes: [{ name: '示例药', price: 12000, cat: '除草剂', spec: '90%', note: 'omit me' }] }),
  };
}
const baselineIssue = { id: 11378460, date: '2026-11-01', dataDate: '2026-11-01' };
const nextIssue = { id: 11394297, date: '2026-11-09', dataDate: '2026-11-08' };

function makeMirror(dir, timeline) {
  const source = mkdtempSync(join(dir, 'source-'));
  const staging = mkdtempSync(join(dir, 'mirror-'));
  const data = join(source, 'data');
  mkdirSync(data);
  const versions = {};
  for (const { version, issues, locked } of timeline) {
    const site = join(data, version, 'site');
    mkdirSync(site, { recursive: true });
    const payload = { ...locked, ...prices(issues) };
    const metadata = Object.fromEntries(Object.entries(payload).map(([name, bytes]) => {
      writeFileSync(join(site, name), bytes);
      return [name, { sha256: sha(bytes) }];
    }));
    versions[version] = { site: metadata, digest: sha(version), createdAt: '2026-11-19T00:00:00Z' };
  }
  const current = timeline.at(-1).version;
  put(join(data, 'index.json'), { current, digest: versions[current].digest });
  put(join(data, 'manifest.json'), { history: timeline.map(({ version }) => ({ version })), versions });
  execFileSync(process.execPath, [builder, source, staging]);
  return staging;
}

function gitBase(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', 'data');
  git('-c', 'user.name=Mirror Test', '-c', 'user.email=mirror-test@example.invalid', 'commit', '-qm', 'Test fixture');
  return git('rev-parse', 'HEAD');
}

const AInput = { version: A, issues: [baselineIssue], locked: frozen };
const BInput = { version: B, issues: [baselineIssue, nextIssue], locked: frozen };
const oldInput = { version: OLD, issues: [{ id: 3, date: '2026-09-30', dataDate: '2026-09-27' }],
  locked: { ...frozen, 'registrations.ndjson': '{"test":"unapproved"}\n' } };

function fixture(action) {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-release-'));
  const base = makeMirror(dir, [action === 'align' ? oldInput : AInput]);
  const baseCommit = gitBase(base);
  const cli = join(dir, 'verify-mirror-release.mjs');
  const policy = join(dir, 'mirror-release-policy.json');
  copyFileSync(productionCli, cli);
  const approval = join(dir, 'SIMULATED-approval.json');
  const p0Evidence = join(dir, 'SIMULATED-p0.txt');
  writeFileSync(p0Evidence, 'Test-only P0 authorization placeholder.\n');
  function mockApproval(stage, versions, overrides = {}) {
    const pins = path => ({
      indexSha256: sha(readFileSync(join(path, 'data/index.json'))),
      manifestSha256: sha(readFileSync(join(path, 'data/manifest.json'))),
    });
    const record = {
      schema: 1, action, helperCommit, protectedFiles,
      review: 'https://github.com/17Fox-CSC/pesticide-data-public/pull/99999999#pullrequestreview-99999999',
      p0EvidenceSha256: sha(readFileSync(p0Evidence)), base: { commit: baseCommit, ...pins(base) },
      stage: pins(stage), versions, rollbackTarget: versions.length === 2 ? versions[0] : null,
      ...overrides,
    };
    put(approval, record);
    put(policy, { helperCommit, firstMarketDate: '2026-11-01', firstPublicationDate: '2026-11-01',
      protectedFiles, reviewedApprovals: [sha(readFileSync(approval))] });
  }
  return { dir, base, cli, approval, p0Evidence, mockApproval };
}

function snapshot(data) {
  return Object.fromEntries(readdirSync(data, { withFileTypes: true }).map(entry => {
    const p = join(data, entry.name);
    return [entry.name, entry.isDirectory() ? snapshot(p) : sha(readFileSync(p))];
  }));
}
function check(f, stage, { deny, cli = f.cli } = {}) {
  const before = [snapshot(join(f.base, 'data')), snapshot(join(stage, 'data'))];
  const result = spawnSync(process.execPath, [cli, f.approval, f.base, stage, f.p0Evidence], { encoding: 'utf8' });
  assert.equal(result.status, deny ? 1 : 0, result.stderr + result.stdout);
  assert.deepEqual([snapshot(join(f.base, 'data')), snapshot(join(stage, 'data'))], before);
  if (deny) assert.match(result.stderr, deny);
  return deny ? undefined : JSON.parse(result.stdout);
}

test('schedule and manual are read-only; pushing this workflow cannot trigger the legacy publisher', () => {
  const workflow = readFileSync(join(here, '../.github/workflows/mirror.yml'), 'utf8');
  assert.match(workflow, /^  schedule:/m);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /^  contents: read$/m);
  assert.doesNotMatch(workflow, /contents: write|git (?:push|commit|add)|PRIVATE_SOURCE_PAT|mirror-public\.mjs|pull_request_target/);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 2);
});

test('first alignment accepts [A] only under simulation; shipping policy refuses the same bytes', () => {
  const f = fixture('align');
  const stage = makeMirror(f.dir, [AInput]);
  assert.deepEqual(read(join(stage, 'data/manifest.json')).history.map(x => x.version), [A]);
  f.mockApproval(stage, [A]);
  assert.deepEqual({ ...check(f, stage), approvalSha256: 'checked' }, {
    eligible: true, approvalSha256: 'checked', baseCommit: read(f.approval).base.commit,
    current: A, rollbackTarget: null, publicationPerformed: false,
  });
  check(f, stage, { cli: productionCli, deny: /No independently reviewed/ });
  put(f.approval, { ...read(f.approval), forged: true });
  check(f, stage, { deny: /No independently reviewed/ });
  assert.throws(() => readFileSync(join(f.dir, 'missing-approval.json')), /ENOENT/);
  check({ ...f, approval: join(f.dir, 'missing-approval.json') }, stage, { deny: /ENOENT/ });
});

test('advance accepts [A,B] with byte-identical A and a new issue', () => {
  const f = fixture('advance');
  const stage = makeMirror(f.dir, [AInput, BInput]);
  f.mockApproval(stage, [A, B]);
  assert.equal(check(f, stage).rollbackTarget, A);
  const first = read(join(stage, 'data', B, 'site/price-latest.json'));
  assert.deepEqual(first.quotes, [{ name: '示例药', price: 12000, cat: '除草剂', spec: '90%' }]);
  assert.ok(!('supplyNote' in first) && !('breadth' in first));
});

test('refuses old private versions, unsafe predecessors, and repeated pricing', () => {
  const f = fixture('advance');
  const stale = makeMirror(f.dir, [oldInput, AInput]);
  f.mockApproval(stale, [OLD, A]);
  check(f, stale, { deny: /Candidate reuses the active version/ });

  const mixed = makeMirror(f.dir, [oldInput, BInput]);
  f.mockApproval(mixed, [A, B]);
  check(f, mixed, { deny: /Staged history has an unsafe previous version/ });

  const repeated = makeMirror(f.dir, [AInput, { ...BInput, issues: [baselineIssue] }]);
  f.mockApproval(repeated, [A, B]);
  check(f, repeated, { deny: /Stale or repeated price issue/ });

  const different = makeMirror(f.dir, [AInput, { ...BInput, locked: oldInput.locked }]);
  f.mockApproval(different, [A, B]);
  check(f, different, { deny: /Unapproved fixed file/ });
});

test('rejects initial old fallback, hidden directories, and missing rollback files', () => {
  const first = fixture('align');
  const mixed = makeMirror(first.dir, [oldInput, AInput]);
  first.mockApproval(mixed, [A]);
  check(first, mixed, { deny: /Staged history has an unsafe previous version/ });

  const stage = makeMirror(first.dir, [AInput]);
  cpSync(join(first.base, 'data', OLD), join(stage, 'data', OLD), { recursive: true });
  first.mockApproval(stage, [A]);
  check(first, stage, { deny: /Staging contains stale versions/ });

  const f = fixture('advance');
  const advanced = makeMirror(f.dir, [AInput, BInput]);
  renameSync(join(advanced, 'data', A), join(f.dir, 'removed-approved-rollback'));
  f.mockApproval(advanced, [A, B]);
  check(f, advanced, { deny: /missing an approved version/ });
});

test('binds base commit, index, manifest, P0 evidence and both levels of gzip verification', () => {
  const f = fixture('advance');
  const stage = makeMirror(f.dir, [AInput, BInput]);
  f.mockApproval(stage, [A, B], { base: { commit: '0'.repeat(40) } });
  check(f, stage, { deny: /Public base commit has changed/ });
  f.mockApproval(stage, [A, B]);
  for (const path of [f.p0Evidence, join(f.base, 'data/index.json'), join(stage, 'data/manifest.json')]) {
    const before = readFileSync(path);
    writeFileSync(path, Buffer.concat([before, Buffer.from(' ')]));
    check(f, stage, { deny: /SHA-256 mismatch/ });
    writeFileSync(path, before);
  }
  const comp = gzipSync('other bytes');
  writeFileSync(join(stage, 'data', B, 'site/price-latest.json.gz'), comp);
  check(f, stage, { deny: /SHA-256 mismatch/ });
  const manifest = join(stage, 'data/manifest.json');
  const m = read(manifest);
  m.versions[B].site['price-latest.json'].gzSha256 = sha(comp);
  m.versions[B].site['price-latest.json'].gzSize = comp.length;
  put(manifest, m);
  f.mockApproval(stage, [A, B]);
  check(f, stage, { deny: /Gzip payload differs/ });
});

test('rejects a rewritten rollback version and history rewritten in the new current version', () => {
  const f = fixture('advance');
  const dirtyA = { ...AInput, issues: [{ ...baselineIssue, extra: 'changed' }] };
  const changedPrevious = makeMirror(f.dir, [dirtyA, BInput]);
  f.mockApproval(changedPrevious, [A, B]);
  check(f, changedPrevious, { deny: /Rollback target bytes changed/ });

  const dirtyB = { ...BInput, issues: [...dirtyA.issues, nextIssue] };
  const changedHistory = makeMirror(f.dir, [AInput, dirtyB]);
  f.mockApproval(changedHistory, [A, B]);
  check(f, changedHistory, { deny: /Approved price history changed/ });
});
