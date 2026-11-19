// The pull_request checkout must be GitHub's merge of the event's exact base and head.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const commitSha = /^[a-f0-9]{40}$/;

try {
  assert.equal(process.env.GITHUB_EVENT_NAME, 'pull_request', 'Expected a GitHub pull request event');
  const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = pr?.base?.sha;
  const head = pr?.head?.sha;
  assert.ok(commitSha.test(base) && commitSha.test(head), 'Missing or invalid pull request base/head SHA');
  assert.equal(git('rev-parse', '--is-shallow-repository'), 'false', 'Complete Git history is required');
  for (const sha of [base, head]) {
    assert.equal(git('rev-parse', '--verify', sha + '^{commit}'), sha, 'PR commit is unavailable');
  }
  const checkout = git('rev-parse', 'HEAD');
  assert.equal(checkout, process.env.GITHUB_SHA, 'Checked-out commit differs from the event merge commit');
  assert.deepEqual(git('show', '-s', '--format=%P', checkout).split(' '), [base, head],
    'Merge checkout does not match the event base and head');

  const ancestor = git('merge-base', '--all', base, head);
  assert.match(ancestor, commitSha, 'Expected exactly one merge base');

  // Check the PR file set and its effect on the base. Disabling rename
  // detection exposes both sides of a rename as a deletion and an addition.
  for (const [before, after] of [[ancestor, head], [base, checkout]]) {
    const result = spawnSync('git', ['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--no-renames',
      before, after, '--', ':(top,literal)data'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.ok(result.status === 0 || result.status === 1, 'Could not determine data changes');
    assert.equal(result.status, 0, 'Changes under data/ require a separately reviewed release path');
  }
  console.log('Verified the pull request introduces no changes under data/.');
} catch (error) {
  console.error(`PR data gate refused: ${error.message}`);
  process.exitCode = 1;
}
