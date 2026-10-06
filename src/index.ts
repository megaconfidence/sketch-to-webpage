import { AppError, extractText, generateHtml, MAX_HTML_LENGTH, validateInput } from './generation';
import { protectHtml, renderPreview } from './preview';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const APP_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function readBody(request: Request, limit: number): Promise<string> {
	if (Number(request.headers.get('Content-Length')) > limit) throw new AppError(413, 'This request is too large. Use a sketch smaller than 5 MB.');
	const reader = request.body?.getReader();
	if (!reader) throw new AppError(400, 'The request is empty.');
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) {
				await reader.cancel();
				throw new AppError(413, 'This request is too large. Use a sketch smaller than 5 MB.');
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally { reader.releaseLock(); }
}

async function readJson(request: Request, limit: number): Promise<unknown> {
	if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new AppError(415, 'Send a JSON request.');
	const body = await readBody(request, limit);
	try { return JSON.parse(body); } catch { throw new AppError(400, 'The request could not be read. Please try again.'); }
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith('/api/')) {
			const response = await env.ASSETS.fetch(request);
			const headers = new Headers(response.headers);
			headers.set('Content-Security-Policy', APP_POLICY);
			headers.set('X-Content-Type-Options', 'nosniff');
			headers.set('Referrer-Policy', 'no-referrer');
			headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
			return new Response(response.body, { status: response.status, headers });
		}
		try {
			if (request.method !== 'POST') throw new AppError(405, 'Use POST for this endpoint.');
			// Forms targeting a sandboxed frame use an opaque origin. Only the unprivileged preview route accepts it.
			const opaquePreview = url.pathname === '/api/preview' && request.headers.get('Origin') === 'null';
			if (request.headers.get('Origin') !== url.origin && !opaquePreview) throw new AppError(403, 'This request must come from the app.');

			if (url.pathname === '/api/generate') {
				if (!env.MISTRAL_API_KEY) throw new AppError(503, 'Add MISTRAL_API_KEY to .env locally or to the Worker secrets in production.');
				const { success } = await env.GENERATION_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' });
				if (!success) throw new AppError(429, 'Too many generations. Wait a minute before trying again.');
				const input = validateInput(await readJson(request, MAX_REQUEST_BYTES));
				const signal = AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]);
				const ocr = input.ocr !== undefined ? input.ocr : await extractText(input.image, env, signal);
				const html = await protectHtml(await generateHtml(input, ocr, env, signal));
				if (html.length > MAX_HTML_LENGTH) throw new AppError(502, 'The generated page is too large. Please retry.');
				return json({ id: crypto.randomUUID(), html, ocr });
			}

			if (url.pathname === '/api/preview') {
				if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new AppError(415, 'Send a preview form.');
				const html = new URLSearchParams(await readBody(request, MAX_HTML_LENGTH * 4)).get('html');
				if (!html || html.length > MAX_HTML_LENGTH) throw new AppError(400, 'The preview is empty or too large.');
				return await renderPreview(html, env);
			}

			if (url.pathname === '/api/feedback') {
				const value = await readJson(request, 1024) as { action?: unknown; id?: unknown } | null;
				if (!value || !['download', 'retry'].includes(String(value.action)) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) throw new AppError(400, 'Invalid feedback.');
				// Only the decision and random generation ID are recorded, never user content.
				console.log(JSON.stringify({ event: 'feedback', action: value.action, generationId: value.id }));
				return json({ ok: true });
			}
			throw new AppError(404, 'Endpoint not found.');
		} catch (error) {
			if (error instanceof AppError) return json({ error: error.message }, error.status);
			if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return json({ error: 'Generation timed out or was cancelled. Please try again.' }, 504);
			// Do not log upstream errors or request bodies: either may contain sketch data.
			console.error(JSON.stringify({ event: 'request_failed', endpoint: url.pathname === '/api/generate' ? 'generate' : 'other' }));
			return json({ error: 'Something went wrong. Please try again.' }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
