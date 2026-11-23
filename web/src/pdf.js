// PDF text extraction for the Chat workspace. pdf.js is loaded only after a PDF is dropped, so the
// normal page does not pay for it. The worker URL is emitted by Vite as a separate asset.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let pdfjsPromise;

async function loadPdfjs() {
	if (!pdfjsPromise) {
		pdfjsPromise = import("pdfjs-dist/build/pdf.min.mjs").then((pdfjs) => {
			pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
			return pdfjs;
		});
	}
	return pdfjsPromise;
}

/** Plain text of a PDF, page by page. Scanned/image-only PDFs return nothing. */
export async function pdfText(file) {
	const pdfjs = await loadPdfjs();
	const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
	const pdf = await task.promise;
	try {
		const pages = [];
		const limit = Math.min(pdf.numPages, 200);
		for (let number = 1; number <= limit; number += 1) {
			const page = await pdf.getPage(number);
			const content = await page.getTextContent();
			let line = "";
			const lines = [];
			for (const item of content.items) {
				if (typeof item?.str !== "string") continue;
				line += item.str;
				if (item.hasEOL) {
					lines.push(line);
					line = "";
				} else {
					line += " ";
				}
			}
			if (line) lines.push(line);
			pages.push(lines.join("\n").trim());
			if (pages.join("\n\n").length > 300_000) break;
		}
		return pages.filter(Boolean).join("\n\n");
	} finally {
		await task.destroy();
	}
}
