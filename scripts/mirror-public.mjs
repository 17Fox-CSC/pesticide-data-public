import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE = path.resolve(process.argv[2] || '_source');
const TARGET = path.resolve(process.argv[3] || '.');
const DATA = path.join(TARGET, 'data');

const PUBLIC_FILES = [
  'registrations.ndjson',
  'manufacturers.ndjson',
  'price-list.json',
  'price-history.json',
  'price-lite.json',
  'price-latest.json',
  'meta.json',
];

const sha256 = (buf) =>
  crypto.createHash('sha256').update(buf).digest('hex');

const readJson = (p) =>
  JSON.parse(fs.readFileSync(p, 'utf8'));

const validVersion = (v) =>
  /^v\d{14}-[0-9a-f]{8}$/.test(String(v || ''));

function sanitizeLatest(doc) {
  const out = {};

  for (const k of [
    'note',
    'sourceId',
    'source',
    'url',
    'date',
    'dataDate',
    'unit',
    'rawUnit',
    'index',
  ]) {
    if (doc?.[k] !== undefined) out[k] = doc[k];
  }

  out.quotes = Array.isArray(doc?.quotes)
    ? doc.quotes.map((q) => {
        const x = {};
        for (const k of ['name', 'price', 'cat', 'spec']) {
          if (q?.[k] !== undefined) x[k] = q[k];
        }
        return x;
      })
    : [];

  return out;
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const sourceIndex = readJson(
  path.join(SOURCE, 'data', 'index.json')
);

const sourceManifest = readJson(
  path.join(SOURCE, 'data', 'manifest.json')
);

const current = sourceIndex.current;

if (!validVersion(current)) {
  throw new Error(`Invalid current version: ${current}`);
}

if (!sourceManifest?.versions?.[current]) {
  throw new Error('Current version missing from source manifest');
}

const ordered = (sourceManifest.history || [])
  .map((x) => x?.version)
  .filter(validVersion);

const pos = ordered.lastIndexOf(current);

if (pos < 0) {
  throw new Error('Current version missing from source history');
}

/* 首次也保留 current + previous，保证远程 history fallback 真正可用 */
const selected =
  pos > 0
    ? [ordered[pos - 1], current]
    : [current];

fs.mkdirSync(DATA, { recursive: true });

/* 公共仓只保留当前版和前一版 */
for (const name of fs.readdirSync(DATA)) {
  const p = path.join(DATA, name);

  if (
    name.startsWith('v') &&
    fs.statSync(p).isDirectory() &&
    !selected.includes(name)
  ) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

const versions = {};
const history = [];

for (let i = 0; i < selected.length; i++) {
  const version = selected[i];
  const srcMeta = sourceManifest.versions[version];

  if (!srcMeta) {
    throw new Error(`Missing source metadata: ${version}`);
  }

  const siteDir = path.join(DATA, version, 'site');

  fs.rmSync(siteDir, { recursive: true, force: true });
  fs.mkdirSync(siteDir, { recursive: true });

  const site = {};

  for (const file of PUBLIC_FILES) {
    const src = path.join(
      SOURCE,
      'data',
      version,
      'site',
      file
    );

    if (!fs.existsSync(src)) {
      throw new Error(`Missing source file: ${version}/${file}`);
    }

    let buf = fs.readFileSync(src);

    /* 先校验私有主仓原始文件没有损坏 */
    const expected = srcMeta.site?.[file]?.sha256;

    if (!expected || sha256(buf) !== expected) {
      throw new Error(
        `Source SHA256 mismatch: ${version}/${file}`
      );
    }

    /* price-latest 对外只保留事实字段 */
    if (file === 'price-latest.json') {
      const clean = sanitizeLatest(
        JSON.parse(buf.toString('utf8'))
      );

      if (
        'supplyNote' in clean ||
        'breadth' in clean ||
        clean.quotes.some((q) => 'note' in q)
      ) {
        throw new Error(
          `price-latest sanitization failed: ${version}`
        );
      }

      buf = Buffer.from(
        JSON.stringify(clean, null, 2) + '\n',
        'utf8'
      );
    }

    atomicWrite(
      path.join(siteDir, file),
      buf
    );

    site[file] = {
      sha256: sha256(buf),
      bytes: buf.length,
    };
  }

  const mirrorDigest = sha256(
    Buffer.from(
      Object.entries(site)
        .map(([f, m]) => `site/${f}:${m.sha256}`)
        .sort()
        .join('\n')
    )
  );

  versions[version] = {
    version,
    createdAt: srcMeta.createdAt || null,
    digest: srcMeta.digest || null,
    mirrorDigest,
    counts: srcMeta.counts || {},
    siteCount: 7,
    cacheCount: 0,
    site,
    cache: {},
    supersedes: i > 0 ? selected[i - 1] : null,
  };

  history.push({
    version,
    digest: srcMeta.digest || null,
    mirrorDigest,
    counts: srcMeta.counts || {},
    at: srcMeta.createdAt || null,
  });
}

const manifest = {
  current,
  history,
  versions,
};

const cur = versions[current];

const index = {
  current,
  digest: sourceIndex.digest || cur.digest || null,
  mirrorDigest: cur.mirrorDigest,
  counts: sourceIndex.counts || cur.counts || {},
  basePath: `./${current}/site`,
  sitePrefix: 'site/',
  updatedAt: sourceIndex.updatedAt || null,
};

/* manifest 先写，pointer 最后写 */
atomicWrite(
  path.join(DATA, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);

atomicWrite(
  path.join(DATA, 'index.json'),
  JSON.stringify(index, null, 2) + '\n'
);

console.log(`Versions: ${selected.join(' -> ')}`);
console.log(`Current: ${current}`);
console.log(`Public files/version: ${PUBLIC_FILES.length}`);
console.log(`Counts: ${JSON.stringify(index.counts)}`);
