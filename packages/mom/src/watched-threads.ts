import { existsSync, readFileSync, writeFileSync } from "fs";
import * as log from "./log.js";

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface WatchedThreadsData {
	/** thread_ts -> channel_id */
	threads: Record<string, string>;
}

/**
 * Durable store for watched threads.
 * Reads/writes a JSON file on disk so entries survive restarts.
 */
export class WatchedThreadStore {
	private threads: Map<string, string>;
	private filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
		this.threads = this.load();
	}

	private load(): Map<string, string> {
		if (!existsSync(this.filePath)) {
			return new Map();
		}
		try {
			const data: WatchedThreadsData = JSON.parse(readFileSync(this.filePath, "utf-8"));
			const map = new Map(Object.entries(data.threads || {}));
			log.logInfo(`Loaded ${map.size} watched threads from ${this.filePath}`);
			return map;
		} catch (err) {
			log.logWarning("Failed to load watched threads", err instanceof Error ? err.message : String(err));
			return new Map();
		}
	}

	private save(): void {
		try {
			const data: WatchedThreadsData = { threads: Object.fromEntries(this.threads) };
			writeFileSync(this.filePath, JSON.stringify(data), "utf-8");
		} catch (err) {
			log.logWarning("Failed to save watched threads", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Register a thread as watched. Prunes old entries and persists to disk.
	 */
	register(threadTs: string, channelId: string): void {
		this.prune();
		this.threads.set(threadTs, channelId);
		this.save();
	}

	/**
	 * Check if a thread is watched.
	 */
	has(threadTs: string): boolean {
		return this.threads.has(threadTs);
	}

	/**
	 * Remove threads older than 30 days.
	 */
	private prune(): void {
		const cutoff = Date.now() / 1000 - MAX_AGE_SECONDS;
		let pruned = 0;
		for (const [ts] of this.threads) {
			if (parseFloat(ts) < cutoff) {
				this.threads.delete(ts);
				pruned++;
			}
		}
		if (pruned > 0) {
			log.logInfo(`Pruned ${pruned} expired watched threads`);
		}
	}
}
