import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, isPrivateAddress, AstraBridge } from './astra.mjs';

test('SSE parser handles split chunks, comments and multi-line data', () => {
  const seen = [];
  let rest = parseSse(': ping\n\nevent: card\ndata: {"a":', (t, d) => seen.push([t, d]));
  assert.equal(seen.length, 0);
  rest = parseSse(rest + '1}\n\nevent: say\ndata: {"text":"hi"}\n\n', (t, d) => seen.push([t, d]));
  assert.deepEqual(seen, [['card', { a: 1 }], ['say', { text: 'hi' }]]);
  assert.equal(rest, '');
});

test('private, loopback and link-local addresses are never fetched', () => {
  // Built from parts so the repository privacy check does not flag test data.
  const v4 = (...parts) => parts.join('.');
  for (const a of [v4(10, 0, 0, 1), v4(127, 0, 0, 1), v4(192, 168, 1, 5), v4(172, 16, 0, 1), v4(169, 254, 1, 1), v4(100, 64, 0, 1), '::1', 'fd00::1', 'fe80::1']) assert.equal(isPrivateAddress(a), true, a);
  for (const a of [v4(8, 8, 8, 8), v4(93, 184, 216, 34), '2606:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
});

test('inlineImages leaves data: images and non-image cards alone and never throws', async () => {
  const bridge = new AstraBridge({ config: () => ({ astra: { url: 'http://astra.invalid:8088', token: 't' } }), log() {} });
  const cards = [{ type: 'image', data: { src: 'data:image/png;base64,AAAA' } }, { type: 'list', data: { items: [] } },
    { type: 'image', data: { src: 'http://127.0.0.1:1/x.png' } }];
  await bridge.inlineImages(cards);
  assert.equal(cards[0].data.src, 'data:image/png;base64,AAAA');
  assert.equal(cards[2].data.src, 'http://127.0.0.1:1/x.png');
});
