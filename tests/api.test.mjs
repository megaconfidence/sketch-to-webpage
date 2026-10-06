import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPath, createApp, image, origin, sampleHtml } from './helpers.mjs';

async function usingApp(fn, options) {
	const app = await createApp(options);
	try { await fn(app); } finally { await app.dispose(); }
}

test('serves the actual app and protects its origin', { timeout: 20000 }, () => usingApp(async (app) => {
	const response = await app.runtime.dispatchFetch(origin + '/');
	assert.equal(response.status, 200);
	const html = await response.text();
	assert.match(html, /<h1>Sketch to webpage<\/h1>/);
	assert.match(html, /id="preview-panel"[^>]*hidden/);
	assert.doesNotMatch(html, /paper-illustration|browser-illustration|viewport-switch|class="steps"/);
	assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
	const script = await app.runtime.dispatchFetch(origin + '/app.js');
	assert.equal(script.status, 200);
	const source = await script.text();
	assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
	const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
	for (const [, id] of source.matchAll(/byId\('([^']+)'\)/g)) assert.ok(ids.has(id), 'Missing UI element: ' + id);
}));

test('runs OCR and vision, reuses OCR on retry, and serves the exact HTML through a Dynamic Worker', { timeout: 20000 }, () => usingApp(async (app) => {
	const first = await app.post('/api/generate', { image });
	assert.equal(first.status, 200, await first.clone().text());
	assert.equal(first.headers.get('Cache-Control'), 'no-store');
	const result = await first.json();
	assert.match(result.html, /Content-Security-Policy/);
	assert.match(result.ocr, /Garden club/);
	assert.deepEqual(app.calls.map(call => call.path), ['/v1/ocr', chatPath]);
	assert.equal(app.calls[0].body.include_image_base64, false);
	assert.equal(app.calls[0].body.include_blocks, true);
	assert.equal(app.calls[1].body.model, 'mistral-large-4-0');
	assert.equal(app.calls[1].body.messages[1].content[1].image_url, image);
	assert.equal(app.calls[1].body.max_tokens, 12000);
	assert.equal(app.calls[1].body.reasoning_effort, 'none');
	assert.equal(app.calls[1].body.response_format.type, 'json_schema');
	assert.deepEqual(app.calls[1].body.response_format.json_schema.schema.required, ['html']);
	const preview = await app.preview(result.html);
	assert.equal(preview.status, 200);
	assert.equal(await preview.text(), result.html);
	assert.match(preview.headers.get('Content-Security-Policy'), /sandbox allow-scripts/);
	assert.match(preview.headers.get('Content-Security-Policy'), /connect-src 'none'/);
	assert.equal(preview.headers.get('Cache-Control'), 'no-store');
	const retry = await app.post('/api/generate', { image, previousHtml: result.html, ocr: result.ocr });
	assert.equal(retry.status, 200);
	assert.equal(app.calls.length, 3);
	assert.match(app.calls[2].body.messages[1].content[0].text, /user rejected/);
	assert.ok(app.calls[2].body.messages[1].content[0].text.includes(result.html));
	assert.notEqual((await retry.json()).id, result.id);
}));

test('rejects missing or cross-origin callers before contacting Mistral', { timeout: 20000 }, () => usingApp(async (app) => {
	const response = await app.post('/api/generate', { image }, { Origin: 'https://untrusted.example' });
	assert.equal(response.status, 403);
	const opaque = await app.post('/api/generate', { image }, { Origin: 'null' });
	assert.equal(opaque.status, 403);
	assert.equal(app.calls.length, 0);
}));

test('rejects malformed image data and unsupported content types', { timeout: 20000 }, () => usingApp(async (app) => {
	for (const input of [{}, { image: 'https://example.com/sketch.png' }, { image: 'data:image/png;base64,aGVsbG8=' }, { image, ocr: {} }]) {
		assert.equal((await app.post('/api/generate', input)).status, 400);
	}
	assert.equal((await app.post('/api/generate', { image }, { 'Content-Type': 'text/plain' })).status, 415);
	assert.equal(app.calls.length, 0);
}));

test('rejects oversized body and previous output', { timeout: 20000 }, () => usingApp(async (app) => {
	assert.equal((await app.post('/api/generate', { image, previousHtml: 'x'.repeat(300001) })).status, 400);
	assert.equal((await app.post('/api/generate', { image: 'x'.repeat(8 * 1024 * 1024) })).status, 413);
	assert.equal(app.calls.length, 0);
}));

test('returns a useful configuration error without calling Mistral', { timeout: 20000 }, () => usingApp(async (app) => {
	const response = await app.post('/api/generate', { image });
	assert.equal(response.status, 503);
	assert.match((await response.json()).error, /MISTRAL_API_KEY/);
	assert.equal(app.calls.length, 0);
}, { key: '' }));

test('sanitizes provider failures without forwarding sensitive content', { timeout: 20000 }, () => usingApp(async (app) => {
	const response = await app.post('/api/generate', { image });
	assert.equal(response.status, 502);
	assert.doesNotMatch(await response.text(), /Sensitive upstream failure|test-key|base64/);
}, { upstreamStatus: 401 }));

test('sanitizes generation authentication failures', { timeout: 20000 }, () => usingApp(async (app) => {
	const response = await app.post('/api/generate', { image });
	assert.equal(response.status, 502);
	const body = await response.text();
	assert.match(body, /Mistral rejected the API key/);
	assert.doesNotMatch(body, /Sensitive chat failure|test-key/);
}, { chatStatus: 403 }));

test('does not silently retry a busy provider', { timeout: 20000 }, () => usingApp(async (app) => {
	assert.equal((await app.post('/api/generate', { image })).status, 429);
	assert.equal(app.calls.filter((call) => call.path === chatPath).length, 1);
}, { chatStatus: 429 }));

test('reports generation rate limits', { timeout: 20000 }, () => usingApp(async (app) => {
	const response = await app.post('/api/generate', { image });
	assert.equal(response.status, 429);
	assert.match((await response.json()).error, /Mistral is busy/);
}, { chatStatus: 429 }));

test('reports missing Mistral credits', { timeout: 20000 }, () => usingApp(async (app) => {
	const response = await app.post('/api/generate', { image });
	assert.equal(response.status, 502);
	assert.match((await response.json()).error, /needs API credits/);
}, { chatStatus: 402 }));

test('rejects truncated model output instead of returning a broken page', { timeout: 20000 }, () => usingApp(async (app) => {
	const response = await app.post('/api/generate', { image });
	assert.equal(response.status, 502);
	assert.match((await response.json()).error, /cut off/);
}, { finishReason: 'length' }));

test('rejects incomplete model output', { timeout: 20000 }, () => usingApp(async (app) => {
	const response = await app.post('/api/generate', { image });
	assert.equal(response.status, 502);
	assert.match((await response.json()).error, /complete webpage/);
}, { html: '<h1>Incomplete</h1>' }));

test('strips refresh and base tags and adds offline restrictions', { timeout: 20000 }, () => usingApp(async (app) => {
	const response = await app.post('/api/generate', { image });
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.doesNotMatch(result.html, /http-equiv="refresh"|<base/i);
	assert.match(result.html, /form-action 'none'/);
}, { html: sampleHtml.replace('<head>', '<head><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example">') }));

test('rate limits generation calls before spending API credits', { timeout: 20000 }, () => usingApp(async (app) => {
	for (let i = 0; i < 6; i++) assert.equal((await app.post('/api/generate', {})).status, 400);
	assert.equal((await app.post('/api/generate', { image })).status, 429);
	assert.equal(app.calls.length, 0);
}));

test('records only download/retry decisions and generated IDs', { timeout: 20000 }, () => usingApp(async (app) => {
	const id = '12345678-1234-1234-1234-123456789abc';
	for (const action of ['download', 'retry']) assert.equal((await app.post('/api/feedback', { action, id, image: 'must-not-be-logged' })).status, 200);
	assert.equal((await app.post('/api/feedback', { action: 'unknown', id })).status, 400);
	const recorded = JSON.stringify(app.logs);
	assert.doesNotMatch(recorded, /must-not-be-logged|test-key/);
	assert.match(recorded, /feedback/);
}));

test('rejects invalid preview forms and unsupported API methods', { timeout: 20000 }, () => usingApp(async (app) => {
	assert.equal((await app.preview('')).status, 400);
	assert.equal((await app.post('/api/preview', { html: sampleHtml })).status, 415);
	assert.equal((await app.runtime.dispatchFetch(origin + '/api/generate')).status, 405);
}));
