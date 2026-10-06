const byId = (id) => document.getElementById(id);
const fileInput = byId('file-input');
const iframe = byId('preview');
let image = null;
let result = null;
let controller = null;
let revision = 0;
let busy = false;

function showError(message) {
	byId('error').textContent = message;
	byId('error').hidden = !message;
}

function updateControls() {
	const hasPreview = busy || Boolean(result);
	byId('workspace').classList.toggle('has-preview', hasPreview);
	byId('preview-panel').hidden = !hasPreview;
	byId('source-heading').hidden = !image;
	byId('generate').disabled = !image || busy;
	byId('generate').hidden = !image || Boolean(result) || busy;
	byId('retry').disabled = busy;
	byId('download').disabled = busy;
	byId('choose').disabled = busy;
	byId('reset').hidden = !image && !busy;
	byId('result-actions').hidden = !result;
	byId('loading').hidden = !busy;
	byId('preview-stage').setAttribute('aria-busy', String(busy));
	iframe.hidden = !result;
}

function clearSession() {
	revision += 1;
	controller?.abort();
	controller = null;
	image = null;
	result = null;
	busy = false;
	fileInput.value = '';
	byId('sketch-image').removeAttribute('src');
	byId('preview-html').value = '';
	iframe.src = 'about:blank';
	byId('selected-image').hidden = true;
	byId('upload-empty').hidden = false;
	byId('notice').textContent = '';
	showError('');
	updateControls();
}

async function normalizeImage(file) {
	if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
	if (file.size > 5 * 1024 * 1024) throw new Error('Your sketch must be smaller than 5 MB.');
	let bitmap;
	try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
	catch { throw new Error('This image could not be opened. Try another PNG, JPEG, or WebP.'); }
	try {
		if (bitmap.width * bitmap.height > 40_000_000) throw new Error('This image is too large. Please resize it before uploading.');
		const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext('2d');
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/jpeg', 0.94);
	} finally { bitmap.close(); }
}

async function selectFile(file) {
	if (!file || busy) return;
	showError('');
	const currentRevision = ++revision;
	try {
		const normalized = await normalizeImage(file);
		if (currentRevision !== revision) return;
		clearSession();
		image = normalized;
		byId('sketch-image').src = image;
		byId('filename').textContent = file.name || 'Pasted sketch';
		byId('selected-image').hidden = false;
		byId('upload-empty').hidden = true;
		updateControls();
		byId('generate').focus();
	} catch (error) {
		if (currentRevision === revision) showError(error.message);
		fileInput.value = '';
	}
}

function feedback(action) {
	if (!result) return;
	void fetch('/api/feedback', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, id: result.id }),
		keepalive: true,
	}).catch(() => {});
}

async function generate(retry = false) {
	if (!image || busy) return;
	if (retry) feedback('retry');
	const currentRevision = revision;
	const activeController = new AbortController();
	controller = activeController;
	const previous = result;
	busy = true;
	showError('');
	byId('notice').textContent = '';
	updateControls();
	const timeout = setTimeout(() => activeController.abort(), 190_000);
	try {
		const response = await fetch('/api/generate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ image, ...(retry && previous ? { previousHtml: previous.html, ocr: previous.ocr } : {}) }),
			signal: activeController.signal,
		});
		let data;
		try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
		if (!response.ok) throw new Error(data.error || 'The page could not be generated. Please try again.');
		if (!data.html || !data.id || typeof data.ocr !== 'string') throw new Error('The generated result was incomplete. Please try again.');
		if (currentRevision !== revision) return;
		result = data;
		byId('preview-html').value = result.html;
		byId('preview-form').submit();
		byId('notice').textContent = 'Webpage ready. Download or retry.';
	} catch (error) {
		if (currentRevision !== revision) return;
		showError(error.name === 'AbortError' ? 'Generation took too long. Please try again.' : error.message);
	} finally {
		clearTimeout(timeout);
		if (currentRevision === revision) {
			busy = false;
			controller = null;
			updateControls();
		}
	}
}

byId('choose').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => selectFile(fileInput.files[0]));
byId('reset').addEventListener('click', () => { clearSession(); byId('choose').focus(); });
byId('generate').addEventListener('click', () => generate());
byId('retry').addEventListener('click', () => generate(true));
byId('download').addEventListener('click', () => {
	if (!result || busy) return;
	const url = URL.createObjectURL(new Blob([result.html], { type: 'text/html;charset=utf-8' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = 'my-webpage.html';
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
	feedback('download');
	byId('notice').textContent = 'HTML downloaded.';
});

const dropzone = byId('dropzone');
let dragDepth = 0;
for (const event of ['dragenter', 'dragover', 'dragleave', 'drop']) {
	dropzone.addEventListener(event, (e) => {
		e.preventDefault();
		if (event === 'dragenter') dragDepth += 1;
		if (event === 'dragleave') dragDepth = Math.max(0, dragDepth - 1);
		if (event === 'drop') {
			dragDepth = 0;
			void selectFile(e.dataTransfer.files[0]);
		}
		dropzone.classList.toggle('dragging', dragDepth > 0 && !busy);
	});
}
// Prevent a dropped file outside the upload area from navigating away from the session.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
document.addEventListener('paste', (event) => {
	const file = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith('image/'));
	if (file && !busy) { event.preventDefault(); void selectFile(file); }
});
window.addEventListener('pagehide', () => clearSession());
updateControls();
