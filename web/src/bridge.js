// The bridge this page talks to. Requests stay relative to the page, never to the origin: the same
// build is served from 127.0.0.1 and from a tunnel prefix (/t/<id>/), and the token rides along as
// a query parameter.
export const token = new URLSearchParams(location.search).get("t") ?? "";
export const base = location.pathname.replace(/\/(?:index\.html)?$/, "");

/**
 * Session the page is looking at. "host" is the terminal's own session; anything else is a
 * background runtime the bridge keeps alive while the reader moves between conversations. Every
 * per-session call names it, so switching a view never stops a turn.
 */
let sid = sessionStorage.getItem("nife-webui.sid") || "host";
let sessionPath = sessionStorage.getItem("nife-webui.sid-path") || "";
export const sessionSid = () => sid;
/** Where the sid points, so a reload (or a bridge restart) can open the same conversation again. */
export const sessionFile = () => sessionPath;
export const setSessionSid = (value, file) => {
	sid = typeof value === "string" && value ? value : "host";
	if (typeof file === "string") sessionPath = file;
	if (sid === "host") sessionStorage.removeItem("nife-webui.sid");
	else sessionStorage.setItem("nife-webui.sid", sid);
	if (sessionPath) sessionStorage.setItem("nife-webui.sid-path", sessionPath);
	else sessionStorage.removeItem("nife-webui.sid-path");
};

export const api = (path) =>
	`${base}/api/${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}&sid=${encodeURIComponent(sid)}`;

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
