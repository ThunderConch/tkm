import { existsSync, readFileSync, readlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { readState, readSession } from './core/state.js';
import { readConfig, readGlobalConfig } from './core/config.js';
import { getPokemonDB, getPokemonName, getRegionName, getGenerationsDB, getDisplayName } from './core/pokemon-data.js';
import { levelToXp, xpToLevel } from './core/xp.js';
import { SPRITES_BRAILLE_DIR, SPRITES_TERMINAL_DIR, getActiveGeneration, PLUGIN_ROOT } from './core/paths.js';
import { formatBattleMessage } from './core/battle.js';
import { shiftAnsiHue } from './sprites/shiny.js';
import { isShinyKey, toBaseId } from './core/shiny-utils.js';
import { t, initLocale } from './i18n/index.js';
import { readWeatherCache, WEATHER_LABELS, type WeatherCondition } from './core/weather.js';
import { ppBar } from './core/pp.js';
import type { ExpGroup, StdinData } from './core/types.js';
import { determineTier, SPRITE_WIDTH, SPRITE_COL_WIDTH } from './core/layout.js';

interface SignatureMove {
  move: string;
  move_ko: string;
  move_en: string;
  power: number | null;
  pp: number;
  type: string;
  damage_class: string;
}

function loadSignatureMoves(): Record<string, SignatureMove> {
  const path = join(PLUGIN_ROOT, 'data', 'pokemon-signature-moves.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, SignatureMove>;
  } catch {
    return {};
  }
}

// Lazy-loaded once at module level to avoid re-parsing 9k-line JSON on every status render
const SIGNATURE_MOVES: Record<string, SignatureMove> = loadSignatureMoves();

// claude-sonnet/opus 200k, haiku 200k — hardcoded to 200k as a safe default.
// Actual remaining is approximate; PP serves as a relative pressure indicator, not exact count.
const MAX_CONTEXT = 200000;

function calcPp(maxPp: number, contextTokensUsed: number): number {
  const ratio = Math.max(0, 1 - contextTokensUsed / MAX_CONTEXT);
  return Math.max(0, Math.floor(ratio * maxPp));
}

const TYPE_EMOJI: Record<string, string> = {
  'grass': '🌿', 'fire': '🔥', 'water': '💧', 'electric': '⚡', 'fighting': '🥊',
  'steel': '⚙️', 'ground': '🏔️', 'normal': '⭐', 'flying': '🕊️', 'poison': '☠️',
  'psychic': '🔮', 'bug': '🐛', 'rock': '🪨', 'ghost': '👻',
  'dragon': '🐉', 'dark': '🌑', 'ice': '❄️', 'fairy': '✨',
};

function xpBar(currentXp: number, level: number, group: ExpGroup, blocks: number = 6): { bar: string; pct: number } {
  const currLvlXp = levelToXp(level, group);
  const nextLvlXp = levelToXp(level + 1, group);
  const xpInLevel = Math.max(0, currentXp - currLvlXp);
  const xpNeeded = Math.max(1, nextLvlXp - currLvlXp);
  const pct = Math.min(100, Math.floor(xpInLevel / xpNeeded * 100));
  const filled = Math.min(blocks, Math.floor(xpInLevel / xpNeeded * blocks));
  const empty = blocks - filled;
  return { bar: '█'.repeat(filled) + '░'.repeat(empty), pct };
}

function readStdin(): StdinData | null {
  try {
    const data = readFileSync(0, 'utf-8');
    return JSON.parse(data) as StdinData;
  } catch {
    return null;
  }
}

function getEmoji(types: string[]): string {
  return TYPE_EMOJI[types?.[0]] ?? '⭐';
}

function loadSprite(pokemonId: number, isShiny: boolean = false): string[] {
  const brailleFile = join(SPRITES_BRAILLE_DIR, `${pokemonId}.txt`);
  const terminalFile = join(SPRITES_TERMINAL_DIR, `${pokemonId}.txt`);
  const file = existsSync(brailleFile) ? brailleFile : existsSync(terminalFile) ? terminalFile : null;
  if (!file) return [];
  const lines = readFileSync(file, 'utf-8').split('\n');
  // Remove only trailing empty string from file's final newline (preserve blank sprite rows)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  // Replace regular spaces with braille blank (⠀ U+2800) so all chars have consistent font width
  const brailleLines = lines.map(line => line.replace(/ /g, '\u2800'));
  if (isShiny && brailleLines.length > 0) {
    return brailleLines.map(line => shiftAnsiHue(line));
  }
  return brailleLines;
}

function visibleLength(s: string): number {
  const stripped = s.replace(/\x1b\[[^m]*m/g, '');
  let len = 0;
  for (const ch of stripped) {
    len += charWidth(ch.codePointAt(0) ?? 0);
  }
  return len;
}

/** Get terminal column width of a single character (0, 1, or 2). */
function charWidth(cp: number): number {
  // Zero-width: variation selectors, combining marks, ZWJ
  if (
    (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0x200B && cp <= 0x200D) ||
    (cp >= 0x20D0 && cp <= 0x20FF) || cp === 0xFEFF
  ) return 0;
  // Double-width: CJK, Hangul, Emoji, Fullwidth
  if (
    (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x9FFF) ||
    (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE10 && cp <= 0xFE6F) || (cp >= 0xFF01 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F000 && cp <= 0x1FAFF) ||
    (cp >= 0x2700 && cp <= 0x27BF) || // Dingbats
    (cp >= 0x2600 && cp <= 0x26FF && cp !== 0x2605 && cp !== 0x2606) || // Misc Symbols (★☆ are 1-wide)
    (cp >= 0x20000 && cp <= 0x2FA1F)
  ) return 2;
  return 1;
}

/** Wrap a string at character boundaries to fit within maxWidth terminal columns. */
function charWrap(s: string, maxWidth: number): string {
  if (maxWidth <= 0 || visibleLength(s) <= maxWidth) return s;
  const lines: string[] = [];
  let lineLen = 0;
  let line = '';
  let remaining = s;
  const ansiRe = /\x1b\[[^m]*m/;
  while (remaining.length > 0) {
    const match = remaining.match(ansiRe);
    if (match && match.index === 0) {
      line += match[0];
      remaining = remaining.slice(match[0].length);
      continue;
    }
    const ch = remaining[0];
    const cp = ch.codePointAt(0) ?? 0;
    const w = charWidth(cp);
    if (w > 0 && lineLen + w > maxWidth) {
      lines.push(line.includes('\x1b[') ? line + '\x1b[0m' : line);
      line = '';
      lineLen = 0;
    }
    lineLen += w;
    line += ch;
    remaining = remaining.slice(1);
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function wrapPrint(parts: string[], maxWidth: number): void {
  // Try single line first
  const singleLine = parts.join(' | ');
  if (visibleLength(singleLine) <= maxWidth) {
    console.log(singleLine);
    return;
  }

  // Wrap: greedy line packing
  let currentLine = '';
  for (const part of parts) {
    const test = currentLine ? currentLine + ' | ' + part : part;
    if (currentLine && visibleLength(test) > maxWidth) {
      console.log(currentLine);
      currentLine = part;
    } else {
      currentLine = test;
    }
  }
  if (currentLine) console.log(currentLine);
}

// ── Weather particle effects ──

// Particle chars use braille (U+2800–28FF) to match sprite char width in all terminals
const WEATHER_PARTICLES: Record<WeatherCondition, { chars: string[]; color: string; density: number }> = {
  rain:         { chars: ['⠡', '⠑', '⠊', '⠉'],        color: '\x1b[34m',  density: 0.12 },
  thunderstorm: { chars: ['⠡', '⠑', '⠋', '⠛'],        color: '\x1b[33m',  density: 0.15 },
  snow:         { chars: ['⠁', '⠈', '⠐', '⠂'],        color: '\x1b[97m',  density: 0.10 },
  fog:          { chars: ['⠤', '⠤', '⠒', '⠒'],         color: '\x1b[90m',  density: 0.20 },
  sandstorm:    { chars: ['⠁', '⠂', '⠄', '⠐'],        color: '\x1b[33m',  density: 0.14 },
  clear:        { chars: ['⠁', '⠈', '⠐'],              color: '\x1b[93m',  density: 0.05 },
  cloudy:       { chars: ['⠒', '⠤', '⠶'],              color: '\x1b[90m',  density: 0.06 },
};

export function scatterWeatherParticles(line: string, condition: WeatherCondition): string {
  const fx = WEATHER_PARTICLES[condition];
  if (!fx || fx.chars.length === 0) return line;
  const RESET = '\x1b[0m';
  // Replace some \u2800 (Braille blank) chars with colored particles
  return line.replace(/\u2800/g, (match) => {
    if (Math.random() < fx.density) {
      const ch = fx.chars[Math.floor(Math.random() * fx.chars.length)];
      return `${fx.color}${ch}${RESET}`;
    }
    return match;
  });
}

function detectTermWidth(): number {
  // 1. Read per-session term-width file written by status-wrapper.mjs (if present)
  try {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? '';
    if (dataDir) {
      const pane = (process.env.TMUX_PANE ?? '').replace('%', '');
      const suffixes = [pane, ''].filter(Boolean);
      if (!pane) {
        try {
          let pid = process.ppid;
          for (let i = 0; i < 5 && pid > 1; i++) {
            try {
              const target = readlinkSync(`/proc/${pid}/fd/0`);
              if (target.startsWith('/dev/')) {
                suffixes.unshift(target.replace(/\//g, '-').replace(/^-/, ''));
                break;
              }
            } catch { /* skip */ }
            try {
              const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
              pid = parseInt(stat.split(') ')[1]?.split(' ')[1] ?? '0', 10);
            } catch { break; }
          }
        } catch { /* ignore */ }
        suffixes.push('fallback');
      }
      for (const s of suffixes) {
        const widthFile = join(dataDir, `term-width-${s}`);
        if (existsSync(widthFile)) {
          const cols = parseInt(readFileSync(widthFile, 'utf8').trim(), 10);
          if (cols > 0) return cols;
        }
      }
    }
  } catch { /* ignore */ }

  // 2. Active detection: tmux pane width query
  const tmuxPane = process.env.TMUX_PANE;
  if (tmuxPane) {
    try {
      const cols = execSync(`tmux display-message -t ${tmuxPane} -p '#{pane_width}'`, {
        encoding: 'utf8', timeout: 300, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      const n = parseInt(cols, 10);
      if (n > 0) return n;
    } catch { /* tmux not available */ }
  }

  // 3. Active detection: /dev/tty (works even when stdout is piped)
  try {
    const out = execSync('stty size < /dev/tty', {
      encoding: 'utf8', timeout: 300, shell: '/bin/sh'
    }).trim();
    const cols = parseInt(out.split(/\s+/)[1] ?? '', 10);
    if (cols > 0) return cols;
  } catch { /* /dev/tty not available */ }

  // 4. Walk ancestor proc tree for TTY fd
  try {
    let pid = process.ppid;
    for (let i = 0; i < 5 && pid > 1; i++) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/0`);
        if (target.startsWith('/dev/pts/') || target.startsWith('/dev/tty')) {
          const out = execSync(`stty size < /proc/${pid}/fd/0`, {
            encoding: 'utf8', timeout: 300, shell: '/bin/sh'
          }).trim();
          const cols = parseInt(out.split(/\s+/)[1] ?? '', 10);
          if (cols > 0) return cols;
        }
      } catch { /* skip */ }
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        pid = parseInt(stat.split(') ')[1]?.split(' ')[1] ?? '0', 10);
      } catch { break; }
    }
  } catch { /* ignore */ }

  return 0;
}

// === Battle Mode HP Bar ===
function hpBarWithColor(current: number, max: number, width: number = 10, color?: string): string {
  const ratio = Math.max(0, Math.min(1, current / max));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  // Green > 50%, Yellow > 20%, Red <= 20%
  const resolvedColor = color ?? (ratio > 0.5 ? '\x1b[32m' : ratio > 0.2 ? '\x1b[33m' : '\x1b[31m');
  return `${resolvedColor}${'█'.repeat(filled)}\x1b[90m${'░'.repeat(empty)}\x1b[0m`;
}

function hpBar(current: number, max: number, width: number = 10): string {
  return hpBarWithColor(current, max, width);
}

// === Battle Mode Renderer ===
function renderBattleMode(battleData: {
  battleState: {
    player: { pokemon: Array<{ id: number; name: string; displayName: string; types: string[]; level: number; maxHp: number; currentHp: number; fainted: boolean; statusCondition?: string | null }>; activeIndex: number };
    opponent: { pokemon: Array<{ id: number; name: string; displayName: string; types: string[]; level: number; maxHp: number; currentHp: number; fainted: boolean; statusCondition?: string | null }>; activeIndex: number };
    turn: number;
    phase: string;
    winner: string | null;
  };
  gym: { leader: string; leaderKo: string; type: string; badge: string; badgeKo: string };
  generation: string;
  sessionId?: string | null;
}): void {
  const { battleState, gym } = battleData;
  const oppMon = battleState.opponent.pokemon[battleState.opponent.activeIndex];
  const playerMon = battleState.player.pokemon[battleState.player.activeIndex];

  if (!oppMon || !playerMon) return;

  const termWidth = process.stdout.columns
    || parseInt(process.env.COLUMNS || '', 10)
    || detectTermWidth()
    || 80;
  const printWidth = Math.max(10, termWidth - 10);

  // Load sprites (skip for fainted pokemon)
  const oppFainted = oppMon.fainted || oppMon.currentHp <= 0;
  const playerFainted = playerMon.fainted || playerMon.currentHp <= 0;

  const oppSprite = oppFainted ? [] : loadSprite(oppMon.id);
  const playerSprite = playerFainted ? [] : loadSprite(playerMon.id);

  // Render sprites side by side
  const maxRows = Math.max(oppSprite.length, playerSprite.length);
  const isBlankLine = (line: string) => line.replace(/\x1b\[[^m]*m/g, '').replace(/[\s\u2800]/g, '').length === 0;

  // Find first/last non-blank rows across both sprites
  let firstRow = maxRows;
  let lastRow = 0;
  for (const sprite of [oppSprite, playerSprite]) {
    for (let r = 0; r < sprite.length; r++) {
      if (!isBlankLine(sprite[r])) {
        firstRow = Math.min(firstRow, r);
        lastRow = Math.max(lastRow, r);
      }
    }
  }

  const baseGapChars = Math.max(2, Math.floor((printWidth - SPRITE_WIDTH * 2) / 2));

  if (firstRow <= lastRow) {
    for (let row = firstRow; row <= lastRow; row++) {
      const oppLine = oppSprite[row] ?? '';
      const playerLine = playerSprite[row] ?? '';

      const oppVisible = oppLine.replace(/\x1b\[[^m]*m/g, '').length;
      const oppPadded = oppVisible < SPRITE_WIDTH ? oppLine + '\u2800'.repeat(SPRITE_WIDTH - oppVisible) : oppLine;
      const playerVisible = playerLine.replace(/\x1b\[[^m]*m/g, '').length;
      const playerPadded = playerVisible < SPRITE_WIDTH ? playerLine + '\u2800'.repeat(SPRITE_WIDTH - playerVisible) : playerLine;

      console.log(oppPadded + '\u2800'.repeat(baseGapChars) + playerPadded);
    }
  }

  // Fainted indicator
  const oppFaintedMark = oppFainted ? ` ${t('battle.fainted_label')}` : '';
  const playerFaintedMark = playerFainted ? ` ${t('battle.fainted_label')}` : '';

  // Info lines below sprites
  // Status condition indicator
  const statusLabels: Record<string, string> = {
    burn: '\x1b[31m[BRN]\x1b[0m',
    poison: '\x1b[35m[PSN]\x1b[0m',
    badly_poisoned: '\x1b[35m[TOX]\x1b[0m',
    paralysis: '\x1b[33m[PRZ]\x1b[0m',
    sleep: '\x1b[33m[SLP]\x1b[0m',
    freeze: '\x1b[36m[FRZ]\x1b[0m',
  };
  const oppStatusMark = oppMon.statusCondition ? ' ' + (statusLabels[oppMon.statusCondition] || '') : '';
  const playerStatusMark = playerMon.statusCondition ? ' ' + (statusLabels[playerMon.statusCondition] || '') : '';

  const oppInfo = `${oppMon.displayName} Lv.${oppMon.level}${oppStatusMark}${oppFaintedMark}`;
  const playerInfo = `${playerMon.displayName} Lv.${playerMon.level}${playerStatusMark}${playerFaintedMark}`;

  const oppHp = `HP ${hpBar(oppMon.currentHp, oppMon.maxHp)} ${oppMon.currentHp}/${oppMon.maxHp}`;
  const playerHp = `HP ${hpBar(playerMon.currentHp, playerMon.maxHp)} ${playerMon.currentHp}/${playerMon.maxHp}`;

  // Pad info lines to align with sprites
  const padTo = (s: string, targetWidth: number): string => {
    const vLen = visibleLength(s);
    return vLen < targetWidth ? s + ' '.repeat(targetWidth - vLen) : s;
  };

  const colWidth = SPRITE_WIDTH;
  const gapStr = ' '.repeat(Math.max(2, Math.floor((printWidth - colWidth * 2) / 2)));

  console.log(padTo(oppInfo, colWidth) + gapStr + playerInfo);
  console.log(padTo(oppHp, colWidth) + gapStr + playerHp);

  // Gym info bottom line
  const gymLine = `\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800⚔️ ${gym.leaderKo}의 체육관 — ${gym.type}`;
  console.log(charWrap(gymLine, printWidth));
}

function main(): void {
  const config = readConfig();
  initLocale(config.language ?? 'en', readGlobalConfig().voice_tone);
  const stdinData = readStdin();

  // === Battle Mode Check ===
  const battleStatePath = join(process.env.HOME || '', '.claude', 'tokenmon', 'battle-state.json');
  if (existsSync(battleStatePath)) {
    try {
      const battleData = JSON.parse(readFileSync(battleStatePath, 'utf-8'));
      const currentSessionId = process.env.CLAUDE_SESSION_ID || undefined;
      const battleSessionId = typeof battleData.sessionId === 'string' && battleData.sessionId.length > 0
        ? battleData.sessionId
        : undefined;
      const suppressBattleUi = currentSessionId !== undefined && battleSessionId !== currentSessionId;

      // Skip ended battles — fall through to normal rendering.
      const isBattleEnded = battleData.battleState?.phase === 'battle_end';

      if (!suppressBattleUi && !isBattleEnded) {
        renderBattleMode(battleData);
        process.exit(0);
      }
    } catch {
      // Invalid battle state, fall through to normal rendering
    }
  }

  if (!config.starter_chosen) {
    console.log(t('statusline.no_starter'));
    return;
  }

  if (config.party.length === 0) {
    console.log(t('statusline.party_empty'));
    return;
  }

  const state = readState();
  const session = readSession();
  const pokemonDB = getPokemonDB();
  const contextTokensUsed = state.context_tokens_used ?? 0;
  const termWidth = process.stdout.columns
    || parseInt(process.env.COLUMNS || '', 10)
    || detectTermWidth()
    || 80;

  // Helper: print text with character-level wrapping
  const printWidth = Math.max(10, termWidth - 10); // margin for Claude Code status bar padding
  const print = (s: string) => console.log(charWrap(s, printWidth));

  const spriteMode = config.sprite_mode ?? 'all';
  const infoMode = config.info_mode ?? 'ace_full';

  // Footer
  const activeGen = getActiveGeneration();
  const gensDB = getGenerationsDB();
  const genData = gensDB.generations[activeGen];
  const lang = config.language ?? 'en';
  const genRegionRaw = genData?.region_name;
  const genRegion = genRegionRaw
    ? (typeof genRegionRaw === 'string' ? genRegionRaw : genRegionRaw[lang] ?? genRegionRaw.en)
    : activeGen;
  const genOrder = genData?.order ?? 0;
  const genSuffix = lang === 'ko' ? `(${genOrder}세대)` : `(Gen ${genOrder})`;
  const regionName = getRegionName(config.current_region ?? '1');
  const pokeballs = state.items?.pokeball ?? 0;
  const itemInfo = pokeballs > 0 ? ` 🔴 ${pokeballs}` : '';
  const restInfo = state.rest_bonus ? ` 💤 ${state.rest_bonus.multiplier}×(${state.rest_bonus.turns_remaining})` : '';
  let weatherInfo = '';
  try {
    const gc = readGlobalConfig();
    if (gc.weather_enabled) {
      const cache = readWeatherCache();
      if (cache && Date.now() - cache.fetched_at < 60 * 60 * 1000) {
        const labels = WEATHER_LABELS[cache.condition as WeatherCondition];
        if (labels) weatherInfo = ` ${labels.emoji} ${labels[lang as 'en' | 'ko'] ?? labels.en}`;
      }
    }
  } catch { /* ignore */ }
  // Codex XP indicator (shown for one turn when Codex tokens contributed XP)
  const codexXp = state.last_codex_xp ?? null;
  const codexInfo = codexXp ? ` 🤖+${codexXp}xp` : '';

  // Footer adapts to tier (computed later, using a function)
  const buildFooter = (t: number) => {
    if (t >= 4) return '';                                                     // tier 4: no footer
    if (t === 3) return `📍${regionName}${itemInfo}${codexInfo}`;              // tier 3: region + balls + codex
    if (t === 2) return `🎮${genRegion} 📍${regionName}${itemInfo}${restInfo}${codexInfo}`; // tier 2
    return `🎮${genRegion} ${genSuffix} 📍${regionName}${weatherInfo}${itemInfo}${restInfo}${codexInfo}`; // tier 1
  };

  // Build per-pokemon data
  const pokeData: Array<{
    speciesId: string; name: string; level: number; xp: number; expGroup: ExpGroup;
    pokemonId: number; types: string[]; agentLabel: string;
  }> = [];

  for (const pokemonName of config.party) {
    if (!pokemonName) continue;
    const pData = pokemonDB.pokemon[toBaseId(pokemonName)];
    const assignment = session.agent_assignments.find(a => a.pokemon === pokemonName);
    const nickname = state.pokemon[pokemonName]?.nickname;
    pokeData.push({
      speciesId: pokemonName,
      name: getDisplayName(pokemonName, nickname),
      level: state.pokemon[pokemonName]?.level ?? 1,
      xp: state.pokemon[pokemonName]?.xp ?? 0,
      expGroup: pData?.exp_group ?? 'medium_fast',
      pokemonId: pData?.id ?? 0,
      types: pData?.types ?? [],
      agentLabel: assignment ? ` @${assignment.agent_id.slice(0, 6)}` : '',
    });
  }

  // === Sprite rendering (responsive 4-tier layout) ===
  // Use printWidth for tier selection so sprites fit in the same budget as text
  const tier = determineTier(printWidth, pokeData.length, spriteMode);

  if (tier <= 3) {
    const spriteEntries: string[][] = [];
    for (let i = 0; i < pokeData.length; i++) {
      const p = pokeData[i];
      // Tier 1-2: all sprites. Tier 3: ace only (i === 0)
      if (tier <= 2 || i === 0) {
        const isShinySprite = isShinyKey(p.speciesId);
        spriteEntries.push(loadSprite(p.pokemonId, isShinySprite));
      }
    }

    const isBlankLine = (line: string) => line.replace(/\x1b\[[^m]*m/g, '').replace(/[\s\u2800]/g, '').length === 0;
    const rawSpritesPerRow = Math.max(1, Math.floor(printWidth / SPRITE_COL_WIDTH));
    // Tier 2: cap to balanced rows (e.g. 3 for 6 party → 2x3, not 5+1)
    const spritesPerRow = tier === 1 ? rawSpritesPerRow
      : tier === 2 ? Math.min(rawSpritesPerRow, Math.ceil(pokeData.length / 2))
      : 1; // Tier 3: single sprite

    // Weather particle overlay — only for tier 1-2 (full sprite grids)
    let weatherCondition: WeatherCondition | null = null;
    if (tier <= 2) {
      try {
        const gc = readGlobalConfig();
        if (gc.weather_enabled) {
          const cache = readWeatherCache();
          if (cache && Date.now() - cache.fetched_at < 60 * 60 * 1000) {
            weatherCondition = cache.condition;
          }
        }
      } catch { /* ignore */ }
    }

    for (let gi = 0; gi < spriteEntries.length; gi += spritesPerRow) {
      const group = spriteEntries.slice(gi, gi + spritesPerRow);
      const maxRows = Math.max(...group.map(s => s.length), 0);
      let firstRow = maxRows, lastRow = 0;
      for (const s of group) {
        for (let r = 0; r < s.length; r++) {
          if (!isBlankLine(s[r])) { firstRow = Math.min(firstRow, r); lastRow = Math.max(lastRow, r); }
        }
      }
      for (let row = firstRow; row <= lastRow; row++) {
        let rowStr = group.map(s => {
          const line = s[row] ?? '';
          const visibleLen = line.replace(/\x1b\[[^m]*m/g, '').length;
          return visibleLen < SPRITE_WIDTH ? line + '\u2800'.repeat(SPRITE_WIDTH - visibleLen) : line;
        }).join('\u2800');
        if (weatherCondition) {
          rowStr = scatterWeatherParticles(rowStr, weatherCondition);
        }
        // Keep \u2800 (braille blank) in output instead of converting to ASCII space.
        // In some CJK terminals, non-zero braille (sprite art) and \u2800 are both
        // rendered at the same width while ASCII space is narrower — mixing them
        // causes per-row width variance proportional to sprite opacity, which is
        // invisible without weather but blatant once particles land on random cells.
        // Keeping every transparent position as \u2800 guarantees uniform row width
        // regardless of the terminal's actual braille glyph width.
        console.log(rowStr);
      }
    }
  }

  // === Achievement line (independent, always shown if present) ===
  if (state.last_achievement) {
    print(state.last_achievement);
  }

  // === Battle result / Drop / Tip line ===
  if (state.last_battle) {
    const battleMsg = formatBattleMessage(state.last_battle);
    if (battleMsg) print(battleMsg);
  } else if (state.last_drop) {
    print(state.last_drop);
  } else if (state.last_tip) {
    print(state.last_tip.text);
  }
  // Note: evolution_ready no longer shows in the status line. The Stop hook
  // emits a decision:"block" with an AskUserQuestion instruction on any stop
  // where evolution is pending, so surfacing the same pokemon twice (status
  // line + block prompt) is redundant noise.

  // === Tier preview line (independent, always shown when non-normal) ===
  if (state.pending_tier) {
    print(t(`tier.${state.pending_tier}`));
  }

  // === Info line rendering ===
  // info_mode: 'ace_full' | 'name_level' | 'all_full' | 'ace_level'
  const infoParts: string[] = [];

  for (let i = 0; i < pokeData.length; i++) {
    const p = pokeData[i];
    const isAce = i === 0;
    const { bar, pct } = xpBar(p.xp, p.level, p.expGroup);
    const emoji = getEmoji(p.types);

    const isShiny = isShinyKey(p.speciesId);
    const shinyPrefix = isShiny ? '★' : '';
    const displayName = `${shinyPrefix}${p.name}`;

    // PP = remaining context tokens expressed as move PP for ace pokemon
    const baseId = parseInt(toBaseId(p.speciesId), 10);
    const sigMove = SIGNATURE_MOVES[baseId];
    const ppFull = (isAce && sigMove && sigMove.pp > 0)
      ? ` ${sigMove.move_ko} PP:${calcPp(sigMove.pp, contextTokensUsed)}/${sigMove.pp}`
      : '';
    const ppShort = (isAce && sigMove && sigMove.pp > 0)
      ? ` PP:${calcPp(sigMove.pp, contextTokensUsed)}/${sigMove.pp}`
      : '';
    const ppSuffix = tier <= 1 ? ppFull : ppShort;

    let info: string;

    // Tier 2+: drop "Lv." prefix, just show number
    const lv = tier >= 2 ? `${p.level}` : `Lv.${p.level}`;

    if (tier === 4) {
      // Tier 4: compact emoji — "🌿 52"
      const showEmoji = spriteMode !== 'emoji_ace' || isAce;
      info = showEmoji ? `${emoji} ${lv}` : `${lv}`;
    } else if (tier === 3) {
      // Tier 3: ace compact, non-ace emoji+name+level (no sprite for them)
      info = isAce
        ? `${displayName} ${lv}${ppSuffix}${p.agentLabel}`
        : `${emoji} ${displayName} ${lv}${p.agentLabel}`;
    } else if (tier === 2) {
      // Tier 2: all name+level (sprites visible but levels aren't), ace gets PP
      info = isAce
        ? `${displayName} ${lv}${ppSuffix}${p.agentLabel}`
        : `${displayName} ${lv}${p.agentLabel}`;
    } else {
      // Tier 1 (wide): full info per info_mode
      switch (infoMode) {
        case 'all_full':
          info = `${displayName} Lv.${p.level} [${bar}] ${pct}%${ppSuffix}${p.agentLabel}`;
          break;
        case 'name_level':
          info = `${displayName} Lv.${p.level}${ppSuffix}${p.agentLabel}`;
          break;
        case 'ace_level':
          info = isAce
            ? `${displayName} Lv.${p.level}${ppSuffix}${p.agentLabel}`
            : `${displayName}${p.agentLabel}`;
          break;
        case 'ace_full':
        default:
          info = isAce
            ? `${displayName} Lv.${p.level} [${bar}] ${pct}%${ppSuffix}${p.agentLabel}`
            : `${displayName} Lv.${p.level}${p.agentLabel}`;
          break;
      }
    }
    infoParts.push(info);
  }

  if (tier <= 1 && config.pp_enabled && stdinData) {
    const pp = ppBar(stdinData);
    if (pp) infoParts.push(pp);
  }

  const footerStr = buildFooter(tier);
  if (footerStr) infoParts.push(footerStr);
  wrapPrint(infoParts, printWidth);
}

// Only run main() when invoked as entry script — avoids side effects on import
// (tests import scatterWeatherParticles directly).
const isEntryScript = import.meta.url === `file://${process.argv[1]}`;
if (isEntryScript) {
  try {
    main();
  } catch {
    // Output minimal status on crash to prevent Claude Code from breaking
    console.log('tokenmon: error');
  }
}
