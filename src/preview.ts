export const PAGE_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

export async function protectHtml(html: string): Promise<string> {
	return new HTMLRewriter()
		.on('meta[http-equiv]', { element(element) { element.remove(); } })
		.on('base', { element(element) { element.remove(); } })
		.on('head', { element(element) {
			element.prepend('<meta http-equiv="Content-Security-Policy" content="' + PAGE_POLICY + '">', { html: true });
		} })
		.transform(new Response(html))
		.text();
}

export async function renderPreview(html: string, env: Env): Promise<Response> {
	const worker = env.LOADER.load({
		compatibilityDate: '2026-09-21',
		mainModule: 'preview.js',
		modules: {
			'preview.js': 'import html from "./page.html"; export default { fetch() { return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }); } };',
			'page.html': { text: html },
		},
		env: {},
		globalOutbound: null,
		limits: { cpuMs: 20, subRequests: 1 },
	});
	const result = await worker.getEntrypoint().fetch(new Request('https://preview.invalid/'));
	return new Response(result.body, { headers: {
		'Content-Type': 'text/html; charset=utf-8',
		'Content-Security-Policy': PAGE_POLICY + "; sandbox allow-scripts; frame-ancestors 'self'",
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
	} });
}
