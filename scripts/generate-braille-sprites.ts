#!/usr/bin/env tsx
/**
 * Convert PNG sprites to colored Braille terminal art.
 * Braille chars encode 2×4 dots per character, giving 4x vertical resolution.
 * Each char gets ANSI 256 foreground color from dominant pixel.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// Each (input, output) pair is processed identically. Shiny variants come from
// PokeAPI sprites.front_shiny (downloaded via scripts/fetch-shiny-sprites.ts).
const VARIANTS: { rawDir: string; outDir: string; label: string }[] = [
  { rawDir: join(PROJECT_ROOT, 'sprites', 'raw'),       outDir: join(PROJECT_ROOT, 'sprites', 'braille'),       label: 'braille' },
  { rawDir: join(PROJECT_ROOT, 'sprites', 'raw_shiny'), outDir: join(PROJECT_ROOT, 'sprites', 'braille_shiny'), label: 'braille_shiny' },
];

// Braille dot positions (Unicode offset = sum of bit values)
// Col 0: dots 1,2,3,7 → bits 0,1,2,6
// Col 1: dots 4,5,6,8 → bits 3,4,5,7
const DOT_BITS = [
  [0, 3],  // row 0: dot 1, dot 4
  [1, 4],  // row 1: dot 2, dot 5
  [2, 5],  // row 2: dot 3, dot 6
  [6, 7],  // row 3: dot 7, dot 8
];

const BRAILLE_BASE = 0x2800;
const RESET = '\x1b[0m';

function ansi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round((r - 8) / 247 * 24) + 232;
  }
  return 16 + 36 * Math.round(r / 255 * 5) + 6 * Math.round(g / 255 * 5) + Math.round(b / 255 * 5);
}

function convertToBraille(pngBuffer: Buffer, targetWidth: number = 20): string {
  const img = PNG.sync.read(pngBuffer);
  const origW = img.width;
  const origH = img.height;

  // Scale to target pixel width (each braille char = 2 pixels wide)
  const pixelW = targetWidth * 2;
  const pixelH = Math.round(origH * pixelW / origW);

  const getPixel = (px: number, py: number) => {
    const srcX = Math.min(Math.floor(px * origW / pixelW), origW - 1);
    const srcY = Math.min(Math.floor(py * origH / pixelH), origH - 1);
    const idx = (srcY * origW + srcX) * 4;
    return {
      r: img.data[idx], g: img.data[idx + 1], b: img.data[idx + 2], a: img.data[idx + 3],
    };
  };

  const lines: string[] = [];

  // Each braille char covers 2 px wide × 4 px tall
  for (let by = 0; by < pixelH; by += 4) {
    let line = '';
    for (let bx = 0; bx < pixelW; bx += 2) {
      let bits = 0;
      let totalR = 0, totalG = 0, totalB = 0, colorCount = 0;

      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 2; col++) {
          const px = bx + col;
          const py = by + row;
          if (px >= pixelW || py >= pixelH) continue;

          const pixel = getPixel(px, py);
          if (pixel.a >= 128) {
            bits |= (1 << DOT_BITS[row][col]);
            totalR += pixel.r;
            totalG += pixel.g;
            totalB += pixel.b;
            colorCount++;
          }
        }
      }

      if (bits === 0) {
        line += ' ';
      } else {
        const avgR = Math.round(totalR / colorCount);
        const avgG = Math.round(totalG / colorCount);
        const avgB = Math.round(totalB / colorCount);
        const color = ansi256(avgR, avgG, avgB);
        line += `\x1b[38;5;${color}m${String.fromCodePoint(BRAILLE_BASE + bits)}${RESET}`;
      }
    }
    lines.push(line);
  }

  return lines.join('\n');
}

// Main
for (const { rawDir, outDir, label } of VARIANTS) {
  if (!existsSync(rawDir)) {
    console.log(`Skipping ${label}: ${rawDir} does not exist`);
    continue;
  }
  mkdirSync(outDir, { recursive: true });

  const files = readdirSync(rawDir).filter(f => f.endsWith('.png')).sort();
  let count = 0;

  for (const file of files) {
    const id = file.replace('.png', '');
    const outPath = join(outDir, `${id}.txt`);

    if (existsSync(outPath)) continue; // idempotent

    try {
      const buf = readFileSync(join(rawDir, file));
      const braille = convertToBraille(buf, 20);
      writeFileSync(outPath, braille + '\n', 'utf-8');
      count++;
    } catch (err: any) {
      console.error(`Failed ${label}/${id}: ${err.message}`);
    }
  }

  console.log(`Generated ${count} ${label} sprites (${files.length} total)`);
}
