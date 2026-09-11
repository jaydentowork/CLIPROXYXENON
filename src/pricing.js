// Estimated USD cost per request from published list prices, per 1M tokens.
// The proxy reports token counts only, so this is an estimate: the accounts
// behind the proxy are subscriptions, and providers change list prices.
// Startup catalog matching takes priority; this table is an offline fallback.
const PRICES = {
  'gpt-5-codex': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5.1': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5.2': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.3': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5-pro': { input: 15, cached: 15, output: 120 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'gpt-5': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cached: 0.025, output: 0.4 },
  'gpt-4.1': { input: 2, cached: 0.5, output: 8 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
  'o3-mini': { input: 1.1, cached: 0.55, output: 4.4 },
  'o3': { input: 2, cached: 0.5, output: 8 },
  'o4-mini': { input: 1.1, cached: 0.275, output: 4.4 },
  'codex-mini': { input: 1.5, cached: 0.375, output: 6 },
  'claude-opus-4': { input: 15, cached: 1.5, output: 75 },
  'claude-sonnet-4': { input: 3, cached: 0.3, output: 15 },
  'claude-3-7-sonnet': { input: 3, cached: 0.3, output: 15 },
  'claude-3-5-sonnet': { input: 3, cached: 0.3, output: 15 },
  'claude-haiku-4': { input: 1, cached: 0.1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, cached: 0.08, output: 4 },
  'gemini-3-pro': { input: 2, cached: 0.2, output: 12 },
  'gemini-3-flash': { input: 0.5, cached: 0.05, output: 3 },
  'gemini-2.5-pro': { input: 1.25, cached: 0.31, output: 10 },
  'gemini-2.5-flash-lite': { input: 0.1, cached: 0.025, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, cached: 0.075, output: 2.5 },
  'gemini-2.0-flash-lite': { input: 0.075, cached: 0.01875, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, cached: 0.025, output: 0.4 },
};

// User-supplied USD list prices per million tokens, 2026-09-10.
// Match exact IDs so variants never inherit the wrong text or tier rate.
const EXACT_PRICES = {
  'deepseek-flash': { input: 0.3, cached: 0.006, output: 1.2 },
  'mimo-v2.5-pro': { input: 0.435, cached: 0.0036, output: 0.87 },
  'mimo-v2.5': { input: 0.14, cached: 0.0028, output: 0.28 },
};

const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

// OpenRouter's public catalog uses USD per token; our estimator uses per million.
const MODEL_URL = 'https://openrouter.ai/api/v1/models';
let pricesByName = new Map();
const matches = new Map();

function modelName(value) {
  return value.toLowerCase().trim().replace(/^.*\//, '').replace(/^.*?:\s+/, '')
    .replace(/[- ]20\d{2}[-]?\d{2}[-]?\d{2}$/, '');
}

function normalized(value) {
  return modelName(value).replace(/[^a-z0-9]/g, '');
}

function rates(pricing) {
  const rate = value => value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) * 1e6 : null;
  const input = rate(pricing?.prompt);
  const output = rate(pricing?.completion);
  if (input === null || output === null) return null;
  return { input, output, cached: rate(pricing.input_cache_read) ?? input };
}

export function setPricingCatalog(catalog) {
  const next = new Map();
  for (const model of catalog?.data ?? []) {
    if (typeof model?.name !== 'string' || typeof model.id !== 'string') continue;
    const override = EXACT_PRICES[modelName(model.id)];
    const price = override ?? rates(model.pricing);
    if (!price) continue;
    const overrides = (!override && Array.isArray(model.pricing?.overrides) ? model.pricing.overrides : [])
      .filter(tier => Number.isFinite(tier.min_prompt_tokens) && tier.min_prompt_tokens >= 0)
      .map(tier => ({ above: tier.min_prompt_tokens, price: rates({ ...model.pricing, ...tier }) }))
      .filter(tier => tier.price)
      .sort((a, b) => a.above - b.above);
    next.set(model.name, { price, overrides, names: [normalized(model.name), normalized(model.id)] });
  }
  pricesByName = next;
  matches.clear();
  return next.size;
}

export async function loadPricingCatalog({ fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(MODEL_URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Catalog request failed.');
    const catalog = await response.json();
    if (!Array.isArray(catalog?.data) || !catalog.data.some(model => typeof model?.name === 'string' && typeof model.id === 'string' && rates(model.pricing))) {
      throw new Error('Catalog contains no usable prices.');
    }
    const count = setPricingCatalog(catalog);
    if (!count) throw new Error('Catalog contains no named models.');
    return count;
  } catch {
    return 0; // Keep monitoring with the built-in rates when the catalog is unavailable.
  }
}

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

function catalogMatch(model) {
  const name = normalized(model);
  if (matches.has(name)) return matches.get(name);
  // Proxy aliases may append a reasoning-effort setting to the actual model.
  const base = normalized(modelName(model).replace(/[-_ ](?:high|medium|low|xhigh|minimal|none)$/, ''));
  for (const alias of [name, base]) {
    const exact = [...pricesByName.values()].find(entry => entry.names.includes(alias));
    if (exact) { matches.set(name, exact); return exact; }
  }
  let best = null, bestScore = Infinity, secondScore = Infinity;
  for (const entry of pricesByName.values()) {
    let score = Infinity;
    for (const candidate of entry.names) {
      if (name === candidate) { score = 0; break; }
      // Do not guess another generation, or substitute batch/free billing.
      if ((name.match(/\d+/g) ?? []).join() !== (candidate.match(/\d+/g) ?? []).join()) continue;
      if (['batch', 'free'].some(flag => name.includes(flag) !== candidate.includes(flag))) continue;
      score = Math.min(score, distance(name, candidate) / Math.max(name.length, candidate.length));
    }
    if (score < bestScore) { secondScore = bestScore; bestScore = score; best = entry; }
    else secondScore = Math.min(secondScore, score);
  }
  // Close, unique matches tolerate punctuation/version separators and small typos.
  // Unrelated or ambiguous names stay unpriced instead of inventing a dollar amount.
  const result = bestScore === 0 || (bestScore <= 0.15 && secondScore - bestScore >= 0.04) ? best : null;
  matches.set(name, result);
  return result;
}

export function priceFor(model, promptTokens = 0) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const name = modelName(model);
  if (Object.hasOwn(EXACT_PRICES, name)) return EXACT_PRICES[name];
  if (pricesByName.size) {
    const entry = catalogMatch(model);
    if (!entry) return null;
    let price = entry.price;
    for (const tier of entry.overrides) if (promptTokens > tier.above) price = tier.price;
    return price;
  }
  for (const key of KEYS) {
    if (name.startsWith(key) && (name.length === key.length || /[^a-z0-9]/.test(name[key.length]))) return PRICES[key];
  }
  return null;
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Claude's native input count excludes cache reads. OpenAI-compatible usage
// includes cached tokens in input. Cache writes/other fees are not in telemetry.
export function estimateCost({ model, provider, inputTokens, outputTokens, cachedTokens } = {}) {
  const input = count(inputTokens);
  const output = count(outputTokens);
  const cacheRead = count(cachedTokens) ?? 0;
  if (input === null && output === null) return null;
  const separateCache = provider === 'claude';
  const cached = separateCache ? cacheRead : Math.min(cacheRead, input ?? 0);
  const prompt = (input ?? 0) + (separateCache ? cached : 0);
  const price = priceFor(model, prompt);
  if (!price) return null;
  const billableInput = Math.max(0, (input ?? 0) - (separateCache ? 0 : cached));
  const usd = (billableInput * price.input + cached * price.cached + (output ?? 0) * price.output) / 1e6;
  return Number.isFinite(usd) ? usd : null;
}
