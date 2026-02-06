import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import * as log from "./log.js";
import type { Attachment, ChannelStore } from "./store.js";
import { WatchedThreadStore } from "./watched-threads.js";

// ============================================================================
// Types
// ============================================================================

export interface SlackEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
	/** Thread timestamp - present when the message is a reply in a thread */
	thread_ts?: string;
	/** If true, mom should reply in a thread off the user's message */
	replyInThread?: boolean;
}

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

// Types used by agent.ts
export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
		/** Thread ts if this message is in a thread */
		thread_ts?: string;
		/** If true, mom should reply in a thread off the user's message */
		replyInThread?: boolean;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string, threadTs?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
	postFinalMessage: (text: string) => Promise<void>;
}

export interface MomHandler {
	/**
	 * Check if channel is currently running (SYNC)
	 */
	isRunning(channelId: string): boolean;

	/**
	 * Handle an event that triggers mom (ASYNC)
	 * Called only when isRunning() returned false for user messages.
	 * Events always queue and pass isEvent=true.
	 */
	handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void>;

	/**
	 * Handle stop command (ASYNC)
	 * Called when user says "stop" while mom is running
	 */
	handleStop(channelId: string, slack: SlackBot): Promise<void>;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// Watched Threads
// ============================================================================

const judgeModel = getModel("anthropic", "claude-haiku-4-5-20251001");

interface ThreadMessage {
	user: string;
	text: string;
	isBot: boolean;
}

/**
 * Use a fast model to judge whether a thread reply is directed at mom.
 * Returns true if the message seems intended for the bot.
 */
async function judgeThreadReply(
	message: string,
	senderName: string,
	threadContext: ThreadMessage[],
	apiKey: string,
): Promise<boolean> {
	const contextLines = threadContext
		.slice(-10) // Last 10 messages for context
		.map((m) => `${m.isBot ? "[mom]" : `[${m.user}]`}: ${m.text}`)
		.join("\n");

	const prompt = `You are a classifier. A Slack bot named "mom" (also known as "pi") is participating in a thread. A new reply just arrived. Decide if the reply is directed at mom or is requesting mom's help/action.

Reply YES if:
- The message asks mom/pi to do something
- The message asks a question that seems directed at mom/pi
- The message is a follow-up to something mom said (e.g. "can you also...", "what about...", "try again")
- The message provides information mom asked for

Reply NO if:
- The message is clearly directed at another human in the thread
- The message is commentary between humans about what mom said
- The message is a reaction/emoji-like response not needing action (e.g. "nice", "thanks" with no follow-up)
- The message mentions another bot by name

Thread context:
${contextLines}

New reply from [${senderName}]: ${message}

Respond with exactly YES or NO.`;

	try {
		const result = await completeSimple(
			judgeModel,
			{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			{ apiKey },
		);
		const answer = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim()
			.toUpperCase();
		return answer.startsWith("YES");
	} catch (err) {
		log.logWarning("Thread judge failed", err instanceof Error ? err.message : String(err));
		return false; // Fail closed: don't respond if judge errors
	}
}

// ============================================================================
// SlackBot
// ============================================================================

export class SlackBot {
	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler: MomHandler;
	private workingDir: string;
	private store: ChannelStore;
	private botUserId: string | null = null;
	private startupTs: string | null = null; // Messages older than this are just logged, not processed

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private queues = new Map<string, ChannelQueue>();
	private watchedThreads: WatchedThreadStore;

	constructor(
		handler: MomHandler,
		config: { appToken: string; botToken: string; workingDir: string; store: ChannelStore },
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
		this.watchedThreads = new WatchedThreadStore(join(config.workingDir, "watched-threads.json"));
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		this.setupEventHandlers();
		await this.socketClient.start();

		// Record startup time - messages older than this are just logged, not processed
		this.startupTs = (Date.now() / 1000).toFixed(6);

		log.logConnected();
	}

	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, text });
		return result.ts as string;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
		return result.ts as string;
	}

	async uploadFile(channel: string, filePath: string, title?: string, threadTs?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		if (threadTs) {
			await this.webClient.files.uploadV2({
				channel_id: channel,
				thread_ts: threadTs,
				file: fileContent,
				filename: fileName,
				title: fileName,
			});
		} else {
			await this.webClient.files.uploadV2({
				channel_id: channel,
				file: fileContent,
				filename: fileName,
				title: fileName,
			});
		}
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 * This is the ONLY place messages are written to log.jsonl
	 */
	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Watched Threads
	// ==========================================================================

	/**
	 * Register a thread as watched (bot has posted in it).
	 * Prunes old threads and persists to disk.
	 */
	registerWatchedThread(threadTs: string, channelId: string): void {
		this.watchedThreads.register(threadTs, channelId);
		log.logInfo(`Watching thread ${threadTs} in ${channelId}`);
	}

	/**
	 * Check if a thread is watched.
	 */
	isWatchedThread(threadTs: string): boolean {
		return this.watchedThreads.has(threadTs);
	}

	/**
	 * Fetch recent messages from a thread for judge context.
	 */
	async getThreadMessages(channel: string, threadTs: string): Promise<ThreadMessage[]> {
		try {
			const result = await this.webClient.conversations.replies({
				channel,
				ts: threadTs,
				limit: 15,
			});
			const messages = (result.messages || []) as Array<{
				user?: string;
				bot_id?: string;
				text?: string;
				ts?: string;
			}>;
			return messages.map((m) => {
				const isBot = m.user === this.botUserId || !!m.bot_id;
				const user = m.user ? this.users.get(m.user) : undefined;
				return {
					user: user?.userName || m.user || "unknown",
					text: m.text || "",
					isBot,
				};
			});
		} catch (err) {
			log.logWarning("Failed to fetch thread messages", err instanceof Error ? err.message : String(err));
			return [];
		}
	}

	/**
	 * Get the API key for the thread judge.
	 * Uses ANTHROPIC_API_KEY from environment.
	 */
	getApiKeyForJudge(): string | undefined {
		return process.env.ANTHROPIC_API_KEY;
	}

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	/**
	 * Enqueue an event for processing. Always queues (no "already working" rejection).
	 * Returns true if enqueued, false if queue is full (max 5).
	 */
	enqueueEvent(event: SlackEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private setupEventHandlers(): void {
		// Channel @mentions
		this.socketClient.on("app_mention", ({ event, ack }) => {
			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				thread_ts?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip DMs (handled by message event)
			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			let text = e.text.replace(/<@[A-Z0-9]+>/gi, "").trim();

			// Check for :thread: directive anywhere in the message
			const threadDirective = text.includes(":thread:");
			if (threadDirective) {
				text = text.replace(/:thread:/g, "").trim();
			}

			const slackEvent: SlackEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text,
				files: e.files,
				thread_ts: e.thread_ts,
				replyInThread: threadDirective || !!e.thread_ts,
			};

			// SYNC: Log to log.jsonl (ALWAYS, even for old messages)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
				);
				ack();
				return;
			}

			// Check for stop command - execute immediately, don't queue!
			if (slackEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(e.channel)) {
					this.handler.handleStop(e.channel, this); // Don't await, don't queue
				} else {
					this.postMessage(e.channel, "_Nothing running_");
				}
				ack();
				return;
			}

			// SYNC: Check if busy
			if (this.handler.isRunning(e.channel)) {
				this.postMessage(e.channel, "_Already working. Say `@pi stop` to cancel._");
			} else {
				this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
			}

			ack();
		});

		// All messages (for logging) + DMs (for triggering)
		this.socketClient.on("message", ({ event, ack }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				thread_ts?: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip bot messages, edits, etc.
			if (e.bot_id || !e.user || e.user === this.botUserId) {
				ack();
				return;
			}
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				ack();
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			// Skip channel @mentions - already handled by app_mention event
			if (!isDM && isBotMention) {
				ack();
				return;
			}

			let dmText = (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();

			// Check for :thread: directive anywhere in DMs too
			const dmThreadDirective = dmText.includes(":thread:");
			if (dmThreadDirective) {
				dmText = dmText.replace(/:thread:/g, "").trim();
			}

			const slackEvent: SlackEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: dmText,
				files: e.files,
				thread_ts: e.thread_ts,
				replyInThread: dmThreadDirective || !!e.thread_ts,
			};

			// SYNC: Log to log.jsonl (ALL messages - channel chatter and DMs)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
				ack();
				return;
			}

			// Trigger handler for DMs or watched thread replies
			const isWatchedThreadReply = !isDM && !!e.thread_ts && this.isWatchedThread(e.thread_ts);

			if (isDM || isWatchedThreadReply) {
				// Check for stop command - execute immediately, don't queue!
				if (slackEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(e.channel)) {
						this.handler.handleStop(e.channel, this); // Don't await, don't queue
					} else {
						this.postMessage(e.channel, "_Nothing running_");
					}
					ack();
					return;
				}

				if (this.handler.isRunning(e.channel)) {
					if (isDM) {
						this.postMessage(e.channel, "_Already working. Say `stop` to cancel._");
					}
					// For watched threads, silently skip if busy
				} else if (isWatchedThreadReply) {
					// For watched thread replies, run the judge asynchronously
					const threadTs = e.thread_ts!;
					const channelId = e.channel;
					const apiKey = this.getApiKeyForJudge();
					if (apiKey) {
						// Run judge in background (don't block ack)
						this.judgeAndProcess(slackEvent, channelId, threadTs, apiKey);
					} else {
						log.logWarning("No API key for thread judge, skipping watched thread reply");
					}
				} else {
					this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
				}
			}

			ack();
		});
	}

	/**
	 * Log a user message to log.jsonl (SYNC)
	 * Downloads attachments in background via store
	 */
	private logUserMessage(event: SlackEvent): Attachment[] {
		const user = this.users.get(event.user);
		// Process attachments - queues downloads in background
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	/**
	 * Judge a watched thread reply and process it if directed at the bot.
	 */
	private async judgeAndProcess(
		event: SlackEvent,
		channelId: string,
		threadTs: string,
		apiKey: string,
	): Promise<void> {
		try {
			const threadMessages = await this.getThreadMessages(channelId, threadTs);
			const user = this.users.get(event.user);
			const senderName = user?.userName || event.user;

			const shouldRespond = await judgeThreadReply(event.text, senderName, threadMessages, apiKey);

			if (shouldRespond) {
				log.logInfo(`[${channelId}] Thread judge: YES for reply from ${senderName} in thread ${threadTs}`);

				// Ensure the event is treated as a thread reply
				event.thread_ts = threadTs;
				event.replyInThread = true;
				event.type = "mention";

				if (this.handler.isRunning(channelId)) {
					// Became busy during judge evaluation - silently skip
					log.logInfo(`[${channelId}] Channel busy after judge, skipping thread reply`);
				} else {
					this.getQueue(channelId).enqueue(() => this.handler.handleEvent(event, this));
				}
			} else {
				log.logInfo(`[${channelId}] Thread judge: NO for reply from ${senderName} in thread ${threadTs}`);
			}
		} catch (err) {
			log.logWarning("Thread judge error", err instanceof Error ? err.message : String(err));
		}
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		// Find the biggest ts in log.jsonl
		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs, // Only fetch messages newer than what we have
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		// Filter: include mom's messages, exclude other bots, skip already logged
		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		// Reverse to chronological order
		relevantMessages.reverse();

		// Log each message to log.jsonl
		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			// Strip @mentions from text (same as live messages)
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			// Process attachments - queues downloads in background
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
			});
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		// Only backfill channels that already have a log.jsonl (mom has interacted with them before)
		const channelsToBackfill: Array<[string, SlackChannel]> = [];
		for (const [channelId, channel] of this.channels) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channelId, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		// Fetch public/private channels
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		// Also fetch DM channels (IMs)
		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						// Use user's name as channel name for DMs
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}
