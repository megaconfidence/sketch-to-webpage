import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const chatPath = '/v1/chat/completions';
export const origin = 'http://sketch.test';
export const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBykAAAAASUVORK5CYII=';
export const sampleHtml = '<!doctype html><html><head><title>Garden club</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{background:#f6f2e8;color:#243e2a;font-family:system-ui;padding:32px}button{background:#396440;color:white;padding:12px;border:0;border-radius:8px}</style></head><body><h1>Garden club</h1><button id="join">Join us</button><p id="message"></p><script>document.getElementById("join").onclick=()=>document.getElementById("message").textContent="Welcome!";</script></body></html>';

export async function createApp({ key = 'test-key', html = sampleHtml, upstreamStatus = 200, chatStatus = 200, finishReason = 'stop' } = {}) {
	const config = JSON.parse(await readFile(root + 'wrangler.jsonc', 'utf8'));
	const bundle = await build({ entryPoints: [root + 'src/index.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
	const calls = [];
	const logs = [];
	const options = convertV4MiniflareOptions({
		name: config.name,
		script: bundle.outputFiles[0].text,
		modules: true,
		compatibilityDate: config.compatibility_date,
		bindings: { ...config.vars, MISTRAL_API_KEY: key },
		workerLoaders: Object.fromEntries(config.worker_loaders.map(({ binding }) => [binding, {}])),
		ratelimits: Object.fromEntries(config.ratelimits.map(({ name, ...value }) => [name, value])),
		serviceBindings: { ASSETS: async (request) => {
			const path = new URL(request.url).pathname;
			const files = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
			const file = files[path] ?? (/^\/samples\/(thumbs\/)?[a-z]+\.jpg$/.test(path) ? [path.slice(1), 'image/jpeg'] : undefined);
			if (!file) return new RuntimeResponse('Not found', { status: 404 });
			return new RuntimeResponse(await readFile(root + 'public/' + file[0]), { headers: { 'Content-Type': file[1] } });
		} },
		outboundService: async (request) => {
			const url = new URL(request.url);
			const body = await request.json();
			calls.push({ path: url.pathname, body });
			if (url.origin === 'https://api.mistral.ai' && url.pathname === '/v1/ocr') {
				if (request.headers.get('Authorization') !== 'Bearer ' + key) throw new Error('Incorrect OCR credential');
				if (upstreamStatus !== 200) return new RuntimeResponse('Sensitive upstream failure', { status: upstreamStatus });
				return RuntimeResponse.json({ pages: [{ markdown: 'Garden club', blocks: [{ type: 'title', content: 'Garden club', top_left_x: 20, top_left_y: 20, bottom_right_x: 240, bottom_right_y: 80 }] }] });
			}
			if (url.origin === 'https://api.mistral.ai' && url.pathname === chatPath) {
				if (request.headers.get('Authorization') !== 'Bearer ' + key) throw new Error('Incorrect chat credential');
				if (chatStatus !== 200) return new RuntimeResponse('Sensitive chat failure', { status: chatStatus });
				// reasoning_effort "none" returns content as a plain string.
				return RuntimeResponse.json({
					choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: JSON.stringify({ html }) } }],
					usage: { prompt_tokens: 1043, completion_tokens: 1232, total_tokens: 2275 },
				});
			}
			throw new Error('Unexpected outbound request');
		},
	});
	options.handleStructuredLogs = (log) => logs.push(log);
	const runtime = new Miniflare(options);
	return {
		runtime, calls, logs,
		async post(path, body, headers = {}) {
			return runtime.dispatchFetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
		},
		async preview(html) {
			return runtime.dispatchFetch(origin + '/api/preview', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ html }) });
		},
		async dispose() { await runtime.dispose(); },
	};
}
