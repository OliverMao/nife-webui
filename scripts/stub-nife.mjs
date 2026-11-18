// Stand-in for `nife-coding-agent` used by scripts/smoke.mjs so the extension can be
// imported without a nife checkout.
export const getAgentDir = () => process.env.NIFE_CODING_AGENT_DIR ?? "/tmp/nife-webui-agent";

export const SessionManager = {
	list: async () => {
		const sessions = [
			{ path: "/fake/old.jsonl", id: "old", name: "Old", cwd: "/tmp", modified: new Date(0), messageCount: 2, firstMessage: "hi" },
		];
		// the delete test needs a session that really exists on disk
		const extra = process.env.NIFE_SMOKE_SESSION;
		if (extra) {
			sessions.push({ path: extra, id: "temp", name: "Temp", cwd: "/tmp", modified: new Date(0), messageCount: 1, firstMessage: "x" });
		}
		return sessions;
	},
};

// Mirrors core/session-manager.ts: an entry becomes the messages it contributes to the context.
export function sessionEntryToContextMessages(entry) {
	if (entry.type === "message") return [entry.message];
	if (entry.type === "compaction") {
		return [
			{
				role: "compactionSummary",
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: 0,
			},
		];
	}
	return [];
}
