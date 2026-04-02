import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { CONFIG_PATH, I18N_DATA_DIR } from './paths.js';
import type { Config } from './types.js';

const DEFAULT_CONFIG: Config = {
  tokens_per_xp: 10000,
  party: [],
  starter_chosen: false,
  volume: 0.5,
  sprite_enabled: true,
  cry_enabled: true,
  xp_formula: 'medium_fast',
  xp_bonus_multiplier: 1.0,
  max_party_size: 6,
  peon_ping_integration: false,
  peon_ping_port: 19998,
  current_region: '1',
  default_dispatch: null,
  sprite_mode: 'all',
  renderer: 'braille',
  info_mode: 'ace_full',
  tips_enabled: true,
  notifications_enabled: true,
  language: 'ko' as const,
};

function migrateConfig(config: Config): Config {
  // Quick check: does any party member or region look like a Korean name?
  const hasKorean = (s: string) => /[\uac00-\ud7a3]/.test(s);
  const needsMigration =
    config.party.some(hasKorean) ||
    hasKorean(config.current_region) ||
    (config.default_dispatch != null && hasKorean(config.default_dispatch));

  if (!needsMigration) return config;

  // Build Korean name -> ID maps from data/i18n/ko.json
  const koI18nPath = join(I18N_DATA_DIR, 'ko.json');
  if (!existsSync(koI18nPath)) return config;

  let koData: { pokemon: Record<string, string>; regions: Record<string, { name: string }> };
  try {
    koData = JSON.parse(readFileSync(koI18nPath, 'utf-8'));
  } catch {
    return config;
  }

  const nameToId: Record<string, string> = {};
  for (const [id, name] of Object.entries(koData.pokemon)) {
    nameToId[name] = id;
  }

  const regionNameToId: Record<string, string> = {};
  for (const [id, region] of Object.entries(koData.regions)) {
    regionNameToId[region.name] = id;
  }

  // Migrate config.party (Korean names -> IDs)
  if (config.party.length > 0) {
    config.party = config.party.map(name => nameToId[name] ?? name);
  }

  // Migrate config.current_region (Korean name -> ID)
  if (regionNameToId[config.current_region]) {
    config.current_region = regionNameToId[config.current_region];
  }

  // Migrate config.default_dispatch
  if (config.default_dispatch && nameToId[config.default_dispatch]) {
    config.default_dispatch = nameToId[config.default_dispatch];
  }

  return config;
}

export function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG, party: [] };
  }
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<Config>;
  const result: Config = {
    ...DEFAULT_CONFIG,
    ...parsed,
    party: parsed.party ?? [],
  };
  return migrateConfig(result);
}

export function writeConfig(config: Config): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = CONFIG_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tmpPath, CONFIG_PATH);
}

export function getDefaultConfig(): Config {
  return { ...DEFAULT_CONFIG, party: [] };
}
