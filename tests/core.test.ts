import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { readSnapshot, removeProvider, writeProvider, type FileHost } from '../panel/core/config';
import {
  buildProvider,
  collectProviders,
  draftFrom,
  emptyDraft,
  emptyModel,
  readModels,
  type ProviderDraft,
} from '../panel/core/provider';
import { positiveInt } from '../panel/core/json';
import { idFromName, uniqueIDFrom } from '../panel/core/provider';
import { packageFrom, protocolOfPackage } from '../panel/core/protocols';
import { validateDraft } from '../panel/core/validate';
import { modelCandidates, modelHeaders, parseModelIDs, parseModelOptions } from '../service/models';
import { endpointCandidates, endpointHeaders, parseEndpoints } from '../service/models';
import { modelPageCandidates, parseEndpointStats, mergeEndpointStats } from '../service/models';
import { sortModelOptions } from '../panel/core/modellist';
import { arenaRowFor, parseArenaLeaderboard, parseArenaSnapshot } from '../service/arena';
import {
  contextText,
  isRouterBaseURL,
  latencyText,
  perMillion,
  priceText,
  sortEndpoints,
  throughputText,
  uptimeText,
} from '../panel/core/router';

const draft = (overrides: Partial<ProviderDraft> = {}): ProviderDraft => ({
  ...emptyDraft(),
  providerID: 'acme',
  name: 'Acme',
  baseURL: 'https://api.acme.test/v1',
  models: [{ ...emptyModel(), id: 'coder', name: 'Coder' }],
  ...overrides,
});

/* ------------------------------------------------------------------ limits */

test('a provider name becomes a usable ID', () => {
  assert.equal(idFromName('Acme Gateway'), 'acme-gateway');
  assert.equal(idFromName('  Relay.Fast  '), 'relay-fast');
  assert.equal(idFromName('中转站'), '');
  assert.equal(uniqueIDFrom('Relay Fast', []), 'relay-fast');
  assert.equal(uniqueIDFrom('Relay Fast', ['relay-fast']), 'relay-fast-2');
  assert.equal(uniqueIDFrom('Relay Fast', ['relay-fast', 'relay-fast-2']), 'relay-fast-3');
  assert.equal(uniqueIDFrom('中转站', []), 'provider');
});

test('a provider name equal to its ID is not written twice', () => {
  const block = buildProvider(draft({ providerID: 'acme', name: 'acme' }));
  assert.equal(block.name, undefined);
  const named = buildProvider(draft({ providerID: 'acme', name: 'Acme Gateway' }));
  assert.equal(named.name, 'Acme Gateway');
});

test('positiveInt accepts only positive safe whole numbers', () => {
  assert.equal(positiveInt('128000'), 128000);
  for (const value of ['128000abc', '1.5', '0', '-2', '9007199254740992', '']) {
    assert.equal(positiveInt(value), undefined, `${value} should be rejected`);
  }
});

test('blank limits are omitted instead of invented', () => {
  const block = buildProvider(draft());
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.equal(model.limit, undefined);
});

test('filled limits are written as numbers', () => {
  const block = buildProvider(draft({
    models: [{ ...emptyModel(), id: 'coder', context: '1000', output: '500' }],
  }));
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.limit, { context: 1000, output: 500 });
});

test('clearing a limit removes only that key', () => {
  const existing = { models: { coder: { modelID: 'coder', limit: { context: 1000, output: 500, input: 900 } } } };
  const block = buildProvider(draft({ models: [{ ...emptyModel(), id: 'coder', context: '2000', sourceID: 'coder' }] }), existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.limit, { context: 2000, input: 900 });
});

/* --------------------------------------------------------------- reasoning */

test('reasoning is written in the V2 shape, not as variants', () => {
  const block = buildProvider(draft({
    models: [{ ...emptyModel(), id: 'coder', levels: ['low', 'high'] }],
  }));
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual((model.capabilities as Record<string, unknown>).reasoning, { supported: true, effort: ['low', 'high'] });
  // OpenCode derives the variants from `capabilities.reasoning` for the
  // packages this panel offers, so none are written by hand.
  assert.equal(model.variants, undefined);
});

test('variants follow the protocol so the request carries the right field', () => {
  const build = (protocol: ProviderDraft['protocol'], customPackage = ''): Record<string, any> => (
    (buildProvider(draft({
      protocol,
      customPackage,
      models: [{ ...emptyModel(), id: 'coder', levels: ['high'] }],
    })).models as Record<string, any>).coder
  );
  // OpenCode derives these itself from `capabilities.reasoning`; writing them
  // again would only duplicate what the runtime already computes.
  assert.equal(build('openai-chat').variants, undefined);
  assert.equal(build('openai-responses').variants, undefined);
  assert.equal(build('anthropic-messages').variants, undefined);
  // A custom package gets no variants from OpenCode at all, so the panel has
  // to write them or the levels never reach the picker.
  assert.deepEqual(build('custom', 'aisdk:my-gateway').variants, [{ id: 'high', settings: { reasoningEffort: 'high' } }]);
});

test('a known package keeps a hand-written standard level with its own headers', () => {
  const existing = {
    package: 'aisdk:@ai-sdk/openai-compatible',
    models: {
      coder: {
        variants: [
          { id: 'high', settings: { reasoningEffort: 'low' }, headers: { 'X-Keep': '1' } },
          { id: 'vendor', settings: { vendorFlag: true } },
        ],
      },
    },
  };
  const current = draftFrom({ id: 'gw', block: existing, file: 'f', overlay: false });
  current.models[0]!.levels = ['low', 'high'];
  const block = buildProvider(current, existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  // OpenCode builds `low` from `capabilities.reasoning`; the variant with its
  // own headers is the user's and stays, with its overlay refreshed.
  assert.deepEqual(model.variants, [
    { id: 'high', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
    { id: 'vendor', settings: { vendorFlag: true } },
  ]);
});

test('a custom package keeps a hand-written variant alongside generated ones', () => {
  const existing = {
    package: 'aisdk:my-gateway',
    models: {
      coder: {
        variants: [
          { id: 'high', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
          { id: 'vendor', settings: { vendorFlag: true } },
        ],
      },
    },
  };
  const current = draftFrom({ id: 'gw', block: existing, file: 'f', overlay: false });
  current.models[0]!.levels = ['low', 'high'];
  const block = buildProvider(current, existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.variants, [
    { id: 'low', settings: { reasoningEffort: 'low' } },
    { id: 'high', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
    { id: 'vendor', settings: { vendorFlag: true } },
  ]);
});

test('a package that decides its own levels is not turned off by a save', () => {
  const existing = { models: { coder: { capabilities: { reasoning: { supported: true } } } } };
  const block = buildProvider(draft({ models: [{ ...emptyModel(), id: 'coder', levels: [], sourceID: 'coder' }] }), existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual((model.capabilities as Record<string, unknown>).reasoning, { supported: true });
});

test('a renamed model drops a display name that only repeated the old ID', () => {
  const existing = { models: { old: { name: 'old', modelID: 'old' } } };
  const current = draftFrom({ id: 'acme', block: existing, file: 'x', overlay: false });
  current.models[0]!.id = 'new';
  // The form keeps the name it read; it must not survive under the new key.
  assert.equal(current.models[0]!.name, 'old');
  const block = buildProvider(current, existing);
  const model = (block.models as Record<string, Record<string, unknown>>).new!;
  assert.equal(model.name, undefined);
});

test('turning every level off declares reasoning unsupported', () => {
  const existing = { models: { coder: { capabilities: { reasoning: { supported: true, effort: ['low'] } } } } };
  const block = buildProvider(draft({ models: [{ ...emptyModel(), id: 'coder', levels: [], sourceID: 'coder' }] }), existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual((model.capabilities as Record<string, unknown>).reasoning, { supported: false });
});

test('a model that never declared reasoning keeps the key absent when all cards are off', () => {
  const block = buildProvider(draft({ models: [{ ...emptyModel(), id: 'coder', levels: [] }] }));
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.equal((model.capabilities as Record<string, unknown>).reasoning, undefined);
});

test('previously generated variants are replaced and hand-written ones survive', () => {
  const existing = {
    package: 'aisdk:my-gateway',
    models: {
      coder: {
        modelID: 'coder',
        variants: [
          { id: 'low', settings: { reasoningEffort: 'low' } },
          { id: 'high', settings: { reasoningEffort: 'high', thinking: { type: 'adaptive' }, effort: 'high' } },
          { id: 'vendor', settings: { reasoningEffort: 'low', vendorFlag: true } },
          { id: 'high-custom', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
        ],
      },
    },
  };
  const block = buildProvider(draft({
    protocol: 'custom',
    customPackage: 'aisdk:my-gateway',
    models: [{ ...emptyModel(), id: 'coder', sourceID: 'coder', levels: ['low'] }],
  }), existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.variants, [
    { id: 'low', settings: { reasoningEffort: 'low' } },
    { id: 'vendor', settings: { reasoningEffort: 'low', vendorFlag: true } },
    { id: 'high-custom', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
  ]);
});

test('a hand-written standard level keeps its headers while the overlay is refreshed', () => {
  const existing = {
    package: 'aisdk:my-gateway',
    models: {
      coder: {
        variants: [{ id: 'high', settings: { reasoningEffort: 'low' }, headers: { 'X-Keep': '1' } }],
      },
    },
  };
  const block = buildProvider(draft({
    protocol: 'custom',
    customPackage: 'aisdk:my-gateway',
    models: [{ ...emptyModel(), id: 'coder', sourceID: 'coder', levels: ['high'] }],
  }), existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.variants, [
    { id: 'high', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
  ]);
});

test('editing only the name preserves a hand-written variant untouched', () => {
  const existing = {
    models: {
      coder: {
        modelID: 'coder',
        variants: [{ id: 'deep', settings: { reasoningEffort: 'high', vendorFlag: true } }],
      },
    },
  };
  const current = draftFrom({ id: 'acme', block: existing, file: 'x', overlay: false });
  current.models[0]!.name = 'Renamed';
  const block = buildProvider(current, existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.variants, [{ id: 'deep', settings: { reasoningEffort: 'high', vendorFlag: true } }]);
  // A name the form does not edit is carried, but one equal to the ID is not written.
  assert.equal(model.name, 'Renamed');
});

test('reading a model reports the levels its config declares', () => {
  const models = readModels({
    models: {
      a: { capabilities: { reasoning: { supported: true, effort: ['low', 'max'] } } },
      b: { capabilities: { reasoning: { supported: false } } },
      c: {},
    },
  });
  assert.deepEqual(models.map((model) => model.levels), [['low', 'max'], [], []]);
});

/* --------------------------------------------------------------- migration */

test('a V1 provider is read and rewritten in the V2 spelling', () => {
  const legacy = {
    npm: '@ai-sdk/openai-compatible',
    options: {
      baseURL: 'https://old.test/v1',
      apiKey: 'sk-old',
      headers: { 'X-Team': 'platform' },
      body: { service_tier: 'flex' },
    },
    models: {
      coder: {
        id: 'upstream-id',
        name: 'Coder',
        tool_call: true,
        attachment: false,
        limit: { context: 1000, output: 100 },
        variants: { high: { reasoningEffort: 'high' } },
      },
    },
  };
  const current = draftFrom({ id: 'legacy', block: legacy, file: 'a.json', overlay: false });
  assert.equal(current.baseURL, 'https://old.test/v1');
  assert.equal(current.apiKey, 'sk-old');
  assert.equal(current.models[0]!.modelID, 'upstream-id');
  assert.deepEqual(current.models[0]!.levels, ['high']);
  assert.equal(current.models[0]!.image, false);

  const block = buildProvider(current, legacy);
  assert.equal(block.npm, undefined);
  assert.equal(block.options, undefined);
  assert.equal(block.package, 'aisdk:@ai-sdk/openai-compatible');
  assert.deepEqual(block.headers, { 'X-Team': 'platform' });
  assert.deepEqual(block.body, { service_tier: 'flex' });
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.equal(model.modelID, 'upstream-id');
  assert.deepEqual(model.capabilities, { tools: true, input: ['text'], output: ['text'], reasoning: { supported: true, effort: ['high'] } });
});

/* ---------------------------------------------------------------- packages */

test('packages map to protocols without confusing the responses variant', () => {
  assert.equal(protocolOfPackage('aisdk:@ai-sdk/openai-compatible'), 'openai-chat');
  assert.equal(protocolOfPackage('@opencode/ai/providers/openai-compatible'), 'openai-chat');
  assert.equal(protocolOfPackage('@opencode/ai/providers/openai-compatible/responses'), 'openai-responses');
  assert.equal(protocolOfPackage('aisdk:@ai-sdk/anthropic'), 'anthropic-messages');
  assert.equal(protocolOfPackage('@opencode/ai/providers/anthropic-compatible'), 'anthropic-messages');
  assert.equal(protocolOfPackage('aisdk:my-custom-provider'), 'custom');
  assert.equal(protocolOfPackage(''), 'openai-chat');
});

test('an unknown package survives a save instead of being replaced', () => {
  const existing = { package: 'aisdk:my-gateway-provider', settings: { baseURL: 'https://x.test' } };
  const current = draftFrom({ id: 'gw', block: existing, file: 'a', overlay: false });
  assert.equal(current.protocol, 'custom');
  assert.equal(current.customPackage, 'aisdk:my-gateway-provider');
  const block = buildProvider(current, existing);
  assert.equal(block.package, 'aisdk:my-gateway-provider');
});

test('switching protocol changes the package', () => {
  const existing = { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: 'https://x.test' } };
  const current = draftFrom({ id: 'gw', block: existing, file: 'a', overlay: false });
  current.protocol = 'anthropic-messages';
  const block = buildProvider(current, existing);
  assert.equal(block.package, 'aisdk:@ai-sdk/anthropic');
});

test('packageFrom reads the V1 spellings', () => {
  assert.equal(packageFrom({ npm: '@ai-sdk/openai' }), 'aisdk:@ai-sdk/openai');
  assert.equal(packageFrom({ api: { npm: '@ai-sdk/anthropic' } }), 'aisdk:@ai-sdk/anthropic');
  assert.equal(packageFrom({ package: 'aisdk:x' }), 'aisdk:x');
  assert.equal(packageFrom({}), '');
});

/* --------------------------------------------------------------- providers */

test('collecting providers keeps the V2 block over the V1 twin', () => {
  const entries = collectProviders({
    provider: { acme: { name: 'old' } },
    providers: { acme: { name: 'new', package: 'aisdk:x' } },
  }, 'file.jsonc');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.block.name, 'new');
});

test('a provider without a package is flagged as an overlay', () => {
  const entries = collectProviders({ providers: { anthropic: { settings: { baseURL: 'https://proxy' } } } }, 'f');
  assert.equal(entries[0]!.overlay, true);
});

test('saving keeps headers, body and models the panel does not manage', () => {
  const existing = {
    package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: 'https://x.test/v1', apiKey: 'sk-1', timeout: 60000 },
    headers: { 'X-Team': 'platform' },
    body: { metadata: { app: 'opencode' } },
    models: {
      coder: {
        modelID: 'coder',
        cost: { input: 1, output: 2 },
        headers: { 'X-Model': '1' },
        capabilities: { tools: true, input: ['text', 'image', 'pdf'], output: ['text'], temperature: false },
      },
      other: { modelID: 'other', name: 'Other' },
    },
  };
  const current = draftFrom({ id: 'acme', block: existing, file: 'a', overlay: false });
  const block = buildProvider(current, existing);
  assert.deepEqual(block.headers, { 'X-Team': 'platform' });
  assert.deepEqual(block.body, { metadata: { app: 'opencode' } });
  assert.equal((block.settings as Record<string, unknown>).timeout, 60000);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.cost, { input: 1, output: 2 });
  assert.deepEqual(model.headers, { 'X-Model': '1' });
  assert.deepEqual((model.capabilities as Record<string, unknown>).input, ['text', 'image', 'pdf']);
  assert.deepEqual((model.capabilities as Record<string, unknown>).output, ['text']);
  assert.equal((model.capabilities as Record<string, unknown>).temperature, false);
  assert.ok((block.models as Record<string, unknown>).other);
});

test('an emptied API key is removed while other settings stay', () => {
  const existing = { package: 'aisdk:x', settings: { baseURL: 'https://x.test', apiKey: 'sk-1', timeout: 5 } };
  const current = draftFrom({ id: 'acme', block: existing, file: 'a', overlay: false });
  current.apiKey = '';
  const block = buildProvider(current, existing);
  assert.deepEqual(block.settings, { baseURL: 'https://x.test', timeout: 5 });
});

test('a renamed model keeps the fields of its previous row', () => {
  const existing = { models: { coder: { modelID: 'coder', cost: { input: 1, output: 2 }, limit: { context: 10, output: 5 } } } };
  const current = draftFrom({ id: 'acme', block: existing, file: 'a', overlay: false });
  current.models[0]!.id = 'renamed';
  const block = buildProvider(current, existing);
  const model = (block.models as Record<string, Record<string, unknown>>).renamed!;
  assert.deepEqual(model.cost, { input: 1, output: 2 });
  assert.deepEqual(model.limit, { context: 10, output: 5 });
  assert.equal((block.models as Record<string, unknown>).coder, undefined);
});

/* -------------------------------------------------------------------- jsonc */

const messy = `{
  // Providers live here.
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "acme": {
      "name": "Acme", // kept
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "https://a.test/v1" },
    },
  },
  "model": "acme/coder",
  /* tail */
}
`;

test('writing a provider keeps comments, order and trailing commas', () => {
  const next = writeProvider(messy, 'acme', {
    name: 'Acme Renamed',
    package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: 'https://b.test/v1' },
    models: { coder: { modelID: 'coder' } },
  });
  assert.ok(next.includes('// Providers live here.'));
  assert.ok(next.includes('/* tail */'));
  assert.ok(next.includes('"model": "acme/coder"'));
  const parsed = parse(next) as Record<string, any>;
  assert.equal(parsed.providers.acme.name, 'Acme Renamed');
  assert.equal(parsed.providers.acme.settings.baseURL, 'https://b.test/v1');
  assert.equal(parsed.providers.acme.models.coder.modelID, 'coder');
});

test('a new provider joins the existing block without disturbing it', () => {
  const next = writeProvider(messy, 'zeta', { name: 'Zeta', package: 'aisdk:x', settings: {}, models: {} });
  const parsed = parse(next) as Record<string, any>;
  assert.ok(parsed.providers.acme);
  assert.equal(parsed.providers.zeta.name, 'Zeta');
  assert.ok(next.includes('// kept'));
});

test('a fresh file gets a schema and the provider', () => {
  const next = writeProvider(null, 'first', { name: 'First', package: 'aisdk:x', settings: {}, models: {} });
  const parsed = parse(next) as Record<string, any>;
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  assert.equal(parsed.providers.first.name, 'First');
});

test('CRLF and BOM files stay that way', () => {
  const crlf = '\uFEFF{\r\n  "providers": {\r\n    "a": { "name": "A" }\r\n  }\r\n}\r\n';
  const next = writeProvider(crlf, 'b', { name: 'B' });
  assert.ok(next.startsWith('\uFEFF'));
  assert.ok(next.includes('\r\n'));
  assert.equal(next.includes('\n\n'), false);
  const parsed = parse(next.charCodeAt(0) === 0xfeff ? next.slice(1) : next) as Record<string, any>;
  assert.equal(parsed.providers.b.name, 'B');
});

test('writing a provider removes a V1 twin', () => {
  const text = '{\n  "provider": { "acme": { "name": "old" } }\n}\n';
  const next = writeProvider(text, 'acme', { name: 'new', package: 'aisdk:x' });
  const parsed = parse(next) as Record<string, any>;
  assert.equal(parsed.provider, undefined);
  assert.equal(parsed.providers.acme.name, 'new');
});

test('removing a provider cleans both spellings', () => {
  const text = '{\n  "provider": { "acme": { "name": "a" } },\n  "providers": { "acme": { "name": "a" }, "keep": { "name": "k" } }\n}\n';
  const next = removeProvider(text, 'acme');
  assert.ok(next);
  const parsed = parse(next!) as Record<string, any>;
  assert.equal(parsed.providers.acme, undefined);
  assert.equal(parsed.provider, undefined);
  assert.equal(parsed.providers.keep.name, 'k');
});

test('removing an absent provider reports no change', () => {
  assert.equal(removeProvider('{ "providers": { "a": {} } }', 'b'), null);
});

/* ----------------------------------------------------------------- snapshot */

const hostWith = (files: Record<string, string>): FileHost => ({
  stat: async (path) => ({ kind: path in files ? 'file' : 'missing' }),
  readFile: async (path) => ({ content: files[path]! }),
  writeFile: async () => ({ written: true }),
});

test('both config files are read, jsonc winning on a shared ID', async () => {
  const host = hostWith({
    '~/.config/opencode/opencode.json': '{ "providers": { "a": { "name": "from-json" }, "b": { "name": "b" } } }',
    '~/.config/opencode/opencode.jsonc': '{ "providers": { "a": { "name": "from-jsonc" } } }',
  });
  const snapshot = await readSnapshot(host);
  assert.equal(snapshot.files.length, 2);
  assert.deepEqual(snapshot.providers.map((entry) => entry.id), ['a', 'b']);
  assert.equal(snapshot.providers[0]!.block.name, 'from-jsonc');
  assert.equal(snapshot.providers[0]!.file, '~/.config/opencode/opencode.jsonc');
  assert.equal(snapshot.target, '~/.config/opencode/opencode.jsonc');
});

test('a missing config reads as empty and targets a new jsonc file', async () => {
  const snapshot = await readSnapshot(hostWith({}));
  assert.deepEqual(snapshot.providers, []);
  assert.deepEqual(snapshot.files, []);
  assert.equal(snapshot.target, '~/.config/opencode/opencode.jsonc');
});

test('a broken config file names its position', async () => {
  const host = hostWith({ '~/.config/opencode/opencode.json': '{\n  "providers": {\n' });
  await assert.rejects(() => readSnapshot(host), /opencode\.json: .+ at line \d+, column \d+/);
});

/* --------------------------------------------------------------- validation */

test('validation catches the mistakes the form can make', () => {
  const base = { existingIDs: ['taken'], editingID: null };
  assert.deepEqual(validateDraft(draft(), base), {});
  assert.equal(validateDraft(draft({ providerID: 'Bad ID' }), base).providerID, 'errorID');
  assert.equal(validateDraft(draft({ providerID: 'taken' }), base).providerID, 'errorIDTaken');
  assert.equal(validateDraft(draft({ providerID: 'taken' }), { ...base, editingID: 'taken' }).providerID, undefined);
  assert.equal(validateDraft(draft({ name: ' ' }), base).name, 'errorName');
  assert.equal(validateDraft(draft({ baseURL: 'ftp://x' }), base).baseURL, 'errorBaseURL');
  assert.equal(validateDraft(draft({ models: [] }), base).models, 'errorModels');
  assert.equal(validateDraft(draft({ models: [{ ...emptyModel(), id: 'a' }, { ...emptyModel(), id: 'a' }] }), base).models, 'errorModelsDuplicate');
  assert.equal(validateDraft(draft({ models: [{ ...emptyModel(), context: '1.5' }] }), base).models, 'errorLimits');
});

test('env and file key references are accepted', () => {
  const base = { existingIDs: [], editingID: null };
  assert.deepEqual(validateDraft(draft({ apiKey: '{env:ACME_KEY}' }), base), {});
  assert.deepEqual(validateDraft(draft({ apiKey: '{file:~/.secrets/acme}' }), base), {});
  assert.equal(validateDraft(draft({ apiKey: 'short' }), base).apiKey, 'errorAPIKey');
});

/* --------------------------------------------------------------- model fetch */

test('a new model starts with every reasoning level off', () => {
  assert.deepEqual(emptyModel().levels, []);
});

test('model list URLs cover a bare origin and a /v1 base', () => {
  assert.deepEqual(modelCandidates('https://relay.fast/v1'), ['https://relay.fast/v1/models']);
  assert.deepEqual(modelCandidates('https://relay.fast/'), ['https://relay.fast/models', 'https://relay.fast/v1/models']);
  assert.deepEqual(modelCandidates('ftp://relay.fast'), []);
});

test('model list headers follow the protocol', () => {
  assert.equal(modelHeaders('openai-chat', 'sk-1').authorization, 'Bearer sk-1');
  assert.equal(modelHeaders('anthropic-messages', 'sk-1')['x-api-key'], 'sk-1');
  assert.equal(modelHeaders('anthropic-messages', 'sk-1')['anthropic-version'], '2023-06-01');
});

test('model IDs are read from the shapes gateways return', () => {
  assert.deepEqual(parseModelIDs({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(parseModelIDs({ models: ['c', { model: 'd' }] }), ['c', 'd']);
  assert.deepEqual(parseModelIDs(['e', { name: 'f' }]), ['e', 'f']);
  assert.deepEqual(parseModelIDs({ data: [] }), []);
});

test('model options carry the arena leaderboard row and a variant base', () => {
  const payload = {
    data: [
      { id: 'vendor/base', name: 'Vendor Base' },
      { id: 'vendor/base:nitro', name: 'Vendor Base (Nitro)' },
      { id: 'vendor/base:floor' },
      { id: 'vendor/idle' },
      { id: 'vendor/plain' },
      { id: 'vendor/base' },
    ],
  };
  const arena = [
    { rank: 3, name: 'Vendor Base (Max)', score: 23.38, sessions: 4351 },
    { rank: 9, name: 'Vendor Idle', score: 1.2 },
  ];
  const options = parseModelOptions(payload, arena);
  assert.deepEqual(
    options.map((option) => option.id),
    ['vendor/base', 'vendor/base:nitro', 'vendor/base:floor', 'vendor/idle', 'vendor/plain'],
  );
  // The leaderboard names models the way people do: tuning suffix and
  // punctuation do not stop the match.
  assert.deepEqual(options[0].arena, { rank: 3, name: 'Vendor Base (Max)', score: 23.38, sessions: 4351 });
  assert.equal(options[0].name, 'Vendor Base');
  assert.equal(options[0].sameAs, undefined);
  // A variant carries the base's row and names its base.
  assert.deepEqual(options[1].arena, options[0].arena);
  assert.equal(options[1].sameAs, 'vendor/base');
  assert.deepEqual(options[2].arena, options[0].arena);
  assert.equal(options[2].sameAs, 'vendor/base');
  // A model the leaderboard lists on its own carries its own row.
  assert.equal(options[3].arena?.rank, 9);
  assert.equal(options[4].arena, undefined);
  assert.equal(options[4].sameAs, undefined);
  // The shapes that carry no names keep their IDs only.
  assert.deepEqual(
    parseModelOptions(['plain', { model: 'other' }]).map((option) => [option.id, option.arena]),
    [['plain', undefined], ['other', undefined]],
  );
});

test('the picker sorts by the leaderboard score, strongest first', () => {
  const options = [
    { id: 'b/unscored' },
    { id: 'a/low', arena: { rank: 40, name: 'A Low', score: 4.2 } },
    { id: 'c/high', arena: { rank: 1, name: 'C High', score: 23.38 } },
    { id: 'd/unscored2' },
    { id: 'e/tie', arena: { rank: 41, name: 'E Tie', score: 4.2 } },
  ];
  assert.deepEqual(
    sortModelOptions(options).map((option) => option.id),
    ['c/high', 'a/low', 'e/tie', 'b/unscored', 'd/unscored2'],
  );
});

test('the leaderboard snapshot is read from the RSC payload', () => {
  const payload = 'a:{"snapshot":{"lastUpdated":"2026-11-04T15:00:00.000Z","rows":['
    + '{"rank":2,"model":"B Model","modelOrganization":"Beta","avgScore":{"value":0.1234,"ci":0.01},"sessions":120},'
    + '{"rank":1,"model":"A Model","avgScore":{"value":0.25}},'
    + '{"rank":3,"model":"","avgScore":{"value":0.5}}'
    + ']}}\n';
  const snapshot = parseArenaLeaderboard(payload);
  assert.equal(snapshot.updated, '2026-11-04T15:00:00.000Z');
  assert.deepEqual(snapshot.rows, [
    { rank: 1, name: 'A Model', score: 25 },
    { rank: 2, name: 'B Model', organization: 'Beta', score: 12.34, sessions: 120 },
  ]);
  assert.deepEqual(parseArenaLeaderboard('nothing here').rows, []);
  assert.deepEqual(parseArenaLeaderboard('x:{"snapshot":{').rows, []);
});

test('the published snapshot reads rows from an object or a string', () => {
  const snapshot = parseArenaSnapshot({
    updated: '2026-11-04T15:00:00.000Z',
    rows: [
      { rank: 2, name: 'B Model', score: 12.5, organization: 'Beta', sessions: 10 },
      { rank: 1, name: 'A Model', score: 25 },
      { rank: 3, name: '' },
    ],
  });
  assert.equal(snapshot.updated, '2026-11-04T15:00:00.000Z');
  assert.deepEqual(snapshot.rows, [
    { rank: 1, name: 'A Model', score: 25 },
    { rank: 2, name: 'B Model', score: 12.5, organization: 'Beta', sessions: 10 },
  ]);
  assert.deepEqual(
    parseArenaSnapshot('{"rows":[{"rank":1,"name":"A","score":2}]}').rows,
    [{ rank: 1, name: 'A', score: 2 }],
  );
  assert.deepEqual(parseArenaSnapshot('not json').rows, []);
  assert.deepEqual(parseArenaSnapshot(null).rows, []);
});

test('leaderboard rows match model IDs by name, ignoring tuning and dates', () => {
  const rows = [
    { rank: 1, name: 'Claude Fable 5.1 (Max)', score: 14 },
    { rank: 2, name: 'DeepSeek-V4.1-Flash-20261017 (Max)', score: 3.79 },
    { rank: 3, name: 'GLM-5.3 (Max)', score: 1.47 },
  ];
  assert.equal(arenaRowFor('anthropic/claude-fable-5.1', rows)?.rank, 1);
  assert.equal(arenaRowFor('deepseek/deepseek-v4.1-flash-1017', rows)?.rank, 2);
  assert.equal(arenaRowFor('z-ai/glm-5.3', rows)?.rank, 3);
  assert.equal(arenaRowFor('vendor/unknown', rows), undefined);
  // A variant is scored through its base, not through its own suffix.
  const variant = parseModelOptions([{ id: 'z-ai/glm-5.3' }, { id: 'z-ai/glm-5.3:nitro' }], rows);
  assert.equal(variant[1].arena?.rank, 3);
  assert.equal(variant[1].sameAs, 'z-ai/glm-5.3');
});

/* ----------------------------------------------------------- router catalog */

test('catalog URLs address the model by author and slug', () => {
  assert.deepEqual(
    endpointCandidates('meta-llama/llama-3.3-70b-instruct'),
    ['https://openrouter.ai/api/v1/models/meta-llama/llama-3.3-70b-instruct/endpoints'],
  );
  // A `:free` style suffix rides on the request model, never in the URL.
  assert.deepEqual(
    endpointCandidates('meta-llama/llama-3.3-70b-instruct:free'),
    ['https://openrouter.ai/api/v1/models/meta-llama/llama-3.3-70b-instruct/endpoints'],
  );
  // A custom catalog base has its trailing slashes trimmed; odd IDs are rejected.
  assert.deepEqual(endpointCandidates('deepseek/deepseek-chat', 'https://openrouter.ai/api/v1/'), [
    'https://openrouter.ai/api/v1/models/deepseek/deepseek-chat/endpoints',
  ]);
  assert.deepEqual(endpointCandidates('qwen/qwq 32b'), [
    'https://openrouter.ai/api/v1/models/qwen/qwq%2032b/endpoints',
  ]);
  assert.deepEqual(endpointCandidates('only-slug'), []);
  assert.deepEqual(endpointCandidates('author/'), []);
  assert.deepEqual(endpointCandidates('author/slug', 'ftp://openrouter.ai'), []);
});

test('the catalog proxy round-trips through provider settings', () => {
  const draft = emptyDraft();
  draft.providerID = 'acme';
  draft.name = 'Acme';
  draft.baseURL = 'https://gateway.example/v1';
  draft.apiKey = 'sk-test-1234';
  draft.catalogProxy = 'http://localhost:10808';
  draft.models[0]!.id = 'meta-llama/llama-3.3-70b-instruct';

  const block = buildProvider(draft, {});
  const settings = block.settings as Record<string, unknown>;
  assert.equal(settings.catalogProxy, 'http://localhost:10808');

  const back = draftFrom({ id: 'acme', block, file: 'opencode.json', overlay: false });
  assert.equal(back.catalogProxy, 'http://localhost:10808');

  draft.catalogProxy = '';
  const cleared = buildProvider(draft, block);
  assert.ok(!('catalogProxy' in (cleared.settings as Record<string, unknown>)));
});

test('catalog proxies must be http(s) URLs', () => {
  const draft = emptyDraft();
  draft.providerID = 'acme';
  draft.name = 'Acme';
  draft.baseURL = 'https://gateway.example/v1';
  draft.apiKey = 'sk-test-1234';
  draft.models[0]!.id = 'meta-llama/llama-3.3-70b-instruct';
  draft.catalogProxy = 'localhost:10808';
  assert.equal(
    validateDraft(draft, { existingIDs: [], editingID: null }).catalogProxy,
    'errorCatalogProxy',
  );
  draft.catalogProxy = 'http://localhost:10808';
  assert.equal(validateDraft(draft, { existingIDs: [], editingID: null }).catalogProxy, undefined);
});

test('catalog headers send a bearer only when a key exists', () => {
  assert.deepEqual(endpointHeaders(''), { accept: 'application/json' });
  assert.deepEqual(endpointHeaders('  '), { accept: 'application/json' });
  assert.deepEqual(endpointHeaders('sk-1'), { accept: 'application/json', authorization: 'Bearer sk-1' });
});

test('endpoints are normalised and deduplicated from the catalog response', () => {
  const payload = {
    data: {
      id: 'meta-llama/llama-3.3-70b-instruct',
      endpoints: [
        {
          provider_name: 'DeepInfra',
          tag: 'deepinfra/turbo',
          context_length: 131072,
          max_completion_tokens: 8192,
          quantization: 'fp8',
          pricing: { prompt: '0.0000001', completion: '0.00000032', input_cache_read: '0.00000002', discount: 0.5 },
          supported_parameters: ['tools', 'response_format'],
          status: 0,
          uptime_last_30m: 100,
          uptime_last_1d: 99.5,
          latency_last_30m: 0.4,
          throughput_last_30m: 47.2,
        },
        // Same tag: dropped. Tagless provider: slugified name. Junk: dropped.
        { provider_name: 'DeepInfra', tag: 'deepinfra/turbo' },
        { provider_name: 'No Tag' },
        'junk',
        { tag: 'only-a-tag' },
      ],
    },
  };
  const endpoints = parseEndpoints(payload);
  assert.equal(endpoints.length, 2);
  assert.deepEqual(endpoints[0], {
    slug: 'deepinfra/turbo',
    providerName: 'DeepInfra',
    contextLength: 131072,
    maxCompletionTokens: 8192,
    quantization: 'fp8',
    pricing: { prompt: 0.0000001, completion: 0.00000032, cacheRead: 0.00000002, discount: 0.5 },
    supportedParameters: ['tools', 'response_format'],
    status: 0,
    uptimeLast30m: 100,
    uptimeLast1d: 99.5,
    latencyLast30m: 0.4,
    throughputLast30m: 47.2,
  });
  assert.equal(endpoints[1]!.slug, 'no-tag');
  assert.deepEqual(parseEndpoints({}), []);
});

test('the model page URL shares the catalog model addressing', () => {
  assert.deepEqual(
    modelPageCandidates('meta-llama/llama-3.3-70b-instruct:free'),
    ['https://openrouter.ai/meta-llama/llama-3.3-70b-instruct'],
  );
  assert.deepEqual(modelPageCandidates('only-slug'), []);
});

test('page statistics fill the speed and latency the catalog leaves null', () => {
  // The model page serialises its payload as escaped JSON inside script tags.
  const html = [
    '<script>self.__next_f.push([1,"{\\"data\\":[{\\"id\\":\\"a\\",',
    '\\"provider_slug\\":\\"makora/fp8\\",\\"status\\":0,',
    '\\"stats\\":{\\"endpoint_id\\":\\"e1\\",\\"p50_latency\\":943,\\"p50_throughput\\":69,',
    '\\"request_count\\":19768,\\"window_minutes\\":30},\\"is_zdr\\":true},',
    '{\\"id\\":\\"b\\",\\"provider_slug\\":\\"streamlake\\",\\"status\\":0,',
    '\\"stats\\":{\\"endpoint_id\\":\\"e2\\",\\"p50_latency\\":864,\\"p50_throughput\\":34}},',
    '{\\"id\\":\\"c\\",\\"provider_slug\\":\\"deepinfra/fp4/flex\\",\\"status\\":0}]}"])</script>',
  ].join('');
  const stats = parseEndpointStats(html);
  // Latency converts from the page's milliseconds to the catalog's seconds.
  assert.deepEqual(stats['makora/fp8'], { throughput: 69, latency: 0.943 });
  assert.deepEqual(stats['streamlake'], { throughput: 34, latency: 0.864 });
  // No stats object: no entry, so the panel keeps its placeholder.
  assert.equal(stats['deepinfra/fp4/flex'], undefined);
  assert.deepEqual(parseEndpointStats(''), {});
  assert.deepEqual(parseEndpointStats('<html>no payload here</html>'), {});
});

test('page statistics never overwrite a value the catalog reports', () => {
  const endpoint = (slug: string, throughput: number | null, latency: number | null) => ({
    slug,
    providerName: slug,
    contextLength: null,
    maxCompletionTokens: null,
    quantization: '',
    pricing: { prompt: null, completion: null, cacheRead: null, discount: null },
    supportedParameters: [],
    status: 0,
    uptimeLast30m: null,
    uptimeLast1d: null,
    latencyLast30m: latency,
    throughputLast30m: throughput,
  });
  const merged = mergeEndpointStats(
    [endpoint('a', null, null), endpoint('b', 12, 0.2), endpoint('c', null, null)],
    { a: { throughput: 69, latency: 0.943 }, b: { throughput: 50, latency: 1.5 } },
  );
  assert.deepEqual(
    merged.map((item) => [item.throughputLast30m, item.latencyLast30m]),
    [[69, 0.943], [12, 0.2], [null, null]],
  );
});

/* --------------------------------------------------------- router formatting */

test('prices become dollars per million tokens', () => {
  assert.equal(Math.abs(perMillion(0.0000001)! - 0.1) < 1e-12, true);
  assert.equal(perMillion(null), null);
  assert.equal(priceText(0.0000001), '$0.10');
  assert.equal(priceText(0.00000032), '$0.32');
  assert.equal(priceText(2.19e-6), '$2.19');
  assert.equal(priceText(0), '$0');
  assert.equal(priceText(0.00000005), '$0.05');
  assert.equal(priceText(null), '—');
});

test('speed and reachability read like the catalog measures them', () => {
  assert.equal(throughputText(47.2), '47 tok/s');
  assert.equal(throughputText(9.55), '9.6 tok/s');
  assert.equal(throughputText(0), '—');
  assert.equal(throughputText(null), '—');
  assert.equal(latencyText(0.4), '0.4s');
  assert.equal(latencyText(null), '—');
  assert.equal(uptimeText(99.5), '100%');
  assert.equal(uptimeText(null), '—');
  assert.equal(contextText(131072), '131k');
  assert.equal(contextText(1000000), '1M');
  assert.equal(contextText(null), '—');
});

test('the picker sorts by price and by measured speed', () => {
  const endpoint = (slug: string, prompt: number | null, throughput: number | null) => ({
    slug,
    providerName: slug,
    contextLength: null,
    maxCompletionTokens: null,
    quantization: '',
    pricing: { prompt, completion: prompt === null ? null : prompt * 3, cacheRead: null, discount: null },
    supportedParameters: [],
    status: 0,
    uptimeLast30m: 100,
    uptimeLast1d: null,
    latencyLast30m: null,
    throughputLast30m: throughput,
  });
  const list = [endpoint('a', 0.0000002, 10), endpoint('b', 0.0000001, 80), endpoint('c', null, null)];
  assert.deepEqual(sortEndpoints(list, 'default').map((item) => item.slug), ['a', 'b', 'c']);
  // Price: total prompt+completion, unknown prices sink to the end.
  assert.deepEqual(sortEndpoints(list, 'price').map((item) => item.slug), ['b', 'a', 'c']);
  // Speed: fastest first, unmeasured last.
  assert.deepEqual(sortEndpoints(list, 'speed').map((item) => item.slug), ['b', 'a', 'c']);
});

test('the picker gates on routable http(s) base URLs', () => {
  // The overlay is opt-in per model, so any http(s) endpoint qualifies —
  // OpenRouter and self-hosted OpenRouter-compatible gateways alike.
  assert.equal(isRouterBaseURL('https://openrouter.ai/api/v1'), true);
  assert.equal(isRouterBaseURL('https://gw.internal.simra.cloud/v1'), true);
  assert.equal(isRouterBaseURL('http://localhost:8080/v1'), true);
  assert.equal(isRouterBaseURL('ftp://openrouter.ai'), false);
  assert.equal(isRouterBaseURL('openrouter.ai/api/v1'), false);
  assert.equal(isRouterBaseURL('https://'), false);
  assert.equal(isRouterBaseURL(''), false);
});

/* ------------------------------------------------------------- routing writes */

test('routing reads from the body overlay and writes back with max price', () => {
  const existing = {
    name: 'OpenRouter',
    settings: { baseURL: 'https://openrouter.ai/api/v1', apiKey: '{env:OPENROUTER_API_KEY}' },
    models: {
      coder: {
        body: {
          temperature: 0.2,
          provider: { only: ['deepinfra/turbo'], order: ['deepinfra/turbo', 'together'], allow_fallbacks: false },
        },
      },
    },
  };
  const current = draftFrom({ id: 'gw', block: existing, file: 'f', overlay: false });
  const model = current.models[0]!;
  assert.deepEqual(model.routing, { slugs: ['deepinfra/turbo', 'together'], fallback: false });

  model.routing = { slugs: ['deepinfra/turbo'], fallback: false, maxPrompt: '0.5', maxCompletion: '1.5' };
  const block = buildProvider(current, existing);
  const written = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(written.body, {
    temperature: 0.2,
    provider: {
      only: ['deepinfra/turbo'],
      order: ['deepinfra/turbo'],
      allow_fallbacks: false,
      max_price: { prompt: 0.5, completion: 1.5 },
    },
  });
});

test('clearing routing drops the provider overlay and keeps other body keys', () => {
  const existing = {
    settings: { baseURL: 'https://openrouter.ai/api/v1' },
    models: {
      coder: { body: { temperature: 0.2, provider: { only: ['deepinfra'] } } },
      plain: { body: { provider: { order: ['together'] } } },
    },
  };
  const current = draftFrom({ id: 'gw', block: existing, file: 'f', overlay: false });
  current.models.forEach((model) => {
    // Clearing the picker is an explicit empty routing.
    model.routing = { slugs: [], fallback: true };
  });
  const block = buildProvider(current, existing);
  const models = block.models as Record<string, Record<string, unknown>>;
  assert.deepEqual(models.coder!.body, { temperature: 0.2 });
  assert.equal(models.plain!.body, undefined);
});

test('hand-written provider keys survive a routing change', () => {
  const existing = {
    settings: { baseURL: 'https://openrouter.ai/api/v1' },
    models: {
      coder: {
        body: {
          provider: {
            data_collection: 'deny',
            quantizations: ['fp8'],
            max_price: { prompt: 1, image: 2 },
          },
        },
      },
    },
  };
  const current = draftFrom({ id: 'gw', block: existing, file: 'f', overlay: false });
  // A max price alone is a routing the picker owns, even without slugs.
  assert.deepEqual(current.models[0]!.routing, { slugs: [], fallback: true, maxPrompt: '1' });
  current.models[0]!.routing = { slugs: ['deepinfra'], fallback: true, maxCompletion: '2' };
  const block = buildProvider(current, existing);
  const written = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(written.body, {
    provider: {
      data_collection: 'deny',
      quantizations: ['fp8'],
      only: ['deepinfra'],
      order: ['deepinfra'],
      allow_fallbacks: true,
      max_price: { image: 2, completion: 2 },
    },
  });
});

test('max price rejects values that are not finite numbers', () => {
  const current = draft();
  current.models[0]!.routing = { slugs: [], fallback: true, maxPrompt: '0.5' };
  assert.equal(validateDraft(current, { existingIDs: [], editingID: null }).models, undefined);
  // A negative cap is OpenRouter's unset sentinel: it round-trips and saves.
  current.models[0]!.routing = { slugs: [], fallback: true, maxPrompt: '-1' };
  assert.equal(validateDraft(current, { existingIDs: [], editingID: null }).models, undefined);
  current.models[0]!.routing = { slugs: [], fallback: true, maxPrompt: '', maxCompletion: 'abc' };
  assert.equal(validateDraft(current, { existingIDs: [], editingID: null }).models, 'errorMaxPrice');
});

test('a routing the panel never read leaves the body untouched', () => {
  const existing = {
    settings: { baseURL: 'https://openrouter.ai/api/v1' },
    models: {
      a: { body: { temperature: 0.7, provider: { data_collection: 'deny' } } },
      b: { body: { provider: { allow_fallbacks: false } } },
      c: { body: { provider: { max_price: { image: 2 } } } },
    },
  };
  const current = draftFrom({ id: 'gw', block: existing, file: 'f', overlay: false });
  // None of these parse as a picker routing, so no save may rewrite them.
  const models = current.models;
  assert.equal(models.find((model) => model.id === 'a')!.routing, undefined);
  assert.equal(models.find((model) => model.id === 'b')!.routing, undefined);
  assert.equal(models.find((model) => model.id === 'c')!.routing, undefined);
  const block = buildProvider(current, existing);
  const written = block.models as Record<string, Record<string, unknown>>;
  assert.deepEqual(written.a!.body, { temperature: 0.7, provider: { data_collection: 'deny' } });
  assert.deepEqual(written.b!.body, { provider: { allow_fallbacks: false } });
  assert.deepEqual(written.c!.body, { provider: { max_price: { image: 2 } } });
});

test('clearing the selection keeps hand-written extras', () => {
  const existing = {
    settings: { baseURL: 'https://openrouter.ai/api/v1' },
    models: {
      coder: {
        body: {
          temperature: 0.2,
          provider: {
            only: ['deepinfra'],
            order: ['deepinfra'],
            allow_fallbacks: false,
            data_collection: 'deny',
            max_price: { prompt: 1, image: 2 },
          },
        },
      },
    },
  };
  const current = draftFrom({ id: 'gw', block: existing, file: 'f', overlay: false });
  current.models[0]!.routing = { slugs: [], fallback: true };
  const block = buildProvider(current, existing);
  const written = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(written.body, {
    temperature: 0.2,
    provider: { data_collection: 'deny', max_price: { image: 2 } },
  });
});

test('numeric max prices round-trip without blocking saves', () => {
  const existing = {
    settings: { baseURL: 'https://openrouter.ai/api/v1' },
    models: {
      coder: { body: { provider: { max_price: { prompt: 1e-7, completion: 2.5 } } } },
    },
  };
  const current = draftFrom({ id: 'gw', block: existing, file: 'f', overlay: false });
  assert.deepEqual(current.models[0]!.routing, {
    slugs: [],
    fallback: true,
    maxPrompt: '0.0000001',
    maxCompletion: '2.5',
  });
  const block = buildProvider(current, existing);
  const written = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(written.body, { provider: { max_price: { prompt: 1e-7, completion: 2.5 } } });
  // And the form accepts the round-tripped text.
  const check = draft();
  check.models[0]!.routing = {
    slugs: ['deepinfra'],
    fallback: true,
    maxPrompt: '0.0000001',
    maxCompletion: '2.5',
  };
  assert.equal(validateDraft(check, { existingIDs: [], editingID: null }).models, undefined);
});

test('the -1 unset-pricing sentinel reads as no price', () => {
  const endpoints = parseEndpoints({
    data: {
      endpoints: [{
        provider_name: 'Alpha',
        tag: 'alpha',
        pricing: { prompt: '-1', completion: -1, input_cache_read: '0' },
      }],
    },
  });
  assert.deepEqual(endpoints[0]!.pricing, { prompt: null, completion: null, cacheRead: 0, discount: null });
  // Neither a raw sentinel nor a normalized one may render as a bogus price.
  assert.equal(priceText(-1), '—');
  assert.equal(priceText(null), '—');
});

