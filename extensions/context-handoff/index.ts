import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Threshold model
// ---------------------------------------------------------------------------

export type ThresholdMode = "percent" | "tokens";

export interface ThresholdConfig {
	mode: ThresholdMode;
	/** percent: 1-100 ; tokens: raw token count (e.g. 150_000) */
	value: number;
}

/** Default: trigger at 80% of the context window. */
export const DEFAULT_THRESHOLD: ThresholdConfig = { mode: "percent", value: 80 };

// Presets surfaced as autocomplete suggestions (besides the current value).
const THRESHOLD_PRESETS: ThresholdConfig[] = [
	{ mode: "percent", value: 80 },
	{ mode: "percent", value: 90 },
	{ mode: "tokens", value: 150_000 },
	{ mode: "tokens", value: 200_000 },
];

// Mirrors pi's getAgentDir(): respects PI_CODING_AGENT_DIR, defaults to ~/.pi/agent.
// Replicated locally to keep the extension self-contained (no runtime package import).
function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Config file that persists the handoff threshold across restarts.
 * Overridable via PI_HANDOFF_CONFIG_PATH (useful for tests).
 */
export function getHandoffConfigPath(): string {
	return process.env.PI_HANDOFF_CONFIG_PATH ?? join(getAgentDir(), "handoff.json");
}

/**
 * Parse a threshold argument into a config, or return null if invalid.
 *
 * - Bare integer in [1, 100]  → percent mode.
 * - `<n>k` / `<n>K` (n integer ≥ 1) → tokens mode, value = n * 1000.
 *
 * Anything else (floats, `0`, `101`, `150_000`, `80%`, empty) is rejected.
 */
export function parseThreshold(input: string): ThresholdConfig | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	// tokens mode: integer + optional spaces + k/K
	const tokensMatch = /^(\d+)\s*[kK]$/.exec(trimmed);
	if (tokensMatch) {
		const n = Number(tokensMatch[1]);
		if (!Number.isInteger(n) || n < 1) return null;
		return { mode: "tokens", value: n * 1000 };
	}

	// percent mode: bare integer 1-100
	if (/^\d+$/.test(trimmed)) {
		const value = Number(trimmed);
		if (!Number.isInteger(value) || value < 1 || value > 100) return null;
		return { mode: "percent", value };
	}

	return null;
}

/** Format a token count compactly: 150_000 → "150k"; non-multiples stay raw. */
function formatTokenCount(tokens: number): string {
	return tokens % 1000 === 0 ? `${tokens / 1000}k` : `${tokens}`;
}

/** Parseable argument form (what you would type after the command). */
export function thresholdToInput(config: ThresholdConfig): string {
	return config.mode === "percent" ? `${config.value}` : formatTokenCount(config.value);
}

/** Human-readable form for notifications and completion labels. */
export function formatThreshold(config: ThresholdConfig): string {
	return config.mode === "percent" ? `${config.value}%` : `${formatTokenCount(config.value)} tokens`;
}

function isValidConfig(mode: unknown, value: unknown): mode is ThresholdMode {
	if (mode !== "percent" && mode !== "tokens") return false;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return false;
	if (mode === "percent" && value > 100) return false;
	return true;
}

/**
 * Normalize a parsed config file into a ThresholdConfig.
 *
 * Accepts the current schema `{ mode, value }` and the legacy schema
 * `{ contextThreshold: <percent> }`. Falls back to DEFAULT_THRESHOLD otherwise.
 */
function normalizeStoredThreshold(data: Record<string, unknown>): ThresholdConfig {
	if (isValidConfig(data.mode, data.value)) {
		return { mode: data.mode, value: data.value as number };
	}
	if (
		typeof data.contextThreshold === "number" &&
		Number.isFinite(data.contextThreshold) &&
		data.contextThreshold >= 1 &&
		data.contextThreshold <= 100
	) {
		return { mode: "percent", value: data.contextThreshold };
	}
	return DEFAULT_THRESHOLD;
}

/** Load the persisted threshold, falling back to DEFAULT_THRESHOLD on any error. */
export async function loadThreshold(
	configPath: string = getHandoffConfigPath(),
): Promise<ThresholdConfig> {
	try {
		const raw = await readFile(configPath, "utf8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		return data && typeof data === "object" ? normalizeStoredThreshold(data) : DEFAULT_THRESHOLD;
	} catch {
		return DEFAULT_THRESHOLD;
	}
}

/** Persist the threshold to the config file. */
export async function saveThreshold(
	config: ThresholdConfig,
	configPath: string = getHandoffConfigPath(),
): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify({ mode: config.mode, value: config.value }, null, 2)}\n`, "utf8");
}

/** Whether the current context usage has crossed the configured threshold. */
export function thresholdExceeded(
	usage: ContextUsage | undefined,
	config: ThresholdConfig,
): boolean {
	if (!usage) return false;
	if (config.mode === "percent") {
		return usage.percent != null && usage.percent >= config.value;
	}
	return usage.tokens != null && usage.tokens >= config.value;
}

/** Describe the current usage in the active mode's unit (assumes threshold already exceeded). */
function describeUsage(usage: ContextUsage | undefined, mode: ThresholdMode): string {
	if (!usage) return mode === "percent" ? "unknown %" : "unknown token count";
	if (mode === "percent") {
		return usage.percent != null ? `${usage.percent.toFixed(1)}%` : "unknown %";
	}
	return usage.tokens != null ? `${formatTokenCount(usage.tokens)} tokens` : "unknown token count";
}

// ---------------------------------------------------------------------------
// Handoff file plumbing
// ---------------------------------------------------------------------------

export interface HandoffPaths {
	handoffPath: string;
	nextPromptPath: string;
}

interface HandoffState extends HandoffPaths {
	phase: "awaiting-files" | "compacting";
	missingFilesNotified: boolean;
}

function safeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function formatTimestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
}

export function getHandoffBaseDir(): string {
	return join(tmpdir(), "pi-handoffs");
}

export function getHandoffIndexPath(baseDir: string = getHandoffBaseDir()): string {
	return join(baseDir, "handoff-index.md");
}

export function createHandoffPaths(sessionId: string, date = new Date()): HandoffPaths {
	const prefix = `${safeSessionId(sessionId)}-${formatTimestamp(date)}`;
	const dir = getHandoffBaseDir();
	return {
		handoffPath: join(dir, `${prefix}-handoff.md`),
		nextPromptPath: join(dir, `${prefix}-handoff-prompt.md`),
	};
}

/**
 * Strip surrounding whitespace, embedded line breaks, and surrounding quotes
 * from a handoff path before stat checks.
 *
 * The model sometimes echoes paths with wrapping, trailing whitespace, or
 * quotes; normalizing here keeps readiness checks robust.
 */
export function normalizeHandoffPath(rawPath: string): string {
	return rawPath
		.replace(/[\r\n]+/g, "")
		.trim()
		.replace(/^["'](.+)["']$/, "$1")
		.trim();
}

export function renderHandoffPrompt(template: string, paths: HandoffPaths): string {
	return template
		.replaceAll("{{HANDOFF_FILENAME}}", basename(paths.handoffPath))
		.replaceAll("{{NEXT_PROMPT_FILENAME}}", basename(paths.nextPromptPath))
		.replaceAll("{{HANDOFF_FILE}}", paths.handoffPath)
		.replaceAll("{{NEXT_PROMPT_FILE}}", paths.nextPromptPath);
}

async function nonEmptyFile(rawPath: string): Promise<boolean> {
	const path = normalizeHandoffPath(rawPath);
	if (!path) return false;
	try {
		const file = await stat(path);
		return file.isFile() && file.size > 0;
	} catch {
		return false;
	}
}

export async function handoffFilesReady(cwd: string, paths: HandoffPaths): Promise<boolean> {
	// Paths are absolute (under os.tmpdir()). resolve() keeps absolute paths as-is
	// and falls back to resolving relative paths against cwd.
	// normalizeHandoffPath guards against wrapped/quoted echoes of the paths.
	return (
		(await nonEmptyFile(resolve(cwd, normalizeHandoffPath(paths.handoffPath)))) &&
		(await nonEmptyFile(resolve(cwd, normalizeHandoffPath(paths.nextPromptPath))))
	);
}

export interface HandoffIndexEntry {
	sessionId: string;
	threshold: ThresholdConfig;
	paths: HandoffPaths;
	date?: Date;
}

/**
 * Append one line per handoff to `<baseDir>/handoff-index.md` recording the
 * timestamp, session id, threshold, and both file paths.
 */
export async function appendHandoffIndex(
	entry: HandoffIndexEntry,
	baseDir: string = getHandoffBaseDir(),
): Promise<void> {
	const timestamp = (entry.date ?? new Date()).toISOString();
	const line =
		`- ${timestamp} | session=${entry.sessionId} | threshold=${formatThreshold(entry.threshold)}` +
		` | handoff=${entry.paths.handoffPath} | prompt=${entry.paths.nextPromptPath}\n`;
	await mkdir(baseDir, { recursive: true });
	const indexPath = getHandoffIndexPath(baseDir);
	try {
		await stat(indexPath);
	} catch {
		await writeFile(indexPath, "# Handoff index\n", "utf8");
	}
	await appendFile(indexPath, line, "utf8");
}

/** Message shown when the expected handoff files are missing or empty. */
export function buildMissingFilesMessage(paths: HandoffPaths, baseDir: string = getHandoffBaseDir()): string {
	return (
		`Handoff files were not found or are empty; compaction postponed.\n` +
		`Expected:\n- ${paths.handoffPath}\n- ${paths.nextPromptPath}\n` +
		`Inspect with: ls -la "${baseDir}"`
	);
}

/**
 * Load the handoff prompt template.
 *
 * A user override at `<agentDir>/handoff.md` (i.e. `~/.pi/agent/handoff.md`
 * by default, respecting PI_CODING_AGENT_DIR) wins; otherwise falls back to
 * the bundled `handoff.md` next to this module.
 */
export async function loadTemplate(): Promise<string> {
	try {
		const override = await readFile(join(getAgentDir(), "handoff.md"), "utf8");
		if (override.trim()) return override;
	} catch {
		// fall through to the bundled template
	}
	const extensionDir = dirname(fileURLToPath(import.meta.url));
	return readFile(join(extensionDir, "handoff.md"), "utf8");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let state: HandoffState | undefined;
	let threshold: ThresholdConfig = DEFAULT_THRESHOLD;

	pi.on("session_start", async () => {
		state = undefined;
		threshold = await loadThreshold();
	});

	pi.registerCommand("handoff-threshold", {
		description:
			"Set the handoff trigger: a percent (1-100) or a token count with a 'k' suffix (e.g. 150k)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const current: AutocompleteItem = {
				value: thresholdToInput(threshold),
				label: formatThreshold(threshold),
				description: "current",
			};
			const presets: AutocompleteItem[] = THRESHOLD_PRESETS.filter(
				(p) => p.mode !== threshold.mode || p.value !== threshold.value,
			).map((p) => ({
				value: thresholdToInput(p),
				label: formatThreshold(p),
				description: p.mode === threshold.mode ? undefined : `switch to ${p.mode} mode`,
			}));
			const items = [current, ...presets].filter((i) => i.value.startsWith(prefix));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseThreshold(args ?? "");
			if (parsed === null) {
				ctx.ui.notify("Invalid threshold. Usage: /handoff-threshold <1-100 | e.g. 150k>", "error");
				return;
			}
			threshold = parsed;
			try {
				await saveThreshold(parsed);
				ctx.ui.notify(`Handoff threshold set to ${formatThreshold(parsed)} (saved).`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Handoff threshold set to ${formatThreshold(parsed)} for this session (save failed: ${(err as Error).message}).`,
					"warning",
				);
			}
		},
	});

	pi.on("turn_end", async (_event, ctx) => {
		const usage = ctx.getContextUsage();

		if (state === undefined) {
			if (!thresholdExceeded(usage, threshold)) {
				return;
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const paths = createHandoffPaths(sessionId);
			// Ensure the destination exists before asking the model to write.
			await mkdir(getHandoffBaseDir(), { recursive: true });
			try {
				await appendHandoffIndex({ sessionId, threshold, paths });
			} catch {
				// Index bookkeeping must never block the handoff itself.
			}
			const template = await loadTemplate();
			state = { ...paths, phase: "awaiting-files", missingFilesNotified: false };

			ctx.ui.notify(
				`Context at ${describeUsage(usage, threshold.mode)}. Preparing handoff.`,
				"warning",
			);
			// Inject the handoff mid-run like a steer command: it is delivered after
			// the current turn finishes its tool calls, before the next LLM call.
			const prompt = renderHandoffPrompt(template, paths);
			pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "steer" });
			return;
		}

		if (state.phase !== "awaiting-files") return;

		const ready = await handoffFilesReady(ctx.cwd, state);
		if (!ready) {
			if (!state.missingFilesNotified) {
				state.missingFilesNotified = true;
				ctx.ui.notify(buildMissingFilesMessage(state, getHandoffBaseDir()), "error");
			}
			return;
		}

		state.phase = "compacting";
		const nextPromptPath = state.nextPromptPath;
		ctx.ui.notify("Handoff files verified. Compacting context.", "info");
		ctx.compact({
			customInstructions: "Preserve the handoff work, decisions, files, blockers, and next steps.",
			onComplete: () => {
				state = undefined;
				pi.sendUserMessage(`@${nextPromptPath}`);
			},
			onError: (error) => {
				if (state?.phase === "compacting") state.phase = "awaiting-files";
				ctx.ui.notify(`Handoff compaction failed: ${error.message}`, "error");
			},
		});
	});
}
