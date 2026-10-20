# pesticide-data-public

Public read-only mirror for the pesticide data pipeline.

## Purpose

This repository is a **public distribution mirror**, not the source of truth.  
The private repository `17Fox-CSC/pesticide-data-sync` remains authoritative.

Only approved public-data outputs may be published here:

- `registrations.ndjson`
- `manufacturers.ndjson`
- `price-list.json`
- `price-history.json`
- `price-lite.json`
- `price-latest.json` (**sanitized public version only**)
- `meta.json`

Each approved file may also have a same-directory `.gz` companion for transport only, for example:

- `registrations.ndjson.gz`
- `price-history.json.gz`

The manifest keeps the original file `sha256` as the final content check and may additionally expose:

- `gzSha256`
- `gzSize`

Consumers should verify the gzip SHA-256 first, decompress it, and then verify the decompressed bytes against the original `sha256`. If gzip is unavailable or invalid, consumers may fall back to the original file.

Version delivery uses:

- `data/index.json`
- `data/manifest.json`
- `data/<version>/site/`

Consumers must verify SHA-256 entries in the manifest before switching versions.

## Never publish here

The following data is intentionally excluded from this public mirror:

- `chain.json`
- `chain.csv`
- `nodes.json`
- `supply-inbox.json`
- `supply-targets.json`
- `ingredients_all.json`
- `capi.json`
- `sources.json`
- `details.ndjson`
- `price-raw/`
- `reg-raw/`
- `maker-raw/`
- credentials, tokens, environment files, or secrets

For `price-latest.json`, the public mirror must remove at least:

- top-level `supplyNote`
- top-level `breadth`
- `quotes[].note`

No production schedule is enabled in this repository yet.
