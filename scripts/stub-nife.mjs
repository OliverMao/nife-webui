// Stand-in for `nife-coding-agent` used by scripts/smoke.mjs so the extension can be
// imported without a nife checkout.
export const SessionManager = {
	list: async () => [
		{ path: "/fake/old.jsonl", id: "old", name: "Old", cwd: "/tmp", modified: new Date(0), messageCount: 2, firstMessage: "hi" },
	],
};
