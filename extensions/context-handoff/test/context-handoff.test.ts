import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import extension, {
	appendHandoffIndex,
	buildMissingFilesMessage,
	createHandoffPaths,
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_RESERVE_TOKENS,
	DEFAULT_THRESHOLD,
	formatThreshold,
	getHandoffBaseDir,
	getHandoffIndexPath,
	handoffFilesReady,
	loadCompactionSettings,
	loadTemplate,
	loadThreshold,
	mergeSettingsLayers,
	normalizeHandoffPath,
	parseThreshold,
	renderHandoffPrompt,
	resolveKeepRecent,
	resolveReserveTokens,
	saveThreshold,
	thresholdToInput,
	thresholdToTokens,
	type ThresholdConfig,
} from "../index";

afterEach(async () => {
	await rm(getHandoffBaseDir(), { recursive: true, force: true });
	delete process.env.PI_HANDOFF_CONFIG_PATH;
	delete process.env.PI_CODING_AGENT_DIR;
});

interface DeliverAs {
	deliverAs?: "steer" | "followUp";
}

interface CommandOptions {
	handler: (args: string, ctx: any) => Promise<void>;
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
}

function setup() {
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	const sentMessages: { text: string; options?: DeliverAs }[] = [];
	let compactCalls = 0;
	let usage: { tokens: number | null; contextWindow: number; percent: number | null } = { tokens: 79_999, contextWindow: 100_000, percent: 79.999 };

	const commands = new Map<string, CommandOptions>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: any) => Promise<void>) {
			handlers.set(event, handler);
		},
		sendUserMessage(message: string, options?: DeliverAs) {
			sentMessages.push({ text: message, options });
		},
		registerCommand(name: string, options: CommandOptions) {
			commands.set(name, options);
		},
	};

	extension(pi as any);

	return {
		handlers,
		commands,
		sentMessages,
		setUsage(nextUsage: typeof usage) {
			usage = nextUsage;
		},
		getCompactCalls: () => compactCalls,
		createContext(
			idle = true,
			notifications: { message: string; level: string }[] = [],
			opts: { mode?: string; working?: (string | undefined)[] } = {},
		) {
			return {
				cwd: tmpdir(),
				mode: opts.mode,
				isIdle: () => idle,
				getContextUsage: () => usage,
				sessionManager: { getSessionId: () => "session/test-id" },
				ui: {
					notify(message: string, level: string) {
						notifications.push({ message, level });
					},
					setWorkingMessage(message?: string) {
						opts.working?.push(message);
					},
				},
				compact(options: any) {
					compactCalls += 1;
					options.onComplete?.({});
				},
			};
		},
	};
}

/** Paths are quoted inside fenced blocks; exclude quotes/backticks/whitespace. */
const HANDOFF_FILE_RE = /[^\s`"\n]+-(?:handoff|handoff-prompt)\.md/g;

function extractPaths(text: string): string[] {
	return text.match(HANDOFF_FILE_RE) ?? [];
}

describe("context handoff", () => {
	test("default base dir lives under os.tmpdir()", () => {
		expect(getHandoffBaseDir()).toBe(join(tmpdir(), "pi-handoffs"));
	});

	test("generates runtime paths under the os tmp dir and renders them into the template", () => {
		const paths = createHandoffPaths("session/test-id", new Date("2026-01-02T03:04:05.678Z"));

		expect(paths.handoffPath).toBe(join(tmpdir(), "pi-handoffs", "session-test-id-20260102-030405.678-handoff.md"));
		expect(paths.nextPromptPath).toBe(
			join(tmpdir(), "pi-handoffs", "session-test-id-20260102-030405.678-handoff-prompt.md"),
		);
		expect(renderHandoffPrompt("{{HANDOFF_FILE}} | {{NEXT_PROMPT_FILE}}", paths)).toBe(
			`${paths.handoffPath} | ${paths.nextPromptPath}`,
		);
	});

	test("renders short filenames alongside the quoted absolute paths", () => {
		const paths = createHandoffPaths("session/test-id", new Date("2026-01-02T03:04:05.678Z"));
		const out = renderHandoffPrompt("handoff=`{{HANDOFF_FILENAME}}` @ `{{NEXT_PROMPT_FILENAME}}`", paths);
		expect(out).toContain("session-test-id-20260102-030405.678-handoff.md");
		expect(out).toContain("session-test-id-20260102-030405.678-handoff-prompt.md");
		expect(out).not.toContain(tmpdir());
	});

	test("does nothing below the threshold and requests a handoff at 80% on turn_end", async () => {
		const setupResult = setup();
		const context = setupResult.createContext();
		const turnEnd = setupResult.handlers.get("turn_end")!;

		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(0);

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);

		expect(setupResult.sentMessages).toHaveLength(1);
		expect(setupResult.sentMessages[0].text).toContain("pi-handoffs/session-test-id-");
		expect(setupResult.sentMessages[0].text).toContain("The generated files must be written in the language");
		expect(setupResult.sentMessages[0].options).toBeUndefined();
		expect(setupResult.getCompactCalls()).toBe(0);
	});

	test("creates the handoff base dir before asking the model to write", async () => {
		const setupResult = setup();
		const context = setupResult.createContext();
		const turnEnd = setupResult.handlers.get("turn_end")!;

		await rm(getHandoffBaseDir(), { recursive: true, force: true });
		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);

		expect(setupResult.sentMessages).toHaveLength(1);
		const dirStat = await stat(getHandoffBaseDir());
		expect(dirStat.isDirectory()).toBe(true);
	});

	test("handoff prompt is wrap-safe: quoted absolute path in its own fenced block", async () => {
		const setupResult = setup();
		const context = setupResult.createContext();
		const turnEnd = setupResult.handlers.get("turn_end")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);

		const text = setupResult.sentMessages[0].text;
		// Explicit no-line-break instruction.
		expect(text.toLowerCase()).toContain("do not insert line breaks");
		// Each absolute path appears quoted on its own single line inside a fenced block.
		expect(text).toMatch(/```text\n"[^\n"]+-handoff\.md"\n```/);
		expect(text).toMatch(/```text\n"[^\n"]+-handoff-prompt\.md"\n```/);
		// Short file names are shown as well.
		expect(text).toContain("`session-test-id-");
	});

	test("requests a handoff mid-run with deliverAs steer when the agent is not idle", async () => {
		const setupResult = setup();
		const context = setupResult.createContext(/* idle */ false);
		const turnEnd = setupResult.handlers.get("turn_end")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);

		expect(setupResult.sentMessages).toHaveLength(1);
		expect(setupResult.sentMessages[0].options).toEqual({ deliverAs: "steer" });
	});

	test("verifies generated files, compacts, and sends the generated prompt path", async () => {
		const setupResult = setup();
		const context = setupResult.createContext();
		const turnEnd = setupResult.handlers.get("turn_end")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);
		const request = setupResult.sentMessages[0].text;
		const paths = extractPaths(request).filter((p) => p.startsWith("/"));
		const handoffPath = paths.find((path) => path.endsWith("-handoff.md"))!;
		const promptPath = paths.find((path) => path.endsWith("-handoff-prompt.md"))!;

		expect(handoffPath).toBeTruthy();
		expect(promptPath).toBeTruthy();
		await mkdir(dirname(handoffPath), { recursive: true });
		await writeFile(handoffPath, "verified handoff", "utf8");
		await writeFile(promptPath, "continue from handoff", "utf8");
		await turnEnd({}, context);

		expect(setupResult.getCompactCalls()).toBe(1);
		expect(setupResult.sentMessages[1].text).toBe(`@${promptPath}`);
	});

	test("does not compact when either generated file is missing", async () => {
		const setupResult = setup();
		const context = setupResult.createContext();
		const turnEnd = setupResult.handlers.get("turn_end")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);
		await turnEnd({}, context);

		expect(setupResult.getCompactCalls()).toBe(0);
		expect(setupResult.sentMessages).toHaveLength(1);
	});

	test("turn_end waits silently when files are missing (no error notify)", async () => {
		const setupResult = setup();
		const notifications: { message: string; level: string }[] = [];
		const context = setupResult.createContext(true, notifications);
		const turnEnd = setupResult.handlers.get("turn_end")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);
		await turnEnd({}, context);
		await turnEnd({}, context);

		expect(setupResult.getCompactCalls()).toBe(0);
		expect(setupResult.sentMessages).toHaveLength(1);
		expect(notifications.some((n) => n.level === "error")).toBe(false);
	});

	test("agent_settled reports missing files once with paths and an ls hint", async () => {
		const setupResult = setup();
		const notifications: { message: string; level: string }[] = [];
		const context = setupResult.createContext(true, notifications);
		const turnEnd = setupResult.handlers.get("turn_end")!;
		const settled = setupResult.handlers.get("agent_settled")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);
		const request = setupResult.sentMessages[0].text;
		const paths = extractPaths(request).filter((p) => p.startsWith("/"));
		const handoffPath = paths.find((p) => p.endsWith("-handoff.md"))!;
		const promptPath = paths.find((p) => p.endsWith("-handoff-prompt.md"))!;

		// Intermediate turn_ends stay silent even with files missing.
		await turnEnd({}, context);
		expect(notifications.some((n) => n.level === "error")).toBe(false);

		// The settled run with files still missing is the real failure: one error max.
		await settled({ type: "agent_settled", aborted: false }, context);
		const errors = notifications.filter((n) => n.level === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain(handoffPath);
		expect(errors[0].message).toContain(promptPath);
		expect(errors[0].message).toContain("ls");
		expect(errors[0].message).toContain(getHandoffBaseDir());

		// A second settle must not repeat the error (max 1 per handoff cycle).
		await settled({ type: "agent_settled", aborted: false }, context);
		expect(notifications.filter((n) => n.level === "error")).toHaveLength(1);
		expect(setupResult.getCompactCalls()).toBe(0);
	});

	test("buildMissingFilesMessage includes both paths and the base dir", () => {
		const paths = createHandoffPaths("s", new Date("2026-01-02T03:04:05.000Z"));
		const msg = buildMissingFilesMessage(paths);
		expect(msg).toContain(paths.handoffPath);
		expect(msg).toContain(paths.nextPromptPath);
		expect(msg).toContain("ls");
		expect(msg).toContain(getHandoffBaseDir());
	});

	test("appends one index line per handoff with timestamp, session, threshold, paths", async () => {
		const setupResult = setup();
		const context = setupResult.createContext();
		const turnEnd = setupResult.handlers.get("turn_end")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);

		const indexPath = getHandoffIndexPath();
		const content = await readFile(indexPath, "utf8");
		const lines = content.trim().split("\n").filter((l) => l.startsWith("- "));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("session/test-id");
		expect(lines[0]).toContain("80%");
		const request = setupResult.sentMessages[0].text;
		for (const p of extractPaths(request).filter((p) => p.startsWith("/"))) {
			expect(lines[0]).toContain(p);
		}
	});

	test("appendHandoffIndex records threshold and both paths", async () => {
		const paths = createHandoffPaths("my-session", new Date("2026-03-04T05:06:07.000Z"));
		await appendHandoffIndex({
			sessionId: "my-session",
			threshold: { mode: "tokens", value: 150_000 },
			paths,
			date: new Date("2026-03-04T05:06:07.000Z"),
		});
		const content = await readFile(getHandoffIndexPath(), "utf8");
		expect(content).toContain("my-session");
		expect(content).toContain("150k tokens");
		expect(content).toContain(paths.handoffPath);
		expect(content).toContain(paths.nextPromptPath);
		expect(content).toContain("2026-03-04");
	});

	test("registers the /tidy-threshold command", () => {
		const setupResult = setup();
		expect(setupResult.commands.has("tidy-threshold")).toBe(true);
	});

	test("percent command updates the live threshold and turn_end respects it", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-config.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;

		const setupResult = setup();
		const notifications: { message: string; level: string }[] = [];
		const context = setupResult.createContext(true, notifications);
		const turnEnd = setupResult.handlers.get("turn_end")!;
		const command = setupResult.commands.get("tidy-threshold")!;

		await command.handler("90", context);
		expect(notifications.some((n) => n.message.includes("90%"))).toBe(true);

		// Below the new threshold (90) does not trigger, even though it is >= default 80.
		setupResult.setUsage({ tokens: 85_000, contextWindow: 100_000, percent: 85 });
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(0);

		// At the new threshold triggers.
		setupResult.setUsage({ tokens: 90_000, contextWindow: 100_000, percent: 90 });
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(1);

		// Persisted to the config file and round-trips.
		expect(await loadThreshold(configPath)).toEqual({ mode: "percent", value: 90 });
	});

	test("tokens command switches mode and triggers on absolute token count", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-config-tokens.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;

		const setupResult = setup();
		const notifications: { message: string; level: string }[] = [];
		const context = setupResult.createContext(true, notifications);
		const turnEnd = setupResult.handlers.get("turn_end")!;
		const command = setupResult.commands.get("tidy-threshold")!;

		await command.handler("150k", context);
		expect(notifications.some((n) => n.message.includes("150k"))).toBe(true);

		// Only ~15% of a 1M window, but already at the token ceiling's doorstep: no trigger yet.
		setupResult.setUsage({ tokens: 140_000, contextWindow: 1_000_000, percent: 14 });
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(0);

		// Crosses the 150k token threshold even though percent is far below the default 80%.
		setupResult.setUsage({ tokens: 151_000, contextWindow: 1_000_000, percent: 15.1 });
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(1);

		expect(await loadThreshold(configPath)).toEqual({ mode: "tokens", value: 150_000 });
	});

	test("tokens threshold is ignored while token count is unknown (null)", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-config-tokens-null.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;

		const setupResult = setup();
		const context = setupResult.createContext();
		const turnEnd = setupResult.handlers.get("turn_end")!;
		const command = setupResult.commands.get("tidy-threshold")!;

		await command.handler("150k", context);

		// Right after compaction tokens/percent are null: must not fire.
		setupResult.setUsage({ tokens: null as unknown as number, contextWindow: 200_000, percent: null });
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(0);
	});

	test("invalid command argument is rejected and leaves the threshold unchanged", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-config-invalid.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;

		const setupResult = setup();
		const notifications: { message: string; level: string }[] = [];
		const context = setupResult.createContext(true, notifications);
		const turnEnd = setupResult.handlers.get("turn_end")!;
		const command = setupResult.commands.get("tidy-threshold")!;

		await command.handler("not-a-number", context);
		expect(notifications.some((n) => n.level === "error" && n.message.includes("Invalid"))).toBe(true);

		// Default threshold (80%) still in effect: 80% triggers.
		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(1);

		// Nothing was persisted.
		expect(await loadThreshold(configPath)).toEqual(DEFAULT_THRESHOLD);
	});

	test("session_start loads the threshold from the config file", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-config-session.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;
		await saveThreshold({ mode: "percent", value: 95 }, configPath);

		const setupResult = setup();
		const context = setupResult.createContext();
		const sessionStart = setupResult.handlers.get("session_start")!;
		const turnEnd = setupResult.handlers.get("turn_end")!;

		await sessionStart({}, context);

		// 90% is above the default 80 but below the configured 95: must not trigger.
		setupResult.setUsage({ tokens: 90_000, contextWindow: 100_000, percent: 90 });
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(0);

		setupResult.setUsage({ tokens: 95_000, contextWindow: 100_000, percent: 95 });
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(1);
	});

	test("session_start migrates the legacy { contextThreshold } config into percent mode", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-config-legacy.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, JSON.stringify({ contextThreshold: 88 }), "utf8");

		const setupResult = setup();
		const context = setupResult.createContext();
		const sessionStart = setupResult.handlers.get("session_start")!;
		const turnEnd = setupResult.handlers.get("turn_end")!;

		await sessionStart({}, context);

		// 80% would trigger the default, but the migrated 88% is in effect.
		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(0);

		setupResult.setUsage({ tokens: 88_000, contextWindow: 100_000, percent: 88 });
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(1);

		expect(await loadThreshold(configPath)).toEqual({ mode: "percent", value: 88 });
	});

	test("argument completions surface the current value first", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-completions.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;

		const setupResult = setup();
		const command = setupResult.commands.get("tidy-threshold")!;
		const getCompletions = command.getArgumentCompletions!;

		// Default (percent 80): current value shown, parseable, labelled "current".
		const empty = getCompletions("") as { value: string; label: string; description?: string }[];
		expect(empty[0]).toEqual({ value: "80", label: "80%", description: "current" });
		// A tokens preset is offered as a mode switch.
		expect(empty.some((i) => i.value === "150k" && i.description === "switch to tokens mode")).toBe(true);

		// After switching to tokens, the current item reflects the new mode.
		const ctx = setupResult.createContext(true, []);
		await command.handler("200k", ctx);
		const after = getCompletions("") as { value: string; label: string; description?: string }[];
		expect(after[0]).toEqual({ value: "200k", label: "200k tokens", description: "current" });

		// Prefix filtering: typing "15" narrows to the 150k preset.
		const filtered = getCompletions("15") as { value: string }[];
		expect(filtered.every((i) => i.value.startsWith("15"))).toBe(true);
		expect(filtered.some((i) => i.value === "150k")).toBe(true);

		// No match returns null.
		expect(getCompletions("zzz")).toBeNull();
	});
});

describe("normalizeHandoffPath", () => {
	test.each([
		["  /tmp/x-handoff.md  ", "/tmp/x-handoff.md"],
		['"/tmp/x-handoff.md"', "/tmp/x-handoff.md"],
		["'/tmp/x-handoff.md'", "/tmp/x-handoff.md"],
		["/tmp/x-\nhandoff.md", "/tmp/x-handoff.md"],
		["/tmp/x-\r\nhandoff.md\n", "/tmp/x-handoff.md"],
		["", ""],
	])("normalizes %j -> %j", (input, expected) => {
		expect(normalizeHandoffPath(input)).toBe(expected);
	});

	test("readiness check tolerates wrapped/quoted path echoes", async () => {
		const paths = createHandoffPaths("wrap-test", new Date("2026-05-06T07:08:09.000Z"));
		await mkdir(dirname(paths.handoffPath), { recursive: true });
		await writeFile(paths.handoffPath, "handoff", "utf8");
		await writeFile(paths.nextPromptPath, "prompt", "utf8");

		const padded = {
			handoffPath: `  "${paths.handoffPath}"\n`,
			nextPromptPath: `\n${paths.nextPromptPath}  `,
		};
		expect(await handoffFilesReady(tmpdir(), padded)).toBe(true);
	});
});

describe("template override", () => {
	test("user handoff.md override wins over the bundled template", async () => {
		const agentDir = join(tmpdir(), `pi-agent-override-${Date.now()}`);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "handoff.md"), "OVERRIDE MARKER {{HANDOFF_FILE}}", "utf8");

		expect(await loadTemplate()).toBe("OVERRIDE MARKER {{HANDOFF_FILE}}");
		await rm(agentDir, { recursive: true, force: true });
	});

	test("falls back to the bundled template when no override exists", async () => {
		const agentDir = join(tmpdir(), `pi-agent-empty-${Date.now()}`);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await mkdir(agentDir, { recursive: true });

		const template = await loadTemplate();
		expect(template).toContain("Context Handoff Instructions");
		expect(template).toContain("{{HANDOFF_FILE}}");
		await rm(agentDir, { recursive: true, force: true });
	});

	test("turn_end prompt uses the override template when present", async () => {
		const agentDir = join(tmpdir(), `pi-agent-turn-${Date.now()}`);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "handoff.md"), "OVERRIDE PROMPT {{HANDOFF_FILE}}", "utf8");

		const setupResult = setup();
		const context = setupResult.createContext();
		const turnEnd = setupResult.handlers.get("turn_end")!;
		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);

		expect(setupResult.sentMessages[0].text).toContain("OVERRIDE PROMPT");
		await rm(agentDir, { recursive: true, force: true });
	});
});

describe("parseThreshold", () => {
	test.each<[string, ThresholdConfig]>([
		["85", { mode: "percent", value: 85 }],
		["  42 ", { mode: "percent", value: 42 }],
		["1", { mode: "percent", value: 1 }],
		["100", { mode: "percent", value: 100 }],
		["150k", { mode: "tokens", value: 150_000 }],
		["150K", { mode: "tokens", value: 150_000 }],
		[" 200k ", { mode: "tokens", value: 200_000 }],
		["1k", { mode: "tokens", value: 1000 }],
	])("accepts %s -> %j", (input, expected) => {
		expect(parseThreshold(input)).toEqual(expected);
	});

	test.each([
		"",
		"   ",
		"abc",
		"8.5",
		"0",
		"101",
		"-5",
		"80%",
		"150_000",
		"1.5k",
		"k",
		"1500kk",
	])("rejects %s", (input) => {
		expect(parseThreshold(input)).toBeNull();
	});
});

describe("threshold formatting", () => {
	test.each<[ThresholdConfig, string, string]>([
		[{ mode: "percent", value: 80 }, "80", "80%"],
		[{ mode: "percent", value: 100 }, "100", "100%"],
		[{ mode: "tokens", value: 150_000 }, "150k", "150k tokens"],
		[{ mode: "tokens", value: 200_000 }, "200k", "200k tokens"],
		[{ mode: "tokens", value: 1000 }, "1k", "1k tokens"],
		[{ mode: "tokens", value: 150_500 }, "150500", "150500 tokens"],
	])("formats %j -> input %s, display %s", (config, input, display) => {
		expect(thresholdToInput(config)).toBe(input);
		expect(formatThreshold(config)).toBe(display);
	});
});

describe("threshold persistence", () => {
	const configPath = join(tmpdir(), "pi-handoff-test-roundtrip.json");

	beforeEach(async () => {
		await rm(configPath, { force: true });
	});

	test("save then load round-trips a percent config", async () => {
		await saveThreshold({ mode: "percent", value: 77 }, configPath);
		expect(await loadThreshold(configPath)).toEqual({ mode: "percent", value: 77 });
	});

	test("save then load round-trips a tokens config", async () => {
		await saveThreshold({ mode: "tokens", value: 256_000 }, configPath);
		expect(await loadThreshold(configPath)).toEqual({ mode: "tokens", value: 256_000 });
	});

	test("missing or corrupt file falls back to the default", async () => {
		expect(await loadThreshold(configPath)).toEqual(DEFAULT_THRESHOLD);
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, "{ not valid json", "utf8");
		expect(await loadThreshold(configPath)).toEqual(DEFAULT_THRESHOLD);
	});

	test("legacy { contextThreshold } is read as percent mode", async () => {
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, JSON.stringify({ contextThreshold: 88 }), "utf8");
		expect(await loadThreshold(configPath)).toEqual({ mode: "percent", value: 88 });
	});

	test("out-of-range legacy percent falls back to the default", async () => {
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, JSON.stringify({ contextThreshold: 150 }), "utf8");
		expect(await loadThreshold(configPath)).toEqual(DEFAULT_THRESHOLD);
	});
});

describe("deferred compaction (no abort noise)", () => {
	test("defers compact while the run is active and compacts on agent_settled when idle", async () => {
		const setupResult = setup();
		const busy = { ...setupResult.createContext(/* idle */ false), signal: new AbortController().signal };
		const idle = setupResult.createContext(/* idle */ true);
		const turnEnd = setupResult.handlers.get("turn_end")!;
		const settled = setupResult.handlers.get("agent_settled")!;
		expect(settled).toBeTruthy();

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, busy);
		const request = setupResult.sentMessages[0].text;
		const paths = extractPaths(request).filter((p) => p.startsWith("/"));
		const handoffPath = paths.find((path) => path.endsWith("-handoff.md"))!;
		const promptPath = paths.find((path) => path.endsWith("-handoff-prompt.md"))!;
		await mkdir(dirname(handoffPath), { recursive: true });
		await writeFile(handoffPath, "verified handoff", "utf8");
		await writeFile(promptPath, "continue from handoff", "utf8");

		// Run still active: must NOT call compact (that abort()s the run and
		// surfaces "Error: This operation was aborted").
		await turnEnd({}, busy);
		expect(setupResult.getCompactCalls()).toBe(0);
		expect(setupResult.sentMessages).toHaveLength(1);

		// Settles idle: the deferred compact fires and delivers the prompt.
		await settled({ type: "agent_settled", aborted: false }, idle);
		expect(setupResult.getCompactCalls()).toBe(1);
		expect(setupResult.sentMessages[1].text).toBe(`@${promptPath}`);
	});

	test("compacts immediately on turn_end when already idle", async () => {
		const setupResult = setup();
		const context = setupResult.createContext(/* idle */ true);
		const turnEnd = setupResult.handlers.get("turn_end")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);
		const request = setupResult.sentMessages[0].text;
		const paths = extractPaths(request).filter((p) => p.startsWith("/"));
		const handoffPath = paths.find((path) => path.endsWith("-handoff.md"))!;
		const promptPath = paths.find((path) => path.endsWith("-handoff-prompt.md"))!;
		await mkdir(dirname(handoffPath), { recursive: true });
		await writeFile(handoffPath, "h", "utf8");
		await writeFile(promptPath, "p", "utf8");
		await turnEnd({}, context);
		expect(setupResult.getCompactCalls()).toBe(1);
		expect(setupResult.sentMessages[1].text).toBe(`@${promptPath}`);
	});

	test("aborted settle keeps the handoff pending instead of compacting", async () => {
		const setupResult = setup();
		const busy = { ...setupResult.createContext(/* idle */ false), signal: new AbortController().signal };
		const idle = setupResult.createContext(/* idle */ true);
		const turnEnd = setupResult.handlers.get("turn_end")!;
		const settled = setupResult.handlers.get("agent_settled")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, busy);
		const request = setupResult.sentMessages[0].text;
		const paths = extractPaths(request).filter((p) => p.startsWith("/"));
		const handoffPath = paths.find((path) => path.endsWith("-handoff.md"))!;
		const promptPath = paths.find((path) => path.endsWith("-handoff-prompt.md"))!;
		await mkdir(dirname(handoffPath), { recursive: true });
		await writeFile(handoffPath, "h", "utf8");
		await writeFile(promptPath, "p", "utf8");
		await turnEnd({}, busy);
		expect(setupResult.getCompactCalls()).toBe(0);

		await settled({ type: "agent_settled", aborted: true }, idle);
		expect(setupResult.getCompactCalls()).toBe(0);

		await settled({ type: "agent_settled", aborted: false }, idle);
		expect(setupResult.getCompactCalls()).toBe(1);
	});

	test("compaction failure returns to awaiting-files and notifies", async () => {
		const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
		const sentMessages: { text: string }[] = [];
		const notifications: { message: string; level: string }[] = [];
		let usage = { tokens: 80_000, contextWindow: 100_000, percent: 80 };
		let compactCalls = 0;
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: any) => Promise<void>) => { handlers.set(event, handler); },
			sendUserMessage: (text: string) => { sentMessages.push({ text }); },
			registerCommand: () => {},
		};
		extension(pi as any);
		const ctx = {
			cwd: tmpdir(),
			isIdle: () => true,
			signal: undefined,
			getContextUsage: () => usage,
			sessionManager: { getSessionId: () => "session/test-id" },
			ui: {
				notify: (message: string, level: string) => { notifications.push({ message, level }); },
				setWorkingMessage: (_message?: string) => {},
			},
			compact: (options: any) => { compactCalls += 1; options.onError?.(new Error("boom")); },
		};
		const turnEnd = handlers.get("turn_end")!;
		await turnEnd({}, ctx);
		const request = sentMessages[0].text;
		const paths = extractPaths(request).filter((p) => p.startsWith("/"));
		const handoffPath = paths.find((p) => p.endsWith("-handoff.md"))!;
		const promptPath = paths.find((p) => p.endsWith("-handoff-prompt.md"))!;
		await mkdir(dirname(handoffPath), { recursive: true });
		await writeFile(handoffPath, "h", "utf8");
		await writeFile(promptPath, "p", "utf8");
		await turnEnd({}, ctx);
		expect(compactCalls).toBe(1);
		expect(notifications.some((n) => n.level === "error" && n.message.includes("boom"))).toBe(true);
		// Back to awaiting-files: no extra compact on the next settled event
		// without re-verification churn, and a retry is possible.
		const settled = handlers.get("agent_settled")!;
		await settled({ type: "agent_settled", aborted: false }, ctx);
		expect(compactCalls).toBe(2);
	});
});

describe("handoff working message", () => {
	test("shows preparing/writing/will-compact, clears before compact, sends next prompt and clears on next turn_start", async () => {
		const setupResult = setup();
		const notifications: { message: string; level: string }[] = [];
		const working: (string | undefined)[] = [];
		const tuiOpts = { mode: "tui", working };
		const idle = setupResult.createContext(true, notifications, tuiOpts);
		const busy = { ...setupResult.createContext(false, notifications, tuiOpts), signal: new AbortController().signal };
		const turnEnd = setupResult.handlers.get("turn_end")!;
		const settled = setupResult.handlers.get("agent_settled")!;
		const turnStart = setupResult.handlers.get("turn_start")!;
		expect(turnStart).toBeTruthy();

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, idle);
		expect(working.at(-1)).toBe("tidy-context: preparing handoff files");

		await turnEnd({}, idle);
		expect(working.at(-1)).toBe("tidy-context: writing handoff files");

		const request = setupResult.sentMessages[0].text;
		const paths = extractPaths(request).filter((p) => p.startsWith("/"));
		const handoffPath = paths.find((p) => p.endsWith("-handoff.md"))!;
		const promptPath = paths.find((p) => p.endsWith("-handoff-prompt.md"))!;
		await mkdir(dirname(handoffPath), { recursive: true });
		await writeFile(handoffPath, "h", "utf8");
		await writeFile(promptPath, "p", "utf8");

		await turnEnd({}, busy);
		expect(working.at(-1)).toBe("tidy-context: will compact on settle");
		expect(setupResult.getCompactCalls()).toBe(0);

		await settled({ type: "agent_settled", aborted: false }, idle);
		expect(setupResult.getCompactCalls()).toBe(1);
		// clear before compact, then sending-next-prompt on complete.
		expect(working.at(-2)).toBeUndefined();
		expect(working.at(-1)).toBe("tidy-context: sending next prompt");
		expect(setupResult.sentMessages[1].text).toBe(`@${promptPath}`);

		// Next turn_start clears the Working line (one-shot).
		const before = working.length;
		await turnStart({}, idle);
		expect(working).toHaveLength(before + 1);
		expect(working.at(-1)).toBeUndefined();
		// Second turn_start is a no-op (flag consumed).
		await turnStart({}, idle);
		expect(working).toHaveLength(before + 1);
	});

	test("clears the working message on the final missing-files error", async () => {
		const setupResult = setup();
		const notifications: { message: string; level: string }[] = [];
		const working: (string | undefined)[] = [];
		const context = setupResult.createContext(true, notifications, { mode: "tui", working });
		const turnEnd = setupResult.handlers.get("turn_end")!;
		const settled = setupResult.handlers.get("agent_settled")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);
		expect(working.at(-1)).toBe("tidy-context: preparing handoff files");

		await settled({ type: "agent_settled", aborted: false }, context);
		expect(notifications.some((n) => n.level === "error")).toBe(true);
		expect(working.at(-1)).toBeUndefined();
	});

	test("clears the working message on compaction failure", async () => {
		const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
		const notifications: { message: string; level: string }[] = [];
		const working: (string | undefined)[] = [];
		const usage = { tokens: 80_000, contextWindow: 100_000, percent: 80 };
		const sentMessages: { text: string }[] = [];
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: any) => Promise<void>) => { handlers.set(event, handler); },
			sendUserMessage: (text: string) => { sentMessages.push({ text }); },
			registerCommand: () => {},
		};
		extension(pi as any);
		const ctx = {
			cwd: tmpdir(),
			mode: "tui",
			isIdle: () => true,
			signal: undefined,
			getContextUsage: () => usage,
			sessionManager: { getSessionId: () => "session/test-id" },
			ui: {
				notify: (message: string, level: string) => { notifications.push({ message, level }); },
				setWorkingMessage: (message?: string) => { working.push(message); },
			},
			compact: (options: any) => { options.onError?.(new Error("boom")); },
		};
		const turnEnd = handlers.get("turn_end")!;
		await turnEnd({}, ctx);
		expect(working.at(-1)).toBe("tidy-context: preparing handoff files");
		const request = sentMessages[0].text;
		const paths = extractPaths(request).filter((p) => p.startsWith("/"));
		const handoffPath = paths.find((p) => p.endsWith("-handoff.md"))!;
		const promptPath = paths.find((p) => p.endsWith("-handoff-prompt.md"))!;
		await mkdir(dirname(handoffPath), { recursive: true });
		await writeFile(handoffPath, "h", "utf8");
		await writeFile(promptPath, "p", "utf8");
		await turnEnd({}, ctx);
		expect(notifications.some((n) => n.level === "error" && n.message.includes("boom"))).toBe(true);
		expect(working.at(-1)).toBeUndefined();
	});

	test("works in every mode without guard (no-op outside TUI, notify fallback preserved)", async () => {
		for (const mode of [undefined, "rpc", "print", "tui"] as const) {
			const setupResult = setup();
			const notifications: { message: string; level: string }[] = [];
			const working: (string | undefined)[] = [];
			const context = setupResult.createContext(true, notifications, { mode: mode as unknown as string, working });
			const turnEnd = setupResult.handlers.get("turn_end")!;
			const settled = setupResult.handlers.get("agent_settled")!;

			setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
			await turnEnd({}, context);
			expect(working.at(-1)).toBe("tidy-context: preparing handoff files");
			await turnEnd({}, context);
			expect(working.at(-1)).toBe("tidy-context: writing handoff files");
			await settled({ type: "agent_settled", aborted: false }, context);
			// Flow still works via notify even where the Working line is a no-op.
			expect(working.at(-1)).toBeUndefined();
			expect(notifications.some((n) => n.message.includes("Preparing handoff"))).toBe(true);
		}
	});

	test("session_start resets state without touching the working message", async () => {
		const configPath = join(tmpdir(), `pi-handoff-test-session-working-${Date.now()}.json`);
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;
		const setupResult = setup();
		const working: (string | undefined)[] = [];
		const context = setupResult.createContext(true, [], { mode: "tui", working });
		const sessionStart = setupResult.handlers.get("session_start")!;
		const turnEnd = setupResult.handlers.get("turn_end")!;

		setupResult.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		await turnEnd({}, context);
		expect(working.at(-1)).toBe("tidy-context: preparing handoff files");
		const afterHandoff = working.length;

		await sessionStart({}, context);
		// session_start must not push or clear the Working line.
		expect(working).toHaveLength(afterHandoff);
		// State is reset: the next threshold breach starts a fresh handoff.
		await turnEnd({}, context);
		expect(setupResult.sentMessages).toHaveLength(2);
		expect(working.at(-1)).toBe("tidy-context: preparing handoff files");
	});
});

describe("keepRecentTokens guard", () => {
	async function makeDirs() {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-guard-"));
		const projectDir = await mkdtemp(join(tmpdir(), "pi-proj-guard-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		return { agentDir, projectDir };
	}

	async function cleanup(dirs: { agentDir: string; projectDir: string }) {
		await rm(dirs.agentDir, { recursive: true, force: true });
		await rm(dirs.projectDir, { recursive: true, force: true });
	}

	test("loads defaults when no settings files exist", async () => {
		const dirs = await makeDirs();
		try {
			const compaction = await loadCompactionSettings(dirs.projectDir, dirs.agentDir);
			expect(compaction).toEqual({});
			expect(resolveKeepRecent(compaction)).toBe(DEFAULT_KEEP_RECENT_TOKENS);
			expect(resolveKeepRecent(undefined)).toBe(20000);
			expect(resolveReserveTokens(compaction)).toBe(DEFAULT_RESERVE_TOKENS);
			expect(resolveReserveTokens(undefined)).toBe(16384);
		} finally {
			await cleanup(dirs);
		}
	});

	test("merges global and project layers with project winning and nested merge", async () => {
		const dirs = await makeDirs();
		try {
			await writeFile(
				join(dirs.agentDir, "settings.json"),
				JSON.stringify({
					compaction: {
						keepRecentTokens: 30000,
						reserveTokens: 10000,
						modelOverrides: { "acme/a": { keepRecentTokens: 5000 } },
					},
				}),
				"utf8",
			);
			await mkdir(join(dirs.projectDir, ".pi"), { recursive: true });
			await writeFile(
				join(dirs.projectDir, ".pi", "settings.json"),
				JSON.stringify({ compaction: { keepRecentTokens: 25000 } }),
				"utf8",
			);

			const compaction = await loadCompactionSettings(dirs.projectDir, dirs.agentDir);
			expect(compaction.keepRecentTokens).toBe(25000);
			expect(compaction.reserveTokens).toBe(10000);
			expect(resolveKeepRecent(compaction, "acme/a")).toBe(5000);
			expect(resolveKeepRecent(compaction, "other/b")).toBe(25000);
			expect(resolveKeepRecent(compaction)).toBe(25000);
		} finally {
			await cleanup(dirs);
		}
	});

	test("model override falls back per field to the general value", async () => {
		expect(resolveKeepRecent({ keepRecentTokens: 30000, modelOverrides: { "acme/a": { reserveTokens: 1 } } }, "acme/a")).toBe(30000);
		expect(resolveReserveTokens({ keepRecentTokens: 30000, modelOverrides: { "acme/a": { reserveTokens: 1 } } }, "acme/a")).toBe(1);
		expect(resolveKeepRecent({ modelOverrides: { "acme/a": { keepRecentTokens: 7000 } } }, "acme/a")).toBe(7000);
		// Key is exact and case-sensitive, slashes in the model id included.
		expect(resolveKeepRecent({ keepRecentTokens: 30000, modelOverrides: { "acme/a/b": { keepRecentTokens: 1 } } }, "acme/a/b")).toBe(1);
		expect(resolveKeepRecent({ keepRecentTokens: 30000, modelOverrides: { "ACME/A": { keepRecentTokens: 1 } } }, "acme/a")).toBe(30000);
	});

	test("invalid values are ignored via fallback and never throw", async () => {
		const dirs = await makeDirs();
		try {
			await writeFile(
				join(dirs.agentDir, "settings.json"),
				JSON.stringify({
					compaction: {
						keepRecentTokens: -3,
						reserveTokens: 1.5,
						modelOverrides: { "acme/a": "nope", "acme/b": { keepRecentTokens: "lots" } },
					},
				}),
				"utf8",
			);
			const compaction = await loadCompactionSettings(dirs.projectDir, dirs.agentDir);
			expect(resolveKeepRecent(compaction)).toBe(20000);
			expect(resolveReserveTokens(compaction)).toBe(16384);
			expect(resolveKeepRecent(compaction, "acme/a")).toBe(20000);
			expect(resolveKeepRecent(compaction, "acme/b")).toBe(20000);

			expect(resolveKeepRecent({ keepRecentTokens: Number.NaN })).toBe(20000);
			expect(resolveKeepRecent({ keepRecentTokens: null })).toBe(20000);

			// Corrupt JSON and non-object compaction read as empty, without throwing.
			await writeFile(join(dirs.agentDir, "settings.json"), "{ not valid json", "utf8");
			expect(await loadCompactionSettings(dirs.projectDir, dirs.agentDir)).toEqual({});
			await writeFile(join(dirs.agentDir, "settings.json"), JSON.stringify({ compaction: null }), "utf8");
			expect(await loadCompactionSettings(dirs.projectDir, dirs.agentDir)).toEqual({});
			await expect(loadCompactionSettings(dirs.projectDir, join(dirs.agentDir, "missing-dir"))).resolves.toEqual({});
		} finally {
			await cleanup(dirs);
		}
	});

	test("mergeSettingsLayers mirrors pi semantics", () => {
		expect(mergeSettingsLayers({ a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 3 } })).toEqual({
			a: 1,
			nested: { x: 1, y: 3 },
		});
		// Arrays replace; undefined is skipped.
		expect(mergeSettingsLayers({ a: [1], b: 1 }, { a: [2], b: undefined as unknown as number })).toEqual({ a: [2], b: 1 });
	});

	test("thresholdToTokens converts both modes and skips unknown windows", () => {
		expect(thresholdToTokens({ mode: "tokens", value: 150_000 })).toBe(150_000);
		expect(thresholdToTokens({ mode: "tokens", value: 150_000 }, undefined)).toBe(150_000);
		expect(thresholdToTokens({ mode: "percent", value: 80 }, 200_000)).toBe(160_000);
		expect(thresholdToTokens({ mode: "percent", value: 5 }, 200_000)).toBe(10_000);
		expect(thresholdToTokens({ mode: "percent", value: 80 }, undefined)).toBeUndefined();
		expect(thresholdToTokens({ mode: "percent", value: 80 }, null)).toBeUndefined();
		expect(thresholdToTokens({ mode: "percent", value: 80 }, 0)).toBeUndefined();
	});

	test("rejects tokens threshold at/below keepRecent without saving", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-guard-tokens.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;
		const dirs = await makeDirs();
		try {
			const setupResult = setup();
			const notifications: { message: string; level: string }[] = [];
			const base = setupResult.createContext(true, notifications);
			const context = { ...base, cwd: dirs.projectDir };
			const command = setupResult.commands.get("tidy-threshold")!;
			const turnEnd = setupResult.handlers.get("turn_end")!;

			await command.handler("15k", context);
			const errors = notifications.filter((n) => n.level === "error");
			expect(errors).toHaveLength(1);
			expect(errors[0].message).toBe(
				"Threshold 15k tokens (15000 tokens) is at/below keepRecentTokens (20k tokens): handoff would refire after every compaction. Not saved.",
			);
			// No success confirmation on rejection.
			expect(notifications.some((n) => n.level === "info" && n.message.includes("Handoff threshold set"))).toBe(false);
			// File intact (nothing persisted).
			expect(await loadThreshold(configPath)).toEqual(DEFAULT_THRESHOLD);
			// Memory intact: still the default 80%, not 15k tokens.
			setupResult.setUsage({ tokens: 16_000, contextWindow: 1_000_000, percent: 1.6 });
			await turnEnd({}, context);
			expect(setupResult.sentMessages).toHaveLength(0);

			// Boundary: exactly equal rejects (<=).
			notifications.length = 0;
			await command.handler("20k", context);
			expect(notifications).toHaveLength(1);
			expect(notifications[0].level).toBe("error");
			expect(notifications[0].message).toContain("at/below keepRecentTokens");
			expect(notifications[0].message).toContain("Not saved.");
			expect(await loadThreshold(configPath)).toEqual(DEFAULT_THRESHOLD);

			// Above keepRecent: saves normally with confirmation, no error.
			notifications.length = 0;
			await command.handler("150k", context);
			expect(notifications.some((n) => n.level === "error")).toBe(false);
			expect(notifications.some((n) => n.level === "info" && n.message.includes("150k"))).toBe(true);
			expect(await loadThreshold(configPath)).toEqual({ mode: "tokens", value: 150_000 });
		} finally {
			await cleanup(dirs);
			await rm(configPath, { force: true });
		}
	});

	test("rejects low percent threshold using the model context window", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-guard-percent.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;
		const dirs = await makeDirs();
		try {
			const setupResult = setup();
			const notifications: { message: string; level: string }[] = [];
			const base = setupResult.createContext(true, notifications);
			const context = {
				...base,
				cwd: dirs.projectDir,
				model: { provider: "acme", id: "big-model", contextWindow: 200_000 },
			};
			const command = setupResult.commands.get("tidy-threshold")!;
			const turnEnd = setupResult.handlers.get("turn_end")!;

			// 5% of 200k = 10k tokens <= 20k keepRecent: rejects.
			await command.handler("5", context);
			expect(notifications).toHaveLength(1);
			expect(notifications[0].level).toBe("error");
			expect(notifications[0].message).toContain("at/below keepRecentTokens");
			expect(notifications[0].message).toContain("Not saved.");
			expect(await loadThreshold(configPath)).toEqual(DEFAULT_THRESHOLD);
			// Memory intact: 5% would fire here, default 80% does not.
			setupResult.setUsage({ tokens: 10_000, contextWindow: 200_000, percent: 5 });
			await turnEnd({}, context);
			expect(setupResult.sentMessages).toHaveLength(0);

			// 80% of 200k = 160k tokens: saves normally.
			notifications.length = 0;
			await command.handler("80", context);
			expect(notifications.some((n) => n.level === "error")).toBe(false);
			expect(notifications.some((n) => n.level === "info" && n.message.includes("80%"))).toBe(true);
			expect(await loadThreshold(configPath)).toEqual({ mode: "percent", value: 80 });
		} finally {
			await cleanup(dirs);
			await rm(configPath, { force: true });
		}
	});

	test("percent mode stays silent when the window is unknown", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-guard-unknown.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;
		const dirs = await makeDirs();
		try {
			const setupResult = setup();
			const notifications: { message: string; level: string }[] = [];
			const base = setupResult.createContext(true, notifications);
			const context = { ...base, cwd: dirs.projectDir, model: undefined, getContextUsage: () => undefined };
			const command = setupResult.commands.get("tidy-threshold")!;

			await command.handler("5", context);
			expect(notifications.some((n) => n.message.includes("at/below keepRecentTokens"))).toBe(false);
			expect(notifications.some((n) => n.message.includes("5%") && n.level === "info")).toBe(true);
			expect(await loadThreshold(configPath)).toEqual({ mode: "percent", value: 5 });
		} finally {
			await cleanup(dirs);
			await rm(configPath, { force: true });
		}
	});

	test("honors model overrides and project settings in the handler", async () => {
		const configPath = join(tmpdir(), "pi-handoff-test-guard-override.json");
		process.env.PI_HANDOFF_CONFIG_PATH = configPath;
		const dirs = await makeDirs();
		try {
			await writeFile(
				join(dirs.agentDir, "settings.json"),
				JSON.stringify({
					compaction: { keepRecentTokens: 5000, modelOverrides: { "acme/big": { keepRecentTokens: 100_000 } } },
				}),
				"utf8",
			);
			const setupResult = setup();
			const notifications: { message: string; level: string }[] = [];
			const base = setupResult.createContext(true, notifications);
			const command = setupResult.commands.get("tidy-threshold")!;

			// 90k > general 5k, but <= model override 100k: rejects for that model.
			await command.handler("90k", {
				...base,
				cwd: dirs.projectDir,
				model: { provider: "acme", id: "big", contextWindow: 200_000 },
			});
			expect(notifications.some((n) => n.level === "error" && n.message.includes("at/below keepRecentTokens"))).toBe(true);
			expect(notifications.some((n) => n.message.includes("Not saved."))).toBe(true);
			expect(await loadThreshold(configPath)).toEqual(DEFAULT_THRESHOLD);

			// Same threshold without a model uses the general value: saves normally.
			notifications.length = 0;
			await command.handler("90k", { ...base, cwd: dirs.projectDir });
			expect(notifications.some((n) => n.message.includes("at/below keepRecentTokens"))).toBe(false);
			expect(notifications.some((n) => n.level === "info" && n.message.includes("90k"))).toBe(true);
			expect(await loadThreshold(configPath)).toEqual({ mode: "tokens", value: 90_000 });

			// Project layer raises keepRecent above the threshold read from usage window.
			await mkdir(join(dirs.projectDir, ".pi"), { recursive: true });
			await writeFile(
				join(dirs.projectDir, ".pi", "settings.json"),
				JSON.stringify({ compaction: { keepRecentTokens: 200_000 } }),
				"utf8",
			);
			notifications.length = 0;
			await command.handler("150k", { ...base, cwd: dirs.projectDir });
			expect(notifications.some((n) => n.level === "error" && n.message.includes("at/below keepRecentTokens"))).toBe(true);
			expect(await loadThreshold(configPath)).toEqual({ mode: "tokens", value: 90_000 });
		} finally {
			await cleanup(dirs);
			await rm(configPath, { force: true });
		}
	});
});
