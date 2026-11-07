/**
 * Development preview. Runs the real panel against an in-memory config so the
 * layout, theme and interactions can be checked without installing the
 * extension. Not part of the shipped package.
 *
 *   npm run preview        # builds preview/preview.js
 *   open preview/index.html
 */
import { ProviderPanel, type PanelHost } from '../../panel/app';
import { localeOf } from '../../panel/i18n';

const STORAGE_KEY = 'openchamber-providers-preview';

const seed = {
  '~/.config/opencode/opencode.json': JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    providers: {
      relay_fast: {
        name: 'relay.fast',
        package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'https://relay.fast/v1' },
        models: {
          'deepseek-v4.1-flash': {
            modelID: 'deepseek-v4.1-flash',
            name: 'DeepSeek V4.1 Flash',
            capabilities: {
              tools: true,
              input: ['text', 'image'],
              output: ['text'],
              reasoning: { supported: true, effort: ['low', 'medium', 'high'] },
            },
            limit: { context: 1000000, output: 128000 },
          },
          'gpt-6.1-sol': {
            modelID: 'gpt-6.1-sol',
            name: 'GPT-6.1 Sol',
            limit: { context: 272000, output: 128000 },
          },
        },
      },
      sharellm_net: {
        name: 'sharellm.net',
        package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'https://sharellm.net/v1', apiKey: 'sk-OMLcn4woAmbFqYXOPQ0hmKjgyy6WdYQKMLqCkCWTHGrISEKc' },
        models: {
          'deepseek-v4.1-flash': { modelID: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
        },
      },
      anthropic: { settings: { baseURL: 'https://proxy.example.com/anthropic' } },
      openrouter: {
        name: 'OpenRouter',
        package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'https://openrouter.ai/api/v1', apiKey: '{env:OPENROUTER_API_KEY}' },
        models: {
          'meta-llama/llama-3.3-70b-instruct': {
            modelID: 'meta-llama/llama-3.3-70b-instruct',
            name: 'Llama 3.3 70B Instruct',
            capabilities: {
              tools: true,
              input: ['text'],
              output: ['text'],
              reasoning: { supported: true, effort: ['low', 'high'] },
            },
          },
        },
      },
    },
    model: 'relay_fast/deepseek-v4.1-flash',
  }, null, 2) + '\n',
};

const files: Record<string, string> = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    // fall through to the seed
  }
  return { ...seed };
})();

const save = (): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
};

const host: PanelHost = {
  stat: async (path) => ({ kind: path in files ? 'file' : 'missing' }),
  readFile: async (path) => ({ content: files[path] ?? '' }),
  writeFile: async (path, content) => {
    files[path] = content;
    save();
    return { written: true };
  },
  toast: async (request) => {
    const node = document.createElement('div');
    node.className = 'preview-toast';
    node.dataset.tone = request.kind;
    node.textContent = request.message;
    document.body.append(node);
    setTimeout(() => node.remove(), 2600);
    return undefined;
  },
  fetchModels: async ({ baseURL }) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (baseURL.includes('bad')) throw new Error('HTTP 401 Unauthorized');
    return [
      'deepseek-v4.1-flash',
      'deepseek-v4.1-pro',
      'gpt-6.1-sol',
      'claude-sonnet-4-5',
      'qwen3-coder',
    ];
  },
  // Fake OpenRouter catalog so the provider picker is browsable in preview.
  fetchProviders: async ({ baseURL }) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!baseURL.includes('openrouter')) throw new Error('HTTP 404 Not Found');
    const endpoint = (
      slug: string,
      providerName: string,
      prompt: string,
      completion: string,
      throughput: number | null,
      latency: number | null,
      quantization = '',
    ) => ({
      slug,
      providerName,
      contextLength: 131072,
      maxCompletionTokens: 8192,
      quantization,
      pricing: { prompt, completion, cacheRead: '0', discount: 0 },
      supportedParameters: ['tools'],
      status: 0,
      uptimeLast30m: 100,
      uptimeLast1d: 99.8,
      latencyLast30m: latency,
      throughputLast30m: throughput,
    });
    return [
      endpoint('deepinfra/turbo', 'DeepInfra', '0.00000006', '0.00000024', 42, 0.4, 'fp8'),
      endpoint('together', 'Together', '0.00000005', '0.00000020', 61, 0.3),
      endpoint('fireworks', 'Fireworks AI', '0.00000009', '0.00000027', 88, 0.2),
      endpoint('amazon-bedrock', 'Amazon Bedrock', '0.00000016', '0.00000048', null, null),
    ];
  },
};

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('#root is missing');
const panel = new ProviderPanel(root, host);
document.addEventListener('keydown', (event) => panel.handleKeydown(event));

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.ocTheme = theme;
document.documentElement.classList.toggle('dark', theme === 'dark');
document.documentElement.dataset.ocSurface = params.get('surface') === 'rail' ? 'panel' : 'page';
document.documentElement.dataset.surface = document.documentElement.dataset.ocSurface;
panel.setLocale(localeOf(params.get('locale') ?? 'zh'));
void panel.start();

const reset = document.querySelector('#reset');
reset?.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

