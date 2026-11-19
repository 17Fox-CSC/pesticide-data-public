import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const gate = fileURLToPath(new URL('./verify-pr-data-diff.mjs', import.meta.url));
const gitAt = cwd => (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture(change, changeBase = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-pr-diff-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = gitAt(repo);
  const put = (file, body) => writeFileSync(join(repo, file), body);
  const remove = file => unlinkSync(join(repo, file));
  function commit(name) {
    git('add', '--all');
    git('commit', '--quiet', '-m', name);
    return git('rev-parse', 'HEAD');
  }

  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'Test Fixture');
  git('config', 'user.email', 'test@example.invalid');
  for (const path of ['data', 'docs', 'scripts']) mkdirSync(join(repo, path));
  put('data/index.json', '{}\n');
  put('docs/guide.md', '# Mirror\n');
  put('scripts/check.mjs', 'export {};\n');
  const fork = commit('initial');
  changeBase({ git, put, remove });
  put('README.md', '# Base\n');
  const base = commit('advance base');
  git('switch', '--quiet', '-c', 'feature', fork);
  change({ git, put, remove });
  const head = commit('PR changes');
  git('switch', '--quiet', '-c', 'pr-merge', base);
  git('merge', '--quiet', '--no-ff', '--no-edit', head);
  const merge = git('rev-parse', 'HEAD');
  return { dir, repo, base, head, merge };
}

function run(f, { repo = f.repo, base = f.base, head = f.head, merge = f.merge } = {}) {
  const event = join(f.dir, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
  return spawnSync(process.execPath, [gate], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_SHA: merge } });
}

test('code and docs pass even when the base independently advanced data', () => {
  const f = fixture(({ put }) => {
    put('docs/guide.md', '# Improved guide\n');
    put('scripts/check.mjs', 'export const checked = true;\n');
  }, ({ put }) => put('data/index.json', '{"base":true}\n'));
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no changes under data/);
});

for (const [kind, change] of [
  ['addition', ({ put }) => put('data/new.json', '{}\n')],
  ['modification', ({ put }) => put('data/index.json', '{"current":"unapproved"}\n')],
  ['deletion', ({ remove }) => remove('data/index.json')],
  ['rename out of data', ({ git }) => git('mv', 'data/index.json', 'docs/index.json')],
  ['rename into data', ({ git }) => git('mv', 'docs/guide.md', 'data/guide.md')],
  ['rename within data', ({ git }) => git('mv', 'data/index.json', 'data/renamed.json')],
]) {
  test(`rejects a data ${kind}`, () => {
    const f = fixture(change);
    const result = run(f);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Changes under data\//);
  });
}

test('missing base, stale checkout and shallow clone fail closed', () => {
  const f = fixture(({ put }) => put('docs/guide.md', '# Code-only change\n'));
  for (const [options, pattern] of [
    [{ base: '' }, /Missing or invalid pull request/],
    [{ base: 'f'.repeat(40) }, /Needed a single revision|unknown revision|ambiguous argument/],
    [{ merge: f.head }, /Checked-out commit differs/],
  ]) {
    const result = run(f, options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
  }
  const shallow = join(f.dir, 'shallow');
  gitAt(f.dir)('clone', '--quiet', '--depth=1', pathToFileURL(f.repo).href, shallow);
  const result = run(f, { repo: shallow });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Complete Git history is required/);
});

test('rejects data changes introduced only in the merge checkout', () => {
  const f = fixture(({ put }) => put('docs/guide.md', '# Code-only change\n'));
  writeFileSync(join(f.repo, 'data/index.json'), '{"unexpected":true}\n');
  const git = gitAt(f.repo);
  git('add', 'data/index.json');
  git('commit', '--quiet', '--amend', '--no-edit');
  const result = run(f, { merge: git('rev-parse', 'HEAD') });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Changes under data\//);
});
