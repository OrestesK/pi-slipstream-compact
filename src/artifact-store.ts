import { createHash } from "node:crypto";
import {
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	createCooperativeScheduler,
	type CooperativeScheduler,
} from "./responsiveness.ts";

export type ArtifactStoreOptions = {
	root: string;
	maxChunkBytes?: number;
	maxTotalBytes?: number;
	statsFullPaths?: boolean;
};
export type ArtifactRunInput = {
	sessionId: string;
	triggerEntryId: string | null;
	cwd: string;
};
export type ArtifactRun = {
	id: string;
	dir: string;
	sessionId: string;
	triggerEntryId: string | null;
	cwd: string;
};
export type ArtifactRecord = {
	kind: string;
	path?: string;
	chunkPaths?: string[];
	timestamp: string;
};

export type GitSnapshotInput = {
	statusShort: string;
	diffStat: string;
	fullDiff: string;
	fullDiffComplete?: boolean;
};

export type GitSnapshotRecord = {
	path: string;
	statusPath: string;
	diffStatPath: string;
	diffChunkPaths: string[];
	diffSha256: string;
	diffBytes: number;
	fullDiffPreserved: boolean;
	fullDiffComplete: boolean;
};

export type CompactionStats = {
	schemaVersion: 1;
	mode: "compact" | "auto";
	outcome: "accepted" | "rejected" | "failed";
	accepted: boolean;
	repaired: boolean;
	startedAt: string;
	completedAt: string;
	sessionId: string;
	cwd: string;
	artifactDir: string;
	tokensBefore: number | null;
	judgeScore: number | null;
	judgeDecision: string | null;
	timingsMs: Record<string, number>;
};

const DEFAULT_MAX_CHUNK_BYTES = 512 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const DEFAULT_STATS_ROOT = join(
	homedir(),
	".config",
	"pi",
	".scratch",
	"slipstream-stats",
);

export function sanitizePart(value: string): string {
	const sanitized = value
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildTriggerMetadata(
	payload: unknown,
	rawBytes: number,
	chunkPaths: string[],
): Record<string, unknown> {
	const base: Record<string, unknown> = {
		rawBytes,
		chunkPaths,
		rawPayload: { storage: "chunked", omittedFromMetadata: true },
	};
	if (isRecord(payload) && "manifest" in payload)
		base.manifest = payload.manifest;
	if (isRecord(payload) && Array.isArray(payload.messages))
		base.messageCount = payload.messages.length;
	return base;
}

type TriggerPayload = {
	messages: unknown[];
	manifest: unknown;
};

type TriggerSnapshotWriteOptions = {
	signal?: AbortSignal;
};

type TriggerChunkWriteInput = {
	runDir: string;
	payload: unknown;
	maxChunkBytes: number;
	maxTotalBytes: number;
	scheduler: CooperativeScheduler;
};

function isTriggerPayload(payload: unknown): payload is TriggerPayload {
	return (
		isRecord(payload) &&
		Array.isArray(payload.messages) &&
		"manifest" in payload
	);
}

function stringifyJsonValue(value: unknown): string {
	return JSON.stringify(value, replacer) ?? "null";
}

async function* triggerJsonFragments(
	payload: unknown,
	scheduler: CooperativeScheduler,
): AsyncGenerator<string> {
	if (!isTriggerPayload(payload)) {
		await scheduler.checkpoint(true);
		yield stringifyJsonValue(payload);
		return;
	}
	yield `{"messages":[`;
	for (let index = 0; index < payload.messages.length; index += 1) {
		if (index > 0) yield ",";
		await scheduler.checkpoint(index === 0);
		yield stringifyJsonValue(payload.messages[index]);
	}
	yield `],"manifest":`;
	await scheduler.checkpoint(true);
	yield stringifyJsonValue(payload.manifest);
	yield "}";
}

function isHighSurrogate(value: string, index: number): boolean {
	const code = value.charCodeAt(index);
	return code >= 0xd800 && code <= 0xdbff;
}

function prefixWithinUtf8Bytes(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) low = mid;
		else high = mid - 1;
	}
	let end = low;
	if (end > 0 && isHighSurrogate(value, end - 1)) end -= 1;
	return end === 0 ? "" : value.slice(0, end);
}

async function removeFiles(paths: string[]): Promise<void> {
	await Promise.all(
		paths.map(async (path) => {
			try {
				await unlink(path);
			} catch {
				// Best-effort cleanup; the caller will still surface the original error.
			}
		}),
	);
}

async function writeTriggerSnapshotChunks(
	input: TriggerChunkWriteInput,
): Promise<{ rawBytes: number; chunkPaths: string[] }> {
	const tempChunkPaths: string[] = [];
	const finalChunkPaths: string[] = [];
	const currentParts: string[] = [];
	let currentBytes = 0;
	let rawBytes = 0;

	const flushChunk = async (): Promise<void> => {
		if (currentBytes === 0) return;
		const chunkNumber = tempChunkPaths.length + 1;
		const finalPath = join(
			input.runDir,
			`trigger-raw-${String(chunkNumber).padStart(3, "0")}.json`,
		);
		const tempPath = `${finalPath}.tmp`;
		await writeFile(tempPath, currentParts.join(""), "utf8");
		tempChunkPaths.push(tempPath);
		finalChunkPaths.push(finalPath);
		currentParts.length = 0;
		currentBytes = 0;
		await input.scheduler.checkpoint();
	};

	const appendFragment = async (fragment: string): Promise<void> => {
		const fragmentBytes = Buffer.byteLength(fragment, "utf8");
		if (rawBytes + fragmentBytes > input.maxTotalBytes) {
			throw new Error(
				`trigger snapshot exceeds maxTotalBytes (${rawBytes + fragmentBytes} > ${input.maxTotalBytes})`,
			);
		}
		rawBytes += fragmentBytes;
		let remaining = fragment;
		while (remaining.length > 0) {
			if (currentBytes >= input.maxChunkBytes) await flushChunk();
			const budget = input.maxChunkBytes - currentBytes;
			const part = prefixWithinUtf8Bytes(remaining, budget);
			if (part === "") {
				if (currentBytes > 0) {
					await flushChunk();
					continue;
				}
				throw new Error(
					`trigger snapshot fragment contains a code point larger than maxChunkBytes (${input.maxChunkBytes})`,
				);
			}
			currentParts.push(part);
			currentBytes += Buffer.byteLength(part, "utf8");
			remaining = remaining.slice(part.length);
			if (currentBytes >= input.maxChunkBytes) await flushChunk();
		}
	};

	try {
		for await (const fragment of triggerJsonFragments(
			input.payload,
			input.scheduler,
		)) {
			await appendFragment(fragment);
		}
		await flushChunk();
		for (let index = 0; index < tempChunkPaths.length; index += 1) {
			const tempPath = tempChunkPaths[index];
			const finalPath = finalChunkPaths[index];
			if (tempPath === undefined || finalPath === undefined) continue;
			await rename(tempPath, finalPath);
			await input.scheduler.checkpoint();
		}
		return { rawBytes, chunkPaths: finalChunkPaths };
	} catch (error) {
		await removeFiles([...tempChunkPaths, ...finalChunkPaths]);
		throw error;
	}
}

export function createRunId(
	sessionId: string,
	triggerEntryId: string | null,
): string {
	return createHash("sha256")
		.update(`${sessionId}:${triggerEntryId ?? "none"}`)
		.digest("hex")
		.slice(0, 16);
}

function projectRelativePath(cwd: string, path: string): string {
	const root = resolve(cwd);
	const resolved = resolve(path);
	const rel = relative(root, resolved);
	if (rel === "") return ".";
	if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
	return `[outside-project]/${sanitizePart(resolved.split(/[\\/]+/).at(-1) ?? "path")}`;
}

function redactStatsPaths(
	stats: CompactionStats,
	run: ArtifactRun,
): CompactionStats {
	return {
		...stats,
		cwd: ".",
		artifactDir: projectRelativePath(run.cwd, stats.artifactDir),
	};
}

async function readIndex(dir: string): Promise<{ records: ArtifactRecord[] }> {
	try {
		const parsed = JSON.parse(
			await readFile(join(dir, "index.json"), "utf8"),
		) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			Array.isArray((parsed as { records?: unknown }).records)
		) {
			return parsed as { records: ArtifactRecord[] };
		}
	} catch {
		// Missing index is normal for a new run.
	}
	return { records: [] };
}

function sha256Buffer(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

async function appendIndex(
	dir: string,
	record: Omit<ArtifactRecord, "timestamp">,
): Promise<void> {
	const index = await readIndex(dir);
	index.records.push({ ...record, timestamp: new Date().toISOString() });
	await writeFile(
		join(dir, "index.json"),
		`${JSON.stringify(index, null, 2)}\n`,
		"utf8",
	);
}

export class ArtifactStore {
	readonly root: string;
	readonly maxChunkBytes: number;
	readonly maxTotalBytes: number;
	readonly statsFullPaths: boolean;

	constructor(options: ArtifactStoreOptions) {
		this.root = resolve(options.root);
		this.maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
		this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
		this.statsFullPaths = options.statsFullPaths ?? false;
	}

	async createRun(input: ArtifactRunInput): Promise<ArtifactRun> {
		const id = createRunId(input.sessionId, input.triggerEntryId);
		const baseDir = join(this.root, `${sanitizePart(input.sessionId)}-${id}`);
		await mkdir(this.root, { recursive: true });
		let dir = baseDir;
		try {
			await mkdir(baseDir);
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "EEXIST")
			)
				throw error;
			dir = await mkdtemp(`${baseDir}-`);
		}
		try {
			await writeFile(
				join(dir, "run.json"),
				`${JSON.stringify({ id, sessionId: input.sessionId, triggerEntryId: input.triggerEntryId, cwd: input.cwd }, null, 2)}\n`,
				"utf8",
			);
		} catch (error) {
			await rm(dir, { recursive: true, force: true });
			throw error;
		}
		return {
			id,
			dir,
			sessionId: input.sessionId,
			triggerEntryId: input.triggerEntryId,
			cwd: input.cwd,
		};
	}

	private async ownedRunPath(
		runDir: string,
		expected: Pick<ArtifactRunInput, "sessionId" | "cwd">,
	): Promise<string> {
		const target = resolve(runDir);
		const rel = relative(this.root, target);
		if (
			rel === "" ||
			rel.startsWith("..") ||
			isAbsolute(rel) ||
			rel.includes("/") ||
			rel.includes("\\")
		)
			throw new Error("Artifact run must be a direct child of its store root");
		const targetStat = await lstat(target);
		if (!targetStat.isDirectory() || targetStat.isSymbolicLink())
			throw new Error("Artifact run target is not a real directory");
		const [realRoot, realTarget] = await Promise.all([
			realpath(this.root),
			realpath(target),
		]);
		if (relative(realRoot, realTarget) !== rel)
			throw new Error("Artifact run resolves outside its store root");
		const metadata = JSON.parse(
			await readFile(join(realTarget, "run.json"), "utf8"),
		);
		if (
			!isRecord(metadata) ||
			metadata.sessionId !== expected.sessionId ||
			metadata.cwd !== expected.cwd
		)
			throw new Error("Artifact run metadata does not match cleanup owner");
		return realTarget;
	}

	async verifiedRunPath(
		runDir: string,
		expected: Pick<ArtifactRunInput, "sessionId" | "cwd">,
	): Promise<string | null> {
		try {
			return await this.ownedRunPath(runDir, expected);
		} catch {
			return null;
		}
	}

	async removeRun(
		runDir: string,
		expected: Pick<ArtifactRunInput, "sessionId" | "cwd">,
	): Promise<void> {
		try {
			const target = await this.ownedRunPath(runDir, expected);
			await rm(target, { recursive: true, force: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return;
			throw error;
		}
	}

	async writeTriggerSnapshot(
		run: ArtifactRun,
		payload: unknown,
		options: TriggerSnapshotWriteOptions = {},
	): Promise<{ path: string; chunkPaths: string[] }> {
		const scheduler = createCooperativeScheduler({ signal: options.signal });
		const path = join(run.dir, "trigger-snapshot.json");
		let chunkPaths: string[] = [];
		try {
			const written = await writeTriggerSnapshotChunks({
				runDir: run.dir,
				payload,
				maxChunkBytes: this.maxChunkBytes,
				maxTotalBytes: this.maxTotalBytes,
				scheduler,
			});
			chunkPaths = written.chunkPaths;
			await scheduler.checkpoint(true);
			const metadata = buildTriggerMetadata(
				payload,
				written.rawBytes,
				chunkPaths,
			);
			await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
			await scheduler.checkpoint(true);
			await appendIndex(run.dir, {
				kind: "trigger-snapshot",
				path,
				chunkPaths,
			});
			return { path, chunkPaths };
		} catch (error) {
			await removeFiles([...chunkPaths, path]);
			throw error;
		}
	}

	async writeCandidate(
		run: ArtifactRun,
		summary: string,
	): Promise<{ path: string }> {
		return this.writeTextArtifact(
			run,
			"candidate-summary.md",
			summary,
			"candidate",
		);
	}

	async writeTextArtifact(
		run: ArtifactRun,
		filename: string,
		text: string,
		kind: string,
	): Promise<{ path: string }> {
		const path = join(run.dir, filename);
		await writeFile(path, text, "utf8");
		await appendIndex(run.dir, { kind, path });
		return { path };
	}

	async writeContinuation(
		run: ArtifactRun,
		continuation: unknown,
	): Promise<{ path: string }> {
		const path = join(run.dir, "continuation.json");
		await writeFile(path, `${JSON.stringify(continuation, null, 2)}\n`, "utf8");
		await appendIndex(run.dir, { kind: "continuation", path });
		return { path };
	}

	async writeStateEvidence(
		run: ArtifactRun,
		evidence: unknown,
	): Promise<{ path: string }> {
		const path = join(run.dir, "state-evidence.json");
		await writeFile(path, `${JSON.stringify(evidence, replacer, 2)}\n`, "utf8");
		await appendIndex(run.dir, { kind: "state-evidence", path });
		return { path };
	}

	async writeGitSnapshot(
		run: ArtifactRun,
		snapshot: GitSnapshotInput,
	): Promise<GitSnapshotRecord> {
		const statusPath = join(run.dir, "git-status.txt");
		const diffStatPath = join(run.dir, "git-diff-stat.txt");
		await writeFile(statusPath, snapshot.statusShort, "utf8");
		await writeFile(diffStatPath, snapshot.diffStat, "utf8");

		const diffBuffer = Buffer.from(snapshot.fullDiff, "utf8");
		const diffBytes = diffBuffer.byteLength;
		const diffSha256 = sha256Buffer(diffBuffer);
		const diffChunkPaths: string[] = [];
		const fullDiffComplete = snapshot.fullDiffComplete !== false;
		const fullDiffPreserved =
			fullDiffComplete && diffBytes <= this.maxTotalBytes;
		if (fullDiffPreserved) {
			for (let offset = 0; offset < diffBytes; offset += this.maxChunkBytes) {
				const chunkPath = join(
					run.dir,
					`git-diff-full-${String(diffChunkPaths.length + 1).padStart(3, "0")}.patch`,
				);
				await writeFile(
					chunkPath,
					diffBuffer.subarray(offset, offset + this.maxChunkBytes),
				);
				diffChunkPaths.push(chunkPath);
			}
		} else {
			const omittedPath = join(run.dir, "git-diff-full-omitted.txt");
			const reason = fullDiffComplete
				? `Full git diff was ${diffBytes} bytes, above maxTotalBytes ${this.maxTotalBytes}.`
				: `Git diff output was incomplete before artifact writing; stored bytes are partial and must not be treated as the full diff.`;
			await writeFile(
				omittedPath,
				`${reason} Re-run read-only git diff in the repo if exact patch text is needed. Stored SHA-256: ${diffSha256}\n`,
				"utf8",
			);
			diffChunkPaths.push(omittedPath);
		}

		const path = join(run.dir, "git-snapshot.json");
		const record: GitSnapshotRecord = {
			path,
			statusPath,
			diffStatPath,
			diffChunkPaths,
			diffSha256,
			diffBytes,
			fullDiffPreserved,
			fullDiffComplete,
		};
		await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		await appendIndex(run.dir, {
			kind: "git-snapshot",
			path,
			chunkPaths: diffChunkPaths,
		});
		return record;
	}

	async writePromptMetrics(
		run: ArtifactRun,
		metrics: unknown,
	): Promise<{ path: string }> {
		const path = join(run.dir, "prompt-metrics.json");
		let records: unknown[] = [];
		try {
			const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
			if (isRecord(parsed) && Array.isArray(parsed.records))
				records = parsed.records;
		} catch {
			// Missing prompt metrics file is normal for the first prompt.
		}
		records.push(metrics);
		await writeFile(path, `${JSON.stringify({ records }, null, 2)}\n`, "utf8");
		await appendIndex(run.dir, { kind: "prompt-metrics", path });
		return { path };
	}

	async writeJudgeResult(
		run: ArtifactRun,
		judge: unknown,
	): Promise<{ path: string }> {
		const path = join(run.dir, "judge.json");
		await writeFile(path, `${JSON.stringify(judge, null, 2)}\n`, "utf8");
		await appendIndex(run.dir, { kind: "judge", path });
		return { path };
	}

	async writeJudgeRawResponse(
		run: ArtifactRun,
		input: { attempt: string; rawText: string; maxChars?: number },
	): Promise<{ path: string }> {
		const maxChars = input.maxChars ?? 20_000;
		const rawText =
			input.rawText.length <= maxChars
				? input.rawText
				: `${input.rawText.slice(0, Math.floor(maxChars / 2))}\n...[omitted ${input.rawText.length - maxChars} chars]...\n${input.rawText.slice(-Math.ceil(maxChars / 2))}`;
		const path = join(run.dir, `judge-raw-${sanitizePart(input.attempt)}.json`);
		await writeFile(
			path,
			`${JSON.stringify(
				{
					attempt: input.attempt,
					rawChars: input.rawText.length,
					sha256: createHash("sha256").update(input.rawText).digest("hex"),
					truncated: rawText.length !== input.rawText.length,
					rawText,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		await appendIndex(run.dir, { kind: "judge-raw-response", path });
		return { path };
	}

	async writeAdoptionRecord(
		run: ArtifactRun,
		adoption: unknown,
	): Promise<{ path: string }> {
		const path = join(run.dir, "adoption.json");
		await writeFile(path, `${JSON.stringify(adoption, null, 2)}\n`, "utf8");
		await appendIndex(run.dir, { kind: "adoption", path });
		return { path };
	}

	async writeStats(
		run: ArtifactRun,
		stats: CompactionStats,
	): Promise<{ path: string }> {
		const statsRoot = resolve(
			process.env.PI_SLIPSTREAM_STATS_ROOT ?? DEFAULT_STATS_ROOT,
		);
		const dir = join(statsRoot, "sessions");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${sanitizePart(run.sessionId)}.jsonl`);
		const statsRecord = this.statsFullPaths
			? stats
			: redactStatsPaths(stats, run);
		await appendFile(path, `${JSON.stringify(statsRecord)}\n`, "utf8");
		return { path };
	}
}

function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Set) return [...value];
	return value;
}
