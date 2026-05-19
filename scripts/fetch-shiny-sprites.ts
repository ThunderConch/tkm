#!/usr/bin/env tsx
/**
 * Download official shiny PNG sprites from PokeAPI for every species we ship.
 *
 * PokeAPI exposes `sprites.front_shiny` per /pokemon/{id} — these are the
 * exact front-facing sprites used in the games. We mirror our existing
 * `sprites/raw/{id}.png` set into `sprites/raw_shiny/{id}.png`.
 *
 * Idempotent: skips ids whose shiny PNG already exists.
 *
 * Usage: tsx scripts/fetch-shiny-sprites.ts [--max 1025]
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const RAW_DIR = join(PROJECT_ROOT, 'sprites', 'raw');
const RAW_SHINY_DIR = join(PROJECT_ROOT, 'sprites', 'raw_shiny');

const POKEAPI_BASE = 'https://pokeapi.co/api/v2';
const DELAY_MS = 50;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

async function main(): Promise<void> {
  mkdirSync(RAW_SHINY_DIR, { recursive: true });

  const maxArgIdx = process.argv.indexOf('--max');
  const cap = maxArgIdx > 0 ? parseInt(process.argv[maxArgIdx + 1], 10) : Number.POSITIVE_INFINITY;

  const rawIds = readdirSync(RAW_DIR)
    .filter(f => f.endsWith('.png'))
    .map(f => parseInt(f.replace('.png', ''), 10))
    .filter(n => Number.isFinite(n) && n <= cap)
    .sort((a, b) => a - b);

  console.log(`Fetching shiny sprites for ${rawIds.length} species...`);
  let downloaded = 0;
  let skipped = 0;
  let missing = 0;
  const errors: string[] = [];

  for (const id of rawIds) {
    const dest = join(RAW_SHINY_DIR, `${id}.png`);
    if (existsSync(dest)) {
      skipped++;
      continue;
    }
    try {
      const data = await fetchJSON(`${POKEAPI_BASE}/pokemon/${id}`);
      const url = data?.sprites?.front_shiny;
      if (!url) {
        missing++;
        process.stdout.write(`  #${id}: no front_shiny\n`);
        continue;
      }
      await downloadFile(url, dest);
      downloaded++;
      if (downloaded % 50 === 0) {
        process.stdout.write(`  ${downloaded} downloaded (current id=${id})\n`);
      }
      await sleep(DELAY_MS);
    } catch (err: any) {
      errors.push(`#${id}: ${err.message}`);
      process.stdout.write(`  #${id}: ${err.message}\n`);
    }
  }

  console.log(`\nDone. downloaded=${downloaded} skipped=${skipped} missing=${missing} errors=${errors.length}`);
  if (errors.length > 0) {
    console.log('Errors:');
    for (const e of errors) console.log(`  ${e}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
