// The bridge this page talks to. Requests stay relative to the page, never to the origin: the same
// build is served from 127.0.0.1 and from a tunnel prefix (/t/<id>/), and the token rides along as
// a query parameter.
export const token = new URLSearchParams(location.search).get("t") ?? "";
export const base = location.pathname.replace(/\/(?:index\.html)?$/, "");

export const api = (path) => `${base}/api/${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;

/**
 * Bytes -> a file in nife's temp upload dir. XHR instead of fetch so a chip can show progress.
 * Shared by the composer and the inline prompt editor, which both accept dropped files.
 */
export function uploadFile(file, onProgress) {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", api("upload"));
		request.setRequestHeader("x-file-name", encodeURIComponent(file.name || "file"));
		request.upload.onprogress = (event) => {
			if (event.lengthComputable) onProgress(event.loaded / event.total);
		};
		request.onload = () => {
			if (request.status < 200 || request.status >= 300) {
				reject(new Error((request.responseText || `upload failed (${request.status})`).slice(0, 200)));
				return;
			}
			try {
				resolve(JSON.parse(request.responseText));
			} catch {
				reject(new Error("bad upload response"));
			}
		};
		request.onerror = () => reject(new Error("upload failed"));
		request.send(file);
	});
}
