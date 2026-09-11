import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, priceFor, setPricingCatalog, loadPricingCatalog } from './pricing.js';

test('models price by family, longest key first', () => {
  assert.equal(priceFor('gpt-5-mini').input, 0.25);
  assert.equal(priceFor('gpt-5-codex').output, 10);
  assert.equal(priceFor('gpt-5').input, 1.25);
  assert.equal(priceFor('claude-sonnet-4-6').input, 3);
  assert.equal(priceFor('anthropic/claude-opus-4-1').output, 75);
  assert.equal(priceFor('GEMINI-2.5-FLASH').output, 2.5);
  assert.equal(priceFor('gemini-2.5-flash-lite').output, 0.4);
  assert.equal(priceFor('gpt-5.4-mini'), PRICES_GPT54_MINI_IS_NOT_GPT54);
});

const PRICES_GPT54_MINI_IS_NOT_GPT54 = priceFor('gpt-5.4');

test('unknown models and missing splits estimate nothing', () => {
  assert.equal(priceFor('mystery-9000'), null);
  assert.equal(priceFor(null), null);
  assert.equal(estimateCost({ model: 'gpt-5', inputTokens: null, outputTokens: null }), null);
  assert.equal(estimateCost({ model: 'nope', inputTokens: 10, outputTokens: 10 }), null);
});

test('cached tokens are billed at the cached rate and not double counted', () => {
  const usd = estimateCost({ model: 'claude-sonnet-4-5', inputTokens: 1000, outputTokens: 100, cachedTokens: 400 });
  assert.equal(usd, (600 * 3 + 400 * 0.3 + 100 * 15) / 1e6);
  const capped = estimateCost({ model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 0, cachedTokens: 500 });
  assert.equal(capped, (100 * 0.3) / 1e6);
});

test('MiMo uses the supplied USD prices and subtracts cached input once', () => {
  assert.deepEqual(priceFor('mimo-v2.5-pro'), { input: 0.435, cached: 0.0036, output: 0.87 });
  assert.deepEqual(priceFor('xiaomi/mimo-v2.5'), { input: 0.14, cached: 0.0028, output: 0.28 });
  const usage = { inputTokens: 1000000, outputTokens: 1000000, cachedTokens: 100000 };
  assert.ok(Math.abs(estimateCost({ ...usage, model: 'mimo-v2.5-pro' }) - 1.26186) < 1e-10);
  assert.ok(Math.abs(estimateCost({ ...usage, model: 'mimo-v2.5' }) - 0.40628) < 1e-10);
  assert.equal(priceFor('mimo-v2.5-tts'), null);
  assert.equal(priceFor('mimo-v2.5-prototype'), null);
});

test('deepseek-flash uses the supplied peak-hour prices', () => {
  assert.deepEqual(priceFor('deepseek-flash'), { input: 0.3, cached: 0.006, output: 1.2 });
  assert.deepEqual(priceFor('opencode/deepseek-flash'), { input: 0.3, cached: 0.006, output: 1.2 });
  const usage = { inputTokens: 1000000, outputTokens: 1000000, cachedTokens: 100000 };
  assert.ok(Math.abs(estimateCost({ ...usage, model: 'deepseek-flash' }) - 1.4706) < 1e-10);
  assert.equal(priceFor('deepseek-flash-off-peak'), null);
});

test('OpenRouter startup catalog matches names and applies per-token rates, tiers, and MiMo overrides', async t => {
  t.after(() => setPricingCatalog({ data: [] }));
  const catalog = { data: [
    { id: 'openai/gpt-6-astra', name: 'OpenAI: GPT-6 Astra', pricing: {
      prompt: '0.00001', completion: '0.00005', input_cache_read: '0.000001',
      overrides: [{ min_prompt_tokens: 272000, prompt: '0.00002', completion: '0.000075', input_cache_read: '0.000002' }],
    } },
    { id: 'openai/gpt-6-astra:batch', name: 'OpenAI: GPT-6 Astra (batch)', pricing: { prompt: '0.000005', completion: '0.000025' } },
    { id: 'anthropic/claude-fable-5.1', name: 'Anthropic: Claude Fable 5.1', pricing: { prompt: '0.00001', completion: '0.00005', input_cache_read: '0.00000025' } },
    { id: 'xiaomi/mimo-v2.5-pro', name: 'Xiaomi: MiMo-V2.5-Pro', pricing: { prompt: '0.001', completion: '0.002' } },
    { id: 'vendor/invalid', name: 'Invalid', pricing: { prompt: '-1', completion: 'bad' } },
  ] };
  const loaded = await loadPricingCatalog({ fetchImpl: async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/models');
    assert.deepEqual(Object.keys(init), ['signal']);
    assert.equal(init.signal.aborted, false);
    return { ok: true, json: async () => catalog };
  } });
  assert.equal(loaded, 4);
  assert.equal(priceFor('gpt-6-astra').input, 10);
  assert.equal(priceFor('OpenAI: GPT-6 Astra').input, 10);
  assert.equal(priceFor('gpt-6-astra-2026-09-10').input, 10);
  assert.equal(priceFor('gpt-6-asra').input, 10);
  assert.equal(priceFor('gpt-6-astra-high').input, 10);
  assert.equal(priceFor('gpt-6-astra:batch').input, 5);
  assert.equal(priceFor('claude-fable-5-1').cached, 0.25);
  assert.equal(priceFor('gpt-7-astra'), null);
  assert.equal(priceFor('gpt-6-astra:free'), null);
  assert.equal(priceFor('not-a-model'), null);
  assert.equal(priceFor('gpt-6-astra', 272000).input, 10);
  assert.equal(priceFor('gpt-6-astra', 272001).input, 20);
  assert.equal(estimateCost({ model: 'gpt-6-astra', inputTokens: 300000, cachedTokens: 200000, outputTokens: 1000 }), 2.475);
  assert.equal(estimateCost({ model: 'claude-fable-5-1', provider: 'claude', inputTokens: 2, cachedTokens: 117469, outputTokens: 340 }), 0.04638725);
  assert.deepEqual(priceFor('Xiaomi: MiMo-V2.5-Pro'), { input: 0.435, cached: 0.0036, output: 0.87 });
  assert.equal(await loadPricingCatalog({ fetchImpl: async () => { throw new Error('offline'); } }), 0);
  assert.equal(priceFor('gpt-6-astra').input, 10); // A failed refresh preserves loaded rates.
  assert.equal(await loadPricingCatalog({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{}] }) }) }), 0);
  assert.equal(priceFor('gpt-6-astra').input, 10);
});

test('ambiguous closest matches remain unpriced and unavailable catalog uses fallback', async t => {
  t.after(() => setPricingCatalog({ data: [] }));
  setPricingCatalog({ data: ['ab', 'ac'].map(suffix => ({ id: 'test/model-1-' + suffix,
    name: 'Test: Model 1 ' + suffix, pricing: { prompt: '0', completion: '0' } })) });
  assert.equal(priceFor('model-1-ad'), null);
  setPricingCatalog({ data: [] });
  assert.equal(await loadPricingCatalog({ fetchImpl: async () => ({ ok: false }) }), 0);
  assert.equal(priceFor('gpt-5').input, 1.25);
});
