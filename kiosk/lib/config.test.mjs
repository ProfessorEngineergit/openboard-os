import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, migrate, validate, merge, redact, effectiveTheme, ORIENTATIONS } from './config.mjs';

test('defaults are valid and include the new display fields', () => {
  const config = validate(defaults());
  assert.equal(config.display.orientation, 'landscape');
  assert.equal(config.appearance.frost, 0.55);
  assert.equal(config.appearance.keyboardScale, 1);
});

test('orientation accepts the four values and nothing else', () => {
  for (const value of ORIENTATIONS) { const c = defaults(); c.display.orientation = value; validate(c); }
  const c = defaults(); c.display.orientation = 'diagonal';
  assert.throws(() => validate(c), /Ausrichtung/);
});

test('frost and keyboard scale are range checked', () => {
  let c = defaults(); c.appearance.frost = 1.2; assert.throws(() => validate(c), /Milchglas/);
  c = defaults(); c.appearance.keyboardScale = 0.2; assert.throws(() => validate(c), /Tastatur/);
  c = defaults(); c.appearance.keyboardScale = 1.6; validate(c);
});

test('v1 config migrates: urls, gemini settings and custom tabs survive', () => {
  const config = migrate({ geminiKey: 'k', geminiModel: 'gemini-x', tabs: [
    { id: 'home', name: 'HA', url: 'http://ha.local:8123/' },
    { id: 'astra', name: 'Astra', url: 'http://localhost:4180/astra' },
    { id: 'wetter', name: 'Wetter', url: 'http://wetter.local/' }] });
  assert.equal(config.gemini.key, 'k');
  assert.equal(config.apps.find(a => a.id === 'astra').url, 'http://localhost:4180/apps/astra/');
  assert.equal(config.apps.find(a => a.id === 'home').url, 'http://ha.local:8123/');
  assert(config.apps.some(a => a.id === 'wetter' && !a.builtin));
  validate(config);
});

test('secrets are redacted and arrays replace on merge', () => {
  const c = defaults(); c.astra.token = 'secret';
  assert.deepEqual(redact(c).astra.token, { set: true });
  const merged = merge(defaults(), { dock: { tiles: [] } });
  assert.deepEqual(merged.dock.tiles, []);
  assert.equal(merge({}, JSON.parse('{"__proto__":{"x":1}}')).x, undefined);
});

test('auto theme switches at the configured times', () => {
  const a = { theme: 'auto', lightFrom: '07:00', darkFrom: '19:30' };
  assert.equal(effectiveTheme(a, new Date(2026, 0, 1, 12, 0)), 'light');
  assert.equal(effectiveTheme(a, new Date(2026, 0, 1, 20, 0)), 'dark');
  assert.equal(effectiveTheme(a, new Date(2026, 0, 1, 6, 59)), 'dark');
});
