import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N_DIR = join(__dirname, '..', 'src', 'i18n');

describe('i18n parity', () => {
  it('en.json and ko.json have the same keys', () => {
    const en = JSON.parse(readFileSync(join(I18N_DIR, 'en.json'), 'utf-8'));
    const ko = JSON.parse(readFileSync(join(I18N_DIR, 'ko.json'), 'utf-8'));

    const enKeys = new Set(Object.keys(en));
    const koKeys = new Set(Object.keys(ko));

    const missingInKo = [...enKeys].filter(k => !koKeys.has(k));
    const missingInEn = [...koKeys].filter(k => !enKeys.has(k));

    const errors: string[] = [];
    if (missingInKo.length > 0) {
      errors.push(`Keys in en.json but missing in ko.json:\n  ${missingInKo.join('\n  ')}`);
    }
    if (missingInEn.length > 0) {
      errors.push(`Keys in ko.json but missing in en.json:\n  ${missingInEn.join('\n  ')}`);
    }

    assert.equal(errors.length, 0, errors.join('\n\n'));
  });

  it('no empty string values', () => {
    const en = JSON.parse(readFileSync(join(I18N_DIR, 'en.json'), 'utf-8'));
    const ko = JSON.parse(readFileSync(join(I18N_DIR, 'ko.json'), 'utf-8'));

    const emptyEn = Object.entries(en).filter(([_, v]) => v === '').map(([k]) => k);
    const emptyKo = Object.entries(ko).filter(([_, v]) => v === '').map(([k]) => k);

    const errors: string[] = [];
    if (emptyEn.length > 0) errors.push(`Empty values in en.json: ${emptyEn.join(', ')}`);
    if (emptyKo.length > 0) errors.push(`Empty values in ko.json: ${emptyKo.join(', ')}`);

    assert.equal(errors.length, 0, errors.join('\n'));
  });
});
