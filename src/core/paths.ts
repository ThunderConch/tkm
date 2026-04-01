import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

// Detect plugin scope from CLAUDE_PLUGIN_ROOT
// User scope: PLUGIN_ROOT is under ~/.claude/plugins/cache/
// Local scope: PLUGIN_ROOT is the project directory itself (has .claude-plugin/)
function isUserScope(): boolean {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? '';
  return root.includes('.claude/plugins/');
}

// Data directory resolution by scope:
// Explicit → $CLAUDE_PLUGIN_DATA (set by statusLine command)
// User scope  → ~/.claude/tokenmon/
// Local scope → {project}/.tokenmon/ (next to .claude-plugin/)
function resolveDataDir(): string {
  if (process.env.CLAUDE_PLUGIN_DATA) {
    return process.env.CLAUDE_PLUGIN_DATA;
  }

  if (isUserScope()) {
    return join(CLAUDE_DIR, 'tokenmon');
  }

  // Local scope: use .tokenmon/ relative to plugin root (project dir)
  // Always return the local path — postinstall/setup will create it
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dirname, '..', '..');
  return join(pluginRoot, '.tokenmon');
}

export const DATA_DIR = resolveDataDir();
export const STATE_PATH = join(DATA_DIR, 'state.json');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const SESSION_PATH = join(DATA_DIR, 'session.json');

// Plugin root (where the npm package is installed)
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dirname, '..', '..');
export const POKEMON_JSON_PATH = join(PLUGIN_ROOT, 'data', 'pokemon.json');
export const ACHIEVEMENTS_JSON_PATH = join(PLUGIN_ROOT, 'data', 'achievements.json');
export const REGIONS_JSON_PATH = join(PLUGIN_ROOT, 'data', 'regions.json');
export const CRIES_DIR = join(PLUGIN_ROOT, 'cries');
export const SPRITES_RAW_DIR = join(PLUGIN_ROOT, 'sprites', 'raw');
export const SPRITES_TERMINAL_DIR = join(PLUGIN_ROOT, 'sprites', 'terminal');
export const SPRITES_BRAILLE_DIR = join(PLUGIN_ROOT, 'sprites', 'braille');
