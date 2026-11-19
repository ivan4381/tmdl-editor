import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { systemPrompt, makeBatches, buildUserMessage, parseSuggestions, extractJson, cleanSuggestion } from '../src/core/ai-prompt.js';
import { chatJson, listModels, defaultModel, providerOf, AiError, GEMINI_BASE, ANTHROPIC_BASE } from '../src/ai/providers.js';
import { parseTmdl } from '../src/core/parser.js';
import { buildItems } from '../src/core/items.js';
import { fixture } from './helpers.js';

const model17 = () => buildItems(parseTmdl(fixture('17-full-model.tmdl')));

test('systemPrompt names the language and the JSON shape', () => {
  assert.match(systemPrompt('id'), /Bahasa Indonesia/);
  assert.match(systemPrompt('en'), /English/);
  assert.match(systemPrompt(), /"items":\[\{"id"/);
});

test('makeBatches respects maxItems and keeps tables together', () => {
  const items = [];
  for (let t = 0; t < 3; t++) for (let i = 0; i < 10; i++) items.push({ table: 'T' + t, name: 'c' + i, expression: '' });
  const b = makeBatches(items, { maxItems: 12 });
  assert.deepEqual(b.map((x) => x.length), [12, 12, 6]);
  assert.equal(b.flat().length, 30);
  const big = makeBatches(items.map((x) => ({ ...x, expression: 'x'.repeat(5000) })), { maxChars: 1000 });
  assert.equal(big.length, 30);
  assert.equal(makeBatches(items.map((x) => ({ ...x, expression: 'x'.repeat(5000) })), { maxChars: 4000 }).length, 15);
});

test('buildUserMessage: ids, table context, expressions, existing description, business context', () => {
  const { items, tables } = model17();
  const batch = items.filter((i) => i.table === 'Measures Table');
  const { user, ids } = buildUserMessage(batch, { tables, descOf: (it) => it.originalDesc, businessContext: 'Distribusi LPG' });
  const payload = JSON.parse(user.slice(user.indexOf('{')));
  assert.equal(payload.businessContext, 'Distribusi LPG');
  assert.equal(payload.tables.length, 1);
  assert.deepEqual(payload.tables[0].measures, ['OT Terminal Not Adjusted', 'Label status pengisian realisasi', 'SPBE Performance Indicator']);
  assert.equal(payload.objects.length, 4);
  assert.equal(ids.get('2'), 'measure|measures table|ot terminal not adjusted');
  assert.match(payload.objects[1].expression, /SUM \( Fact_OT_SPBE/);
  assert.ok(payload.objects[1].existingDescription.startsWith('Jumlah total DOT'));
  // Nothing outside the batch's tables (e.g. M partition source) leaks into the prompt.
  assert.ok(!user.includes('Table.FromRows'));
});

test('extractJson / parseSuggestions tolerate fences, prose, arrays and maps', () => {
  const ids = new Map([['1', 'k1'], ['2', 'k2'], ['3', 'k3']]);
  const r = parseSuggestions('Here you go:\n```json\n{"items":[{"id":"1","description":"\\"Total penjualan\\""},{"id":2,"description":"  B  "},{"id":"9","description":"x"}]}\n```', ids);
  assert.deepEqual([...r.suggestions], [['k1', 'Total penjualan'], ['k2', 'B']]);
  assert.deepEqual(r.missing, ['k3']);
  assert.deepEqual([...parseSuggestions('[{"id":"3","description":"C"}]', ids).suggestions], [['k3', 'C']]);
  assert.deepEqual([...parseSuggestions('{"1":"A"}', ids).suggestions], [['k1', 'A']]);
  assert.equal(parseSuggestions('nonsense', ids).suggestions.size, 0);
  assert.equal(extractJson('x {"a":1} y').a, 1);
  assert.equal(cleanSuggestion('“Halo”'), 'Halo');
});

// ---------- providers with a fake fetch ----------

function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = await handler(String(url), init, calls.length);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = orig;
  });
}

test('providerOf', () => {
  assert.equal(providerOf('gemini-3.5-flash-lite'), 'gemini');
  assert.equal(providerOf('claude-haiku-4-5'), 'claude');
});

test('Gemini chat: key header, JSON mime, thinking retry, text extraction', () => withFetch((url, init, n) => {
  const body = JSON.parse(init.body);
  if (n === 1) {
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
    return { status: 400, body: { error: { message: 'Request contains an invalid argument.' } } };
  }
  assert.equal(body.generationConfig.thinkingConfig, undefined);
  return { body: { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: '{"items":[]}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } };
}, async (calls) => {
  const r = await chatJson({ gemini: 'AIzaTEST' }, 'gemini-3.5-flash-lite', 'sys', 'user');
  assert.equal(r.text, '{"items":[]}');
  assert.equal(r.inputTokens, 10);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${GEMINI_BASE}/models/gemini-3.5-flash-lite:generateContent`);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIzaTEST');
  assert.ok(!calls[0].url.includes('AIzaTEST'), 'key never in URL');
  assert.equal(JSON.parse(calls[0].init.body).generationConfig.responseMimeType, 'application/json');
}));

test('Claude chat: browser-access headers, structured output, fallback without output_config', () => withFetch((url, init, n) => {
  const body = JSON.parse(init.body);
  if (n === 1) {
    assert.equal(body.output_config.format.type, 'json_schema');
    return { status: 400, body: { error: { message: 'output_config: unsupported' } } };
  }
  assert.equal(body.output_config, undefined);
  return { body: { content: [{ type: 'text', text: '{"items":[{"id":"1","description":"x"}]}' }], usage: { input_tokens: 3, output_tokens: 4 }, stop_reason: 'end_turn' } };
}, async (calls) => {
  const r = await chatJson({ claude: 'sk-ant-TEST' }, 'claude-haiku-4-5', 'sys', 'user');
  assert.match(r.text, /"description":"x"/);
  const h = calls[0].init.headers;
  assert.equal(calls[0].url, `${ANTHROPIC_BASE}/messages`);
  assert.equal(h['x-api-key'], 'sk-ant-TEST');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(JSON.parse(calls[0].init.body).system, 'sys');
}));

test('error mapping: auth, rate, refusal, missing key', async () => {
  await withFetch(() => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } }), async () => {
    await assert.rejects(chatJson({ claude: 'k' }, 'claude-x', 's', 'u'), (e) => e instanceof AiError && e.kind === 'auth');
  });
  await withFetch(() => ({ status: 429, body: {} }), async () => {
    await assert.rejects(chatJson({ gemini: 'k' }, 'gemini-3-flash', 's', 'u'), (e) => e.kind === 'rate');
  });
  await withFetch(() => ({ body: { content: [], stop_reason: 'refusal' } }), async () => {
    await assert.rejects(chatJson({ claude: 'k' }, 'claude-x', 's', 'u'), (e) => e.kind === 'refusal');
  });
  await assert.rejects(chatJson({}, 'gemini-3-flash', 's', 'u'), (e) => e.kind === 'auth');
});

test('listModels: stable Gemini sorted newest first, Claude newest first, errors collected', () => withFetch((url) => {
  if (url.startsWith(GEMINI_BASE)) {
    return { body: { models: [
      { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.6-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.6-flash-preview-09', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-3.6-pro', supportedGenerationMethods: ['generateContent'] },
    ] } };
  }
  if (url.startsWith(ANTHROPIC_BASE)) return { status: 500, body: {} };
  throw new Error('unexpected ' + url);
}, async () => {
  const { models, errors } = await listModels({ gemini: 'g', claude: 'c' });
  assert.deepEqual(models.map((m) => m.id), ['gemini-3.6-flash-lite', 'gemini-3.6-pro', 'gemini-3.5-flash']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Claude:/);
  assert.equal(defaultModel(models), 'gemini-3.6-flash-lite');
  assert.equal(defaultModel([{ id: 'claude-opus-5-5', provider: 'claude' }, { id: 'claude-haiku-4-5', provider: 'claude' }]), 'claude-haiku-4-5');
}));

test('CSP connect-src allows exactly the provider hosts', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const csp = /content="([^"]*connect-src[^"]*)"/.exec(html)[1];
  const connect = /connect-src ([^;]+)/.exec(csp)[1].trim().split(/\s+/);
  assert.deepEqual(connect.sort(), [new URL(ANTHROPIC_BASE).origin, new URL(GEMINI_BASE).origin].sort());
});
