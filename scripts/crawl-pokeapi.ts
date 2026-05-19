#!/usr/bin/env tsx
/**
 * PokeAPI Crawler for Gen 4 Pokemon (Sinnoh Dex #387-#493, 107 species)
 * Fetches: Korean names, types, base_stats, catch_rate, exp_group, evolution chains,
 *          cries (.ogg), sprites (PNG → terminal art)
 * Auto-assigns: rarity tiers, region pools, type chart
 * Idempotent: running twice produces the same output
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const CRIES_DIR = join(PROJECT_ROOT, 'cries');
const SPRITES_RAW_DIR = join(PROJECT_ROOT, 'sprites', 'raw');
const SPRITES_TERMINAL_DIR = join(PROJECT_ROOT, 'sprites', 'terminal');
const SPRITES_RAW_SHINY_DIR = join(PROJECT_ROOT, 'sprites', 'raw_shiny');
const SPRITES_TERMINAL_SHINY_DIR = join(PROJECT_ROOT, 'sprites', 'terminal_shiny');

// --- Config ---
const GEN4_START = 387;
const GEN4_END = 493;
const POKEAPI_BASE = 'https://pokeapi.co/api/v2';
const DELAY_MS = 100; // polite rate limit

// --- Korean type mapping ---
const TYPE_EN_TO_KO: Record<string, string> = {
  normal: '노말', fire: '불꽃', water: '물', electric: '전기',
  grass: '풀', ice: '얼음', fighting: '격투', poison: '독',
  ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레',
  rock: '바위', ghost: '고스트', dragon: '드래곤', dark: '악',
  steel: '강철', fairy: '페어리',
};

// --- Region assignment by primary type ---
const TYPE_TO_REGION: Record<string, string> = {
  '불꽃': '화산', '물': '해변', '풀': '숲', '바위': '광산', '땅': '광산',
  '얼음': '설산', '에스퍼': '유적', '고스트': '유적', '노말': '쌍둥이잎 마을',
  '드래곤': '챔피언 로드', '악': '챔피언 로드', '강철': '챔피언 로드',
  '전기': '발전소', '격투': '챔피언 로드', '독': '숲', '벌레': '숲',
  '비행': '쌍둥이잎 마을', '페어리': '유적',
};

// --- Exp group mapping ---
const GROWTH_RATE_MAP: Record<string, string> = {
  'medium': 'medium_fast', 'medium-fast': 'medium_fast',
  'medium-slow': 'medium_slow', 'slow': 'slow', 'fast': 'fast',
  'erratic': 'erratic', 'fluctuating': 'fluctuating',
};

// --- Type chart (Gen 4 pokemon, 18 types including Fairy from later gens) ---
const TYPE_CHART: Record<string, { strong: string[]; weak: string[]; immune: string[] }> = {
  '노말':   { strong: [],                              weak: ['바위', '강철'],                   immune: ['고스트'] },
  '불꽃':   { strong: ['풀', '얼음', '벌레', '강철'],    weak: ['불꽃', '물', '바위', '드래곤'],    immune: [] },
  '물':     { strong: ['불꽃', '땅', '바위'],            weak: ['물', '풀', '드래곤'],              immune: [] },
  '전기':   { strong: ['물', '비행'],                    weak: ['전기', '풀', '드래곤'],            immune: ['땅'] },
  '풀':     { strong: ['물', '땅', '바위'],              weak: ['불꽃', '풀', '독', '비행', '벌레', '드래곤', '강철'], immune: [] },
  '얼음':   { strong: ['풀', '땅', '비행', '드래곤'],    weak: ['불꽃', '물', '얼음', '강철'],      immune: [] },
  '격투':   { strong: ['노말', '바위', '강철', '얼음', '악'], weak: ['독', '비행', '에스퍼', '벌레'], immune: ['고스트'] },
  '독':     { strong: ['풀'],                            weak: ['독', '땅', '바위', '고스트'],      immune: ['강철'] },
  '땅':     { strong: ['불꽃', '전기', '독', '바위', '강철'], weak: ['풀', '벌레'],                 immune: ['비행'] },
  '비행':   { strong: ['풀', '격투', '벌레'],            weak: ['바위', '강철', '전기'],            immune: [] },
  '에스퍼': { strong: ['격투', '독'],                    weak: ['강철', '에스퍼'],                  immune: ['악'] },
  '벌레':   { strong: ['풀', '에스퍼', '악'],            weak: ['불꽃', '격투', '독', '비행', '고스트', '강철'], immune: [] },
  '바위':   { strong: ['불꽃', '얼음', '비행', '벌레'],  weak: ['격투', '땅', '강철'],              immune: [] },
  '고스트': { strong: ['고스트', '에스퍼'],              weak: ['악', '강철'],                      immune: ['노말'] },
  '드래곤': { strong: ['드래곤'],                        weak: ['강철'],                            immune: [] },
  '악':     { strong: ['에스퍼', '고스트'],              weak: ['격투', '악', '강철'],              immune: [] },
  '강철':   { strong: ['바위', '얼음', '페어리'],          weak: ['불꽃', '물', '전기', '강철'],      immune: [] },
  '페어리': { strong: ['격투', '드래곤', '악'],          weak: ['독', '강철', '불꽃'],              immune: [] },
};

const RARITY_WEIGHTS = {
  common: 0.55,
  uncommon: 0.30,
  rare: 0.13,
  legendary: 0.015,
  mythical: 0.005,
};

// --- Helpers ---
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJSON(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function downloadFile(url: string, dest: string): Promise<void> {
  if (existsSync(dest)) return; // idempotent
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

// --- Sprite conversion (inline from src/sprites/convert.ts) ---
function ansi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round((r - 8) / 247 * 24) + 232;
  }
  return 16 + 36 * Math.round(r / 255 * 5) + 6 * Math.round(g / 255 * 5) + Math.round(b / 255 * 5);
}

function convertPngToTerminal(pngBuffer: Buffer, width: number = 20): string {
  const img = PNG.sync.read(pngBuffer);
  const origW = img.width;
  const origH = img.height;
  let targetH = Math.round(origH * width / origW);
  if (targetH % 2 !== 0) targetH += 1;

  const getPixel = (x: number, y: number) => {
    const srcX = Math.min(Math.floor(x * origW / width), origW - 1);
    const srcY = Math.min(Math.floor(y * origH / targetH), origH - 1);
    const idx = (srcY * origW + srcX) * 4;
    return { r: img.data[idx], g: img.data[idx + 1], b: img.data[idx + 2], a: img.data[idx + 3] };
  };

  const RESET = '\x1b[0m';
  const lines: string[] = [];
  for (let y = 0; y < targetH; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const top = getPixel(x, y);
      const bot = y + 1 < targetH ? getPixel(x, y + 1) : { r: 0, g: 0, b: 0, a: 0 };
      const topT = top.a < 128;
      const botT = bot.a < 128;
      if (topT && botT) { line += ' '; }
      else if (topT) { line += `\x1b[38;5;${ansi256(bot.r, bot.g, bot.b)}m▄${RESET}`; }
      else if (botT) { line += `\x1b[38;5;${ansi256(top.r, top.g, top.b)}m▀${RESET}`; }
      else { line += `\x1b[38;5;${ansi256(top.r, top.g, top.b)}m\x1b[48;5;${ansi256(bot.r, bot.g, bot.b)}m▀${RESET}`; }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// --- Rarity assignment ---
function assignRarity(stage: number, bst: number, isLegendary: boolean, isMythical: boolean): string {
  if (isMythical) return 'mythical';
  if (isLegendary) return 'legendary';
  if (stage >= 2) return 'rare';
  if (stage === 1 || (stage === 0 && bst >= 350)) return 'uncommon';
  return 'common';
}

// --- Region assignment by primary type ---
function assignRegion(types: string[]): string {
  for (const t of types) {
    if (TYPE_TO_REGION[t]) return TYPE_TO_REGION[t];
  }
  return '쌍둥이잎 마을';
}

// --- Evolution chain parsing ---
interface EvoNode {
  species: { name: string; url: string };
  evolution_details: any[];
  evolves_to: EvoNode[];
}

function idFromUrl(url: string): number {
  return parseInt(url.split('/').filter(Boolean).pop()!);
}

/** Flatten chain into ordered list of species IDs */
function flattenChain(node: EvoNode): number[] {
  const ids: number[] = [];
  function walk(n: EvoNode) {
    ids.push(idFromUrl(n.species.url));
    for (const child of n.evolves_to) walk(child);
  }
  walk(node);
  return ids;
}

/** Find the node in the chain for a given species ID */
function findNode(node: EvoNode, targetId: number): EvoNode | null {
  if (idFromUrl(node.species.url) === targetId) return node;
  for (const child of node.evolves_to) {
    const found = findNode(child, targetId);
    if (found) return found;
  }
  return null;
}

/**
 * Get the level at which THIS pokemon evolves to its next form.
 * Returns null if it doesn't evolve by level (or doesn't evolve at all).
 */
function getEvolvesAtLevel(chain: EvoNode, sourceId: number): number | null {
  const node = findNode(chain, sourceId);
  if (!node || node.evolves_to.length === 0) return null;
  const nextEvo = node.evolves_to[0];
  const detail = nextEvo.evolution_details[0];
  return detail?.min_level ?? null;
}

/**
 * Get the special evolution condition for THIS pokemon to evolve to its next form.
 * Returns null if it evolves by level or doesn't evolve.
 */
function getEvolvesCondition(chain: EvoNode, sourceId: number): string | null {
  const node = findNode(chain, sourceId);
  if (!node || node.evolves_to.length === 0) return null;
  const nextEvo = node.evolves_to[0];
  const detail = nextEvo.evolution_details[0];
  if (!detail) return null;
  if (detail.min_level != null) return null; // level-based, not special
  if (detail.min_happiness) return 'friendship';
  if (detail.item) return `item:${detail.item.name}`;
  if (detail.held_item) return `held_item:${detail.held_item.name}`;
  if (detail.known_move) return `move:${detail.known_move.name}`;
  if (detail.known_move_type) return `move_type:${detail.known_move_type.name}`;
  if (detail.location) return `location:${detail.location.name}`;
  if (detail.trigger?.name === 'trade') return detail.held_item ? `trade_item:${detail.held_item.name}` : 'trade';
  return 'special';
}

/** Get stage index (0=base, 1=mid, 2=final) from full chain */
function getStage(chainIds: number[], targetId: number): number {
  const idx = chainIds.indexOf(targetId);
  return idx >= 0 ? idx : 0;
}

// --- Existing pokemon data (preserve unlock fields) ---
function loadExistingPokemon(): Record<string, any> {
  const path = join(DATA_DIR, 'pokemon.json');
  if (!existsSync(path)) return {};
  const db = JSON.parse(readFileSync(path, 'utf-8'));
  return db.pokemon || {};
}

// --- Main crawler ---
async function main() {
  console.log('Crawling PokeAPI for Gen 4 Pokemon (#387-#493)...\n');

  for (const dir of [DATA_DIR, CRIES_DIR, SPRITES_RAW_DIR, SPRITES_TERMINAL_DIR]) {
    mkdirSync(dir, { recursive: true });
  }

  const existingPokemon = loadExistingPokemon();
  const evoChainCache: Record<string, any> = {};
  const pokemonEntries: Record<string, any> = {};
  const nameById: Record<number, string> = {};
  const errors: string[] = [];

  // Phase 1: Fetch all pokemon data
  for (let id = GEN4_START; id <= GEN4_END; id++) {
    try {
      process.stdout.write(`  Fetching #${id}...`);

      const [pokemonData, speciesData] = await Promise.all([
        fetchJSON(`${POKEAPI_BASE}/pokemon/${id}`),
        fetchJSON(`${POKEAPI_BASE}/pokemon-species/${id}`),
      ]);

      // Korean name
      const koName = speciesData.names.find((n: any) => n.language.name === 'ko')?.name
        || speciesData.name;
      nameById[id] = koName;

      // Types in Korean
      const types = pokemonData.types
        .sort((a: any, b: any) => a.slot - b.slot)
        .map((t: any) => TYPE_EN_TO_KO[t.type.name] || t.type.name);

      // Base stats
      const statMap: Record<string, number> = {};
      for (const s of pokemonData.stats) {
        statMap[s.stat.name] = s.base_stat;
      }
      const base_stats = {
        hp: statMap['hp'] || 0,
        attack: statMap['attack'] || 0,
        defense: statMap['defense'] || 0,
        speed: statMap['speed'] || 0,
        sp_attack: statMap['special-attack'] || 0,
        sp_defense: statMap['special-defense'] || 0,
      };
      const bst = base_stats.hp + base_stats.attack + base_stats.defense + base_stats.speed
        + (statMap['special-attack'] || 0) + (statMap['special-defense'] || 0);

      const catch_rate = speciesData.capture_rate;

      // Exp group
      const growthRateName = speciesData.growth_rate?.name || 'medium-slow';
      const exp_group = GROWTH_RATE_MAP[growthRateName] || 'medium_slow';

      // Evolution chain
      const evoChainUrl = speciesData.evolution_chain?.url;
      let chainIds: number[] = [];
      let evolves_at: number | null = null;
      let evolves_condition: string | null = null;
      let stage = 0;

      if (evoChainUrl) {
        if (!evoChainCache[evoChainUrl]) {
          evoChainCache[evoChainUrl] = await fetchJSON(evoChainUrl);
        }
        const chainData = evoChainCache[evoChainUrl];
        chainIds = flattenChain(chainData.chain);
        stage = getStage(chainIds, id);

        // Get evolution info FROM this pokemon (to its next form)
        evolves_at = getEvolvesAtLevel(chainData.chain, id);
        evolves_condition = getEvolvesCondition(chainData.chain, id);
      }

      // Filter chain to Gen 4 only for the line array
      const gen4ChainIds = chainIds.filter(cid => cid >= GEN4_START && cid <= GEN4_END);

      const isLegendary = speciesData.is_legendary;
      const isMythical = speciesData.is_mythical;
      const rarity = assignRarity(stage, bst, isLegendary, isMythical);
      const region = assignRegion(types);

      // Determine unlock field - preserve existing hand-curated values
      const existingEntry = Object.values(existingPokemon).find((p: any) => p.id === id) as any;
      let unlock = existingEntry?.unlock || (stage > 0 ? 'evolution' : 'encounter');
      if (isLegendary || isMythical) unlock = 'encounter';

      const entry: any = {
        id,
        name: koName,
        types,
        stage,
        line: gen4ChainIds, // temporarily IDs, converted to names in Phase 2
        evolves_at,
        unlock,
        exp_group,
        rarity,
        region,
        base_stats,
        catch_rate,
      };

      // Add evolves_condition only if present (non-level evolution)
      if (evolves_condition) {
        entry.evolves_condition = evolves_condition;
      }

      // Preserve hand-curated evolves_condition from existing data
      if (existingEntry?.evolves_condition) {
        entry.evolves_condition = existingEntry.evolves_condition;
      }

      pokemonEntries[koName] = entry;

      // Download cry
      const cryUrl = pokemonData.cries?.latest || pokemonData.cries?.legacy;
      if (cryUrl) {
        await downloadFile(cryUrl, join(CRIES_DIR, `${id}.ogg`));
      }

      // Download sprite
      const spriteUrl = pokemonData.sprites?.front_default;
      if (spriteUrl) {
        await downloadFile(spriteUrl, join(SPRITES_RAW_DIR, `${id}.png`));
      }
      // Download shiny sprite (official game palette)
      const shinyUrl = pokemonData.sprites?.front_shiny;
      if (shinyUrl) {
        await downloadFile(shinyUrl, join(SPRITES_RAW_SHINY_DIR, `${id}.png`));
      }

      process.stdout.write(` ${koName}\n`);
      await sleep(DELAY_MS);
    } catch (err: any) {
      console.error(` Error on #${id}: ${err.message}`);
      errors.push(`#${id}: ${err.message}`);
    }
  }

  // Phase 2: Convert evolution line IDs to Korean names
  console.log('\nResolving evolution lines...');
  for (const entry of Object.values(pokemonEntries) as any[]) {
    const lineIds = entry.line as number[];
    entry.line = lineIds
      .map((lid: number) => nameById[lid])
      .filter(Boolean);
    if (entry.line.length === 0) {
      entry.line = [entry.name];
    }
  }

  // Phase 3: Convert sprites to terminal art (both regular and shiny)
  console.log('\nConverting sprites to terminal art...');
  const conversionVariants: { rawDir: string; outDir: string; label: string }[] = [
    { rawDir: SPRITES_RAW_DIR,       outDir: SPRITES_TERMINAL_DIR,       label: 'terminal' },
    { rawDir: SPRITES_RAW_SHINY_DIR, outDir: SPRITES_TERMINAL_SHINY_DIR, label: 'terminal_shiny' },
  ];
  for (const { rawDir, outDir, label } of conversionVariants) {
    if (!existsSync(rawDir)) continue;
    mkdirSync(outDir, { recursive: true });
    for (let id = GEN4_START; id <= GEN4_END; id++) {
      const rawPath = join(rawDir, `${id}.png`);
      const termPath = join(outDir, `${id}.txt`);
      if (existsSync(termPath)) continue; // idempotent
      if (!existsSync(rawPath)) continue;
      try {
        const buf = readFileSync(rawPath);
        writeFileSync(termPath, convertPngToTerminal(buf) + '\n', 'utf-8');
      } catch (err: any) {
        console.error(`  ${label} conversion failed for #${id}: ${err.message}`);
      }
    }
  }

  // Phase 4: Build type_colors
  const type_colors: Record<string, string> = {
    '풀': '\x1b[32m', '불꽃': '\x1b[31m', '물': '\x1b[34m',
    '전기': '\x1b[33m', '격투': '\x1b[91m', '강철': '\x1b[37m',
    '땅': '\x1b[33m', '노말': '\x1b[97m', '비행': '\x1b[96m',
    '독': '\x1b[35m', '에스퍼': '\x1b[95m', '벌레': '\x1b[92m',
    '바위': '\x1b[33m', '고스트': '\x1b[35m', '드래곤': '\x1b[94m',
    '악': '\x1b[90m', '얼음': '\x1b[96m',
    'reset': '\x1b[0m',
  };

  // Phase 5: Sort pokemon by ID and write
  const sortedPokemon: Record<string, any> = {};
  const sorted = Object.values(pokemonEntries).sort((a: any, b: any) => a.id - b.id);
  for (const entry of sorted) {
    sortedPokemon[(entry as any).name] = entry;
  }

  const output = {
    pokemon: sortedPokemon,
    starters: ['모부기', '불꽃숭이', '팽도리'],
    type_colors,
    type_chart: TYPE_CHART,
    rarity_weights: RARITY_WEIGHTS,
  };

  writeFileSync(join(DATA_DIR, 'pokemon.json'), JSON.stringify(output, null, 2) + '\n', 'utf-8');

  // Summary
  const count = Object.keys(sortedPokemon).length;
  const regionCounts: Record<string, number> = {};
  for (const p of Object.values(sortedPokemon) as any[]) {
    regionCounts[p.region] = (regionCounts[p.region] || 0) + 1;
  }

  console.log(`\nDone! ${count} pokemon written to data/pokemon.json`);
  console.log('\nRegion distribution:');
  for (const [region, cnt] of Object.entries(regionCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${region}: ${cnt}`);
  }

  if (errors.length > 0) {
    console.log(`\n${errors.length} errors:`);
    for (const e of errors) console.log(`  ${e}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
