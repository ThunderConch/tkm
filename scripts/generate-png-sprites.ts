#!/usr/bin/env tsx
/**
 * Pre-generate terminal graphic protocol sprites from raw PNGs.
 * Generates: kitty (.bin), sixel (.sixel), iterm2 (.b64) formats.
 *
 * Usage: tsx scripts/generate-png-sprites.ts [--renderer kitty|sixel|iterm2|all]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateKitty, generateIterm2, generateSixel } from '../src/sprites/png-protocols.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

type RendererTarget = 'kitty' | 'sixel' | 'iterm2';

const VARIANTS: { rawDir: string; suffix: string }[] = [
  { rawDir: join(PROJECT_ROOT, 'sprites', 'raw'),       suffix: '' },
  { rawDir: join(PROJECT_ROOT, 'sprites', 'raw_shiny'), suffix: '_shiny' },
];

const EXT_MAP: Record<RendererTarget, string> = { kitty: '.bin', sixel: '.sixel', iterm2: '.b64' };

function outDirFor(target: RendererTarget, suffix: string): string {
  return join(PROJECT_ROOT, 'sprites', `${target}${suffix}`);
}

function main(): void {
  const arg = process.argv[2];
  let targets: RendererTarget[];

  if (arg === '--renderer' && process.argv[3]) {
    const val = process.argv[3];
    if (val === 'all') {
      targets = ['kitty', 'sixel', 'iterm2'];
    } else if (val === 'kitty' || val === 'sixel' || val === 'iterm2') {
      targets = [val];
    } else {
      console.error(`Unknown renderer: ${val}. Use kitty, sixel, iterm2, or all.`);
      process.exit(1);
    }
  } else {
    targets = ['kitty', 'sixel', 'iterm2'];
  }

  for (const { rawDir, suffix } of VARIANTS) {
    if (!existsSync(rawDir)) {
      console.log(`Skipping suffix='${suffix}': ${rawDir} does not exist`);
      continue;
    }

    for (const target of targets) {
      mkdirSync(outDirFor(target, suffix), { recursive: true });
    }

    const files = readdirSync(rawDir).filter(f => f.endsWith('.png')).sort();
    const counts: Record<string, number> = {};

    for (const file of files) {
      const id = file.replace('.png', '');
      const pngBuf = readFileSync(join(rawDir, file));

      for (const target of targets) {
        const outPath = join(outDirFor(target, suffix), `${id}${EXT_MAP[target]}`);
        if (existsSync(outPath)) continue; // idempotent

        try {
          let data: string;
          switch (target) {
            case 'kitty':  data = generateKitty(pngBuf); break;
            case 'iterm2': data = generateIterm2(pngBuf); break;
            case 'sixel':  data = generateSixel(pngBuf); break;
          }
          writeFileSync(outPath, data, 'utf-8');
          counts[target] = (counts[target] ?? 0) + 1;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Failed ${target}${suffix}/${id}: ${msg}`);
        }
      }
    }

    for (const target of targets) {
      console.log(`Generated ${counts[target] ?? 0} ${target}${suffix} sprites (${files.length} total)`);
    }
  }
}

main();
