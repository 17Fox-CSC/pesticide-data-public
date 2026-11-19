// A read-only check for a fully built mirror in isolated staging.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const fixed = ['manufacturers.ndjson', 'meta.json', 'registrations.ndjson'];
const files = [...fixed, 'price-history.json', 'price-latest.json', 'price-list.json', 'price-lite.json'].sort();
const diskFiles = files.flatMap(f => [f, f + '.gz']).sort();
const latestKeys = ['note', 'sourceId', 'source', 'url', 'date', 'dataDate', 'unit', 'rawUnit', 'index', 'quotes'];
const quoteKeys = ['name', 'price', 'cat', 'spec'];
const goodVersion = v => typeof v === 'string' && /^v\d{14}-[0-9a-f]{8}$/.test(v);
const goodHash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const goodDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v).toJSON()?.slice(0, 10) === v;
const sha = b => createHash('sha256').update(b).digest('hex');
const parse = path => JSON.parse(readFileSync(path));

function checked(file, pin) {
  assert.ok(goodHash(pin), `Missing or invalid SHA-256: ${file}`);
  assert.ok(lstatSync(file).isFile(), `Expected a regular file: ${file}`);
  const data = readFileSync(file);
  assert.equal(sha(data), pin, `SHA-256 mismatch: ${file}`);
  return data;
}

function pointers(dir, pins) {
  assert.ok(lstatSync(dir).isDirectory(), 'Expected a real data directory');
  const index = JSON.parse(checked(join(dir, 'index.json'), pins.indexSha256));
  const manifest = JSON.parse(checked(join(dir, 'manifest.json'), pins.manifestSha256));
  assert.ok(goodVersion(index.current) && index.current === manifest.current, 'Index and manifest current differ');
  assert.equal(manifest.history?.at(-1)?.version, index.current, 'Current version is not the history tip');
  return { index, manifest };
}

function verifyPayload(dir, version, entry, frozen) {
  assert.ok(entry?.version === version && entry.siteCount === 7 && entry.cacheCount === 0 &&
    !Object.keys(entry.cache || {}).length, `Invalid public version metadata: ${version}`);
  const versionDir = join(dir, version);
  assert.deepEqual(readdirSync(versionDir), ['site'], 'Version must contain only the public site');
  const site = join(versionDir, 'site');
  assert.ok(lstatSync(versionDir).isDirectory() && lstatSync(site).isDirectory(), 'Expected real version and site directories');
  const listed = readdirSync(site, { withFileTypes: true });
  assert.ok(listed.every(e => e.isFile()), 'Staged site files must be regular files');
  assert.deepEqual(listed.map(e => e.name).sort(), diskFiles, 'Expected exactly seven files and seven gzip companions');
  assert.deepEqual(Object.keys(entry.site).sort(), files, 'Manifest payload differs from the seven-file contract');
  let latest;
  for (const name of files) {
    const info = entry.site[name];
    const raw = checked(join(site, name), info.sha256);
    const zipped = checked(join(site, name + '.gz'), info.gzSha256);
    assert.equal(raw.length, info.bytes);
    assert.equal(zipped.length, info.gzSize);
    assert.ok(gunzipSync(zipped, { maxOutputLength: raw.length }).equals(raw), `Gzip payload differs: ${name}`);
    if (fixed.includes(name)) assert.equal(info.sha256, frozen[name], `Unapproved fixed file: ${name}`);
    if (name === 'price-latest.json') {
      latest = JSON.parse(raw);
      assert.ok(Object.keys(latest).every(k => latestKeys.includes(k)) && Array.isArray(latest.quotes) &&
        latest.quotes.length > 0 && latest.quotes.every(q => Object.keys(q).every(k => quoteKeys.includes(k))),
      'Public price-latest contains non-public fields');
      assert.ok(goodDate(latest.dataDate) && goodDate(latest.date) && latest.dataDate <= latest.date,
        'Invalid business or publication date');
    }
  }
  assert.equal(entry.mirrorDigest, sha(files.map(f => `site/${f}:${entry.site[f].sha256}`).join('\n')),
    'Mirror digest mismatch');
  return latest;
}

function verifyHistory(before, after, latest) {
  const rows = (name, key) => [parse(join(before, name))[key], parse(join(after, name))[key]];
  const appended = (old, fresh) => {
    assert.equal(fresh.length, old.length + 1, 'Expected exactly one added price issue');
    assert.deepEqual(fresh.slice(0, -1), old, 'Approved price history changed');
    assert.equal(fresh.at(-1).date, latest.date);
    assert.ok(!old.some(row => row.id === fresh.at(-1).id || row.date === latest.date), 'Duplicate price issue');
    return fresh.at(-1);
  };
  const item = appended(...rows('price-list.json', 'items'));
  const issue = appended(...rows('price-history.json', 'articles'));
  assert.equal(issue.id, item.id);
  assert.equal(issue.dataDate, latest.dataDate);
  for (const layer of ['history', 'lite']) {
    const [old, fresh] = rows(`price-${layer}.json`, 'series');
    const date = point => layer === 'history' ? point.date : point[0];
    for (const [name, series] of Object.entries(old)) {
      const next = fresh[name];
      assert.ok(next, `Removed historical series: ${name}`);
      for (const field of ['cat', 'sec', 'form']) assert.equal(next[field], series[field], `Changed historical series: ${name} ${field}`);
      assert.deepEqual(next.points.filter(point => date(point) !== latest.date), series.points,
        `Changed historical price points: ${name}`);
    }
    for (const [name, series] of Object.entries(fresh)) {
      if (!Object.hasOwn(old, name)) {
        assert.ok(series.points.every(point => date(point) === latest.date), `Unexpected historical series: ${name}`);
      }
    }
    const [oldIndices, newIndices] = rows(`price-${layer}.json`, 'indices');
    assert.deepEqual(Object.keys(newIndices).sort(), Object.keys(oldIndices).sort(), 'Price index families changed');
    for (const [name, points] of Object.entries(oldIndices)) {
      assert.deepEqual(newIndices[name].filter(point => point.date !== latest.dataDate), points, `Changed historical index: ${name}`);
    }
  }
}

export function verifyMirrorRelease({ approval, base, staging, p0Evidence }) {
  const policy = parse(new URL('./mirror-release-policy.json', import.meta.url));
  const record = readFileSync(approval);
  const approvalSha256 = sha(record);
  assert.ok(Array.isArray(policy.reviewedApprovals) && policy.reviewedApprovals.every(goodHash) &&
    policy.reviewedApprovals.includes(approvalSha256), 'No independently reviewed mirror approval matches these bytes');
  const plan = JSON.parse(record);
  assert.ok(plan.schema === 1 && ['align', 'advance'].includes(plan.action) &&
    plan.helperCommit === policy.helperCommit &&
    /^https:\/\/github\.com\/17Fox-CSC\/pesticide-data-public\/pull\/\d+#pullrequestreview-\d+$/.test(plan.review),
    'Invalid approval scope or review reference');
  assert.deepEqual(Object.keys(policy.protectedFiles).sort(), fixed);
  assert.ok(Object.values(policy.protectedFiles).every(goodHash), 'Malformed fixed-file policy');
  assert.deepEqual(plan.protectedFiles, policy.protectedFiles, 'Approval differs from fixed-file policy');
  assert.ok(checked(p0Evidence, plan.p0EvidenceSha256).length, 'Empty P0 authorization evidence');
  const head = execFileSync('git', ['-C', base, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.match(plan.base.commit, /^[a-f0-9]{40}$/);
  assert.equal(head, plan.base.commit, 'Public base commit has changed');
  const baseData = join(base, 'data');
  const source = pointers(baseData, plan.base);
  const stageData = join(staging, 'data');
  const candidate = pointers(stageData, plan.stage);

  const current = candidate.index.current;
  const previous = plan.action === 'align' ? null : source.index.current;
  const history = previous ? [previous, current] : [current];
  assert.notEqual(current, source.index.current, 'Candidate reuses the active version');
  assert.deepEqual(plan.versions, history, 'Approval has an unsafe version chain');
  assert.equal(plan.rollbackTarget, previous, 'Approval has an unsafe rollback target');
  assert.deepEqual(candidate.manifest.history.map(v => v.version), history, 'Staged history has an unsafe previous version');
  assert.deepEqual(Object.keys(candidate.manifest.versions).sort(), history.toSorted(), 'Unexpected staged manifest version');
  assert.deepEqual(readdirSync(stageData).sort(), [...history, 'index.json', 'manifest.json'].sort(),
    'Staging contains stale versions or is missing an approved version');
  const versions = candidate.manifest.versions;
  assert.equal(candidate.index.basePath, `./${current}/site`);
  assert.equal(candidate.index.sitePrefix, 'site/');
  assert.equal(candidate.index.mirrorDigest, versions[current].mirrorDigest);
  const latest = verifyPayload(stageData, current, versions[current], policy.protectedFiles);
  if (previous) {
    const baseVersions = source.manifest.history.map(v => v.version);
    assert.ok(baseVersions.length >= 1 && baseVersions.length <= 2 && new Set(baseVersions).size === baseVersions.length &&
      baseVersions.every(goodVersion), 'Active mirror has an unsafe history');
    assert.deepEqual(Object.keys(source.manifest.versions).sort(), baseVersions.toSorted(), 'Unexpected active manifest version');
    const protectedHistory = baseVersions.map(version =>
      verifyPayload(baseData, version, source.manifest.versions[version], policy.protectedFiles));
    const prior = protectedHistory.at(-1);
    assert.ok(prior.dataDate >= policy.firstMarketDate && prior.date >= policy.firstPublicationDate &&
      latest.dataDate > prior.dataDate && latest.date > prior.date, 'Stale or repeated price issue');
    verifyPayload(stageData, previous, versions[previous], policy.protectedFiles);
    assert.deepEqual(versions[previous].site, source.manifest.versions[previous].site, 'Rollback target bytes changed');
    verifyHistory(join(baseData, previous, 'site'), join(stageData, current, 'site'), latest);
  } else {
    assert.equal(latest.dataDate, policy.firstMarketDate, 'First alignment must use the approved baseline market date');
    assert.equal(latest.date, policy.firstPublicationDate, 'First alignment must use the approved baseline publication date');
  }
  return { eligible: true, approvalSha256, baseCommit: head, current, rollbackTarget: previous, publicationPerformed: false };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const [approval, base, staging, p0Evidence, ...extra] = process.argv.slice(2);
  try {
    assert.ok(approval && base && staging && p0Evidence && !extra.length,
      'Usage: node scripts/verify-mirror-release.mjs APPROVAL BASE_CHECKOUT STAGING P0_EVIDENCE');
    console.log(JSON.stringify(verifyMirrorRelease({ approval, base, staging, p0Evidence })));
  } catch (error) {
    console.error(`Mirror release ineligible: ${error.message}`);
    process.exitCode = 1;
  }
}
