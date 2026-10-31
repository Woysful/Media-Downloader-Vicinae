// @ts-check
"use strict";

/*
 * Detached download supervisor.
 *
 * Vicinae runs every command in a worker thread that is terminated as soon as
 * a no-view command is replaced by another command. To keep downloads alive
 * (and their pipes drained) regardless of what happens to the launcher, each
 * download is executed by this standalone script in its own process group.
 * It reads `job.json` from the job directory, runs yt-dlp (and optionally an
 * ffmpeg re-encode pass) and continuously publishes `state.json`, which the
 * extension commands poll to render progress.
 *
 * Only Node built-ins may be used here: the file is shipped as-is in assets/.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PREFIX = "MDL|";
const ACK_TIMEOUT_MS = 2500;
const STATE_WRITE_INTERVAL_MS = 250;
const KILL_GRACE_MS = 4000;

/**
 * @typedef {{ path: string, duration: number | null, fps: number | null }} FileEntry
 * @typedef {{ index: number, count: number | null }} PlaylistItem
 * @typedef {{
 *   status: "starting" | "downloading" | "processing" | "encoding" | "completed" | "partial" | "failed" | "cancelled",
 *   stage: string | null,
 *   title: string | null,
 *   item: PlaylistItem | null,
 *   stream: "video" | "audio" | null,
 *   streamCount: number,
 *   percent: number | null,
 *   speed: number | null,
 *   eta: number | null,
 *   downloaded: number | null,
 *   total: number | null,
 *   files: FileEntry[],
 *   error: string | null,
 *   exitCode: number | null,
 *   pid: number,
 *   startedAt: number,
 *   updatedAt: number,
 *   finishedAt: number | null,
 * }} JobState
 * @typedef {{
 *   version: number,
 *   id: string,
 *   url: string,
 *   tempDir: string,
 *   downloadDir: string,
 *   ytdlp: { bin: string, args: string[], env?: Record<string, string> },
 *   reencode: { ffmpeg: string, ffprobe: string | null, args: string[] } | null,
 *   notify: boolean,
 *   openFolder: boolean,
 *   iconPath: string | null,
 * }} JobSpec
 */

/**
 * @param {string | undefined} value
 * @returns {number | null}
 */
function toNumber(value) {
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed === "NA" || trimmed === "None") return null;
	const n = Number(trimmed);
	return Number.isFinite(n) ? n : null;
}

/**
 * @param {number} pid
 * @param {number} now
 * @returns {JobState}
 */
function createState(pid, now) {
	return {
		status: "starting",
		stage: null,
		title: null,
		item: null,
		stream: null,
		streamCount: 1,
		percent: null,
		speed: null,
		eta: null,
		downloaded: null,
		total: null,
		files: [],
		error: null,
		exitCode: null,
		pid,
		startedAt: now,
		updatedAt: now,
		finishedAt: null,
	};
}

/**
 * Removes the "ERROR: [extractor] id: " noise in front of yt-dlp error messages.
 * @param {string} line
 */
function cleanError(line) {
	return line
		.replace(/^ERROR:\s*/, "")
		.replace(/^\[[^\]]+\]\s+[\w-]+:\s+/, "")
		.trim();
}

/**
 * Applies one line of yt-dlp output to the state.
 * @param {JobState} state
 * @param {string} rawLine
 * @returns {boolean} whether the state changed
 */
function applyLine(state, rawLine) {
	const line = rawLine.replace(/\s+$/, "");
	if (!line) return false;

	if (line.startsWith("ERROR:")) {
		state.error = cleanError(line);
		return true;
	}

	if (!line.startsWith(PREFIX)) return false;

	const parts = line.slice(PREFIX.length).split("|");
	const kind = parts[0];

	if (kind === "start") {
		const index = toNumber(parts[1]);
		const count = toNumber(parts[2]);
		const formatId = parts[3] ?? "";
		state.title = parts.slice(4).join("|") || null;
		state.item = index !== null ? { index, count } : null;
		state.streamCount = formatId && formatId !== "NA" ? formatId.split("+").length : 1;
		state.status = "downloading";
		state.stage = null;
		state.stream = null;
		state.percent = null;
		state.speed = null;
		state.eta = null;
		state.downloaded = null;
		state.total = null;
		return true;
	}

	if (kind === "dl") {
		const [, status, downloadedRaw, totalRaw, estimateRaw, speedRaw, etaRaw, fragIndexRaw, fragCountRaw, vcodec, acodec] =
			parts;
		state.status = "downloading";
		state.stage = null;
		if (vcodec === "none") state.stream = "audio";
		else if (acodec === "none") state.stream = "video";
		else state.stream = null;

		if (status === "finished") {
			state.percent = 100;
			state.eta = 0;
			return true;
		}
		if (status !== "downloading") return false;

		const downloaded = toNumber(downloadedRaw);
		const total = toNumber(totalRaw) ?? toNumber(estimateRaw);
		const fragIndex = toNumber(fragIndexRaw);
		const fragCount = toNumber(fragCountRaw);

		let percent = null;
		if (downloaded !== null && total) percent = (downloaded / total) * 100;
		else if (fragIndex !== null && fragCount) percent = (fragIndex / fragCount) * 100;

		state.downloaded = downloaded;
		state.total = total;
		state.percent = percent === null ? null : Math.max(0, Math.min(100, percent));
		state.speed = toNumber(speedRaw);
		state.eta = toNumber(etaRaw);
		return true;
	}

	if (kind === "pp") {
		const [, status, name] = parts;
		if (status !== "started" && status !== "processing") return false;
		state.status = "processing";
		state.stage = name || null;
		state.percent = null;
		state.speed = null;
		state.eta = null;
		return true;
	}

	if (kind === "file") {
		const duration = toNumber(parts[1]);
		const fps = toNumber(parts[2]);
		const filePath = parts.slice(3).join("|");
		if (!filePath) return false;
		const existing = state.files.find((f) => f.path === filePath);
		if (existing) {
			existing.duration = duration;
			existing.fps = fps;
		} else {
			state.files.push({ path: filePath, duration, fps });
		}
		return true;
	}

	return false;
}

const STANDARD_RATES = [
	{ value: 24000 / 1001, label: "24000/1001" },
	{ value: 24, label: "24" },
	{ value: 25, label: "25" },
	{ value: 30000 / 1001, label: "30000/1001" },
	{ value: 30, label: "30" },
	{ value: 48, label: "48" },
	{ value: 50, label: "50" },
	{ value: 60000 / 1001, label: "60000/1001" },
	{ value: 60, label: "60" },
	{ value: 100, label: "100" },
	{ value: 120000 / 1001, label: "120000/1001" },
	{ value: 120, label: "120" },
];

/**
 * @param {string | number | null | undefined} value e.g. "30000/1001", "25/1" or 29.97
 * @returns {number | null}
 */
function parseRate(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
	const [num, den] = value.split("/").map(Number);
	const rate = den ? num / den : num;
	return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Picks the constant frame rate to encode to. Variable frame rate sources report
 * an average that is slightly off a standard rate; snapping keeps editors happy.
 * @param {number | null} rate
 * @returns {string | null}
 */
function snapFrameRate(rate) {
	if (!rate || rate < 1 || rate > 240) return null;
	let best = STANDARD_RATES[0];
	for (const candidate of STANDARD_RATES) {
		if (Math.abs(candidate.value - rate) < Math.abs(best.value - rate)) best = candidate;
	}
	if (Math.abs(best.value - rate) / best.value <= 0.02) return best.label;
	return String(Math.round(rate * 1000) / 1000);
}

/**
 * @param {FileEntry} file
 * @param {{ avgFrameRate: number | null, frameRate: number | null, duration: number | null } | null} probe
 * @param {{ args: string[] }} reencode
 * @param {string} output
 */
function buildEncodeArgs(file, probe, reencode, output) {
	const rate = snapFrameRate(probe?.avgFrameRate ?? probe?.frameRate ?? file.fps);
	return [
		"-hide_banner",
		"-nostdin",
		"-y",
		"-i",
		file.path,
		"-map",
		"0:V:0?",
		"-map",
		"0:a?",
		"-map_metadata",
		"0",
		"-map_chapters",
		"0",
		"-fps_mode",
		"cfr",
		...(rate ? ["-r", rate] : []),
		...reencode.args,
		"-progress",
		"pipe:1",
		"-nostats",
		"-loglevel",
		"error",
		output,
	];
}

/**
 * @param {JobState} state
 * @returns {{ title: string, body: string }}
 */
function describeOutcome(state) {
	const names = state.files.map((f) => path.basename(f.path));
	const body = names.length > 1 ? `${names.length} files` : (names[0] ?? state.title ?? "");
	switch (state.status) {
		case "completed":
			return { title: "Download complete", body };
		case "partial":
			return { title: "Download finished with errors", body: state.error ?? body };
		case "cancelled":
			return { title: "Download cancelled", body: state.title ?? "" };
		default:
			return { title: "Download failed", body: state.error ?? state.title ?? "" };
	}
}

/**
 * @param {string} file
 * @param {unknown} data
 */
function writeJsonAtomic(file, data) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data));
	fs.renameSync(tmp, file);
}

/**
 * @param {string} statePath
 * @param {JobState} state
 */
function createStateWriter(statePath, state) {
	let last = 0;
	/** @type {NodeJS.Timeout | null} */
	let timer = null;

	const flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		state.updatedAt = Date.now();
		last = state.updatedAt;
		try {
			writeJsonAtomic(statePath, state);
		} catch {
			// The monitor tolerates a stale state file; the next write will catch up.
		}
	};

	const schedule = () => {
		if (timer) return;
		const wait = Math.max(0, STATE_WRITE_INTERVAL_MS - (Date.now() - last));
		timer = setTimeout(flush, wait);
	};

	return { flush, schedule };
}

/**
 * @param {import("node:stream").Readable | null} stream
 * @param {(line: string) => void} onLine
 * @param {fs.WriteStream} log
 */
function readLines(stream, onLine, log) {
	if (!stream) return;
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (/** @type {string} */ chunk) => {
		log.write(chunk);
		buffer += chunk;
		const lines = buffer.split(/\r\n|\n|\r/);
		buffer = lines.pop() ?? "";
		for (const line of lines) onLine(line);
	});
	stream.on("end", () => {
		if (buffer) onLine(buffer);
		buffer = "";
	});
}

/** @type {import("node:child_process").ChildProcess | null} */
let currentChild = null;
let cancelled = false;

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {Record<string, string> | undefined} env
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} handlers
 * @param {fs.WriteStream} log
 * @returns {Promise<{ code: number | null, error: Error | null }>}
 */
function runProcess(bin, args, env, handlers, log) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(bin, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...env },
			});
		} catch (error) {
			resolve({ code: null, error: /** @type {Error} */ (error) });
			return;
		}
		currentChild = child;
		let spawnError = /** @type {Error | null} */ (null);
		readLines(child.stdout, handlers.stdout, log);
		readLines(child.stderr, handlers.stderr, log);
		child.on("error", (error) => {
			spawnError = error;
		});
		child.on("close", (code) => {
			currentChild = null;
			resolve({ code, error: spawnError });
		});
	});
}

/**
 * @param {string} ffprobe
 * @param {string} file
 * @returns {Promise<{ avgFrameRate: number | null, frameRate: number | null, duration: number | null } | null>}
 */
function probe(ffprobe, file) {
	return new Promise((resolve) => {
		let out = "";
		let child;
		try {
			child = spawn(
				ffprobe,
				[
					"-v",
					"error",
					"-select_streams",
					"V:0",
					"-show_entries",
					"stream=avg_frame_rate,r_frame_rate:format=duration",
					"-of",
					"json",
					file,
				],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
		} catch {
			resolve(null);
			return;
		}
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (/** @type {string} */ chunk) => {
			out += chunk;
		});
		child.on("error", () => resolve(null));
		child.on("close", () => {
			try {
				const data = JSON.parse(out);
				const stream = data.streams?.[0] ?? {};
				resolve({
					avgFrameRate: parseRate(stream.avg_frame_rate),
					frameRate: parseRate(stream.r_frame_rate),
					duration: toNumber(String(data.format?.duration ?? "")),
				});
			} catch {
				resolve(null);
			}
		});
	});
}

/**
 * @param {JobSpec} job
 * @param {JobState} state
 * @param {{ schedule: () => void, flush: () => void }} writer
 * @param {fs.WriteStream} log
 * @returns {Promise<boolean>} whether every file was re-encoded
 */
async function reencodeFiles(job, state, writer, log) {
	const reencode = job.reencode;
	if (!reencode) return true;

	const files = [...state.files];
	for (let i = 0; i < files.length; i++) {
		if (cancelled) return false;
		const file = files[i];
		const info = reencode.ffprobe ? await probe(reencode.ffprobe, file.path) : null;
		const duration = info?.duration ?? file.duration;
		const parsed = path.parse(file.path);
		const tmpOut = path.join(parsed.dir, `${parsed.name}.reencode-tmp.mp4`);
		const finalOut = path.join(parsed.dir, `${parsed.name}.mp4`);

		state.status = "encoding";
		state.stage = "Re-encode";
		state.title = parsed.name;
		state.item = files.length > 1 ? { index: i + 1, count: files.length } : state.item;
		state.percent = 0;
		state.speed = null;
		state.eta = null;
		writer.flush();

		/** @type {string[]} */
		const errors = [];
		const startedAt = Date.now();
		const result = await runProcess(
			reencode.ffmpeg,
			buildEncodeArgs(file, info, reencode, tmpOut),
			undefined,
			{
				stdout: (line) => {
					const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
					if (!match || !duration) return;
					const seconds = Number(match[1]) / 1e6;
					const percent = Math.max(0, Math.min(100, (seconds / duration) * 100));
					const elapsed = (Date.now() - startedAt) / 1000;
					state.percent = percent;
					state.eta = percent > 0 ? Math.round((elapsed * (100 - percent)) / percent) : null;
					writer.schedule();
				},
				stderr: (line) => {
					if (line.trim()) errors.push(line.trim());
				},
			},
			log,
		);

		if (cancelled || result.code !== 0) {
			fs.rmSync(tmpOut, { force: true });
			if (!cancelled) {
				const reason = result.error?.message ?? errors.at(-1) ?? `ffmpeg exited with code ${result.code}`;
				state.error = `Re-encoding failed: ${reason}`;
			}
			return false;
		}

		fs.renameSync(tmpOut, finalOut);
		if (finalOut !== file.path) fs.rmSync(file.path, { force: true });
		const entry = state.files.find((f) => f.path === file.path);
		if (entry) entry.path = finalOut;
		state.percent = 100;
		writer.flush();
	}
	return true;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 */
function spawnDetachedQuiet(cmd, args) {
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// Best effort only.
	}
}

/** @param {string} value */
function appleScriptString(value) {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Used only when no extension command acknowledged the result, i.e. the
 * launcher unloaded the command that started this download.
 * @param {JobSpec} job
 * @param {JobState} state
 */
function fallbackFinish(job, state) {
	if (job.notify) {
		const { title, body } = describeOutcome(state);
		if (process.platform === "darwin") {
			spawnDetachedQuiet("osascript", [
				"-e",
				`display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`,
			]);
		} else {
			const args = ["-a", "Media Downloader"];
			if (job.iconPath) args.push("-i", job.iconPath);
			spawnDetachedQuiet("notify-send", [...args, title, body]);
		}
	}

	if (job.openFolder && (state.status === "completed" || state.status === "partial")) {
		const first = state.files[0]?.path;
		if (process.platform === "darwin") {
			spawnDetachedQuiet("open", first ? ["-R", first] : [job.downloadDir]);
		} else {
			spawnDetachedQuiet("xdg-open", [first ? path.dirname(first) : job.downloadDir]);
		}
	}
}

/**
 * @param {string} ackPath
 * @param {number} timeoutMs
 */
async function waitForAck(ackPath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(ackPath)) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return fs.existsSync(ackPath);
}

/** @param {string} jobDir */
async function main(jobDir) {
	const job = /** @type {JobSpec} */ (JSON.parse(fs.readFileSync(path.join(jobDir, "job.json"), "utf8")));
	const state = createState(process.pid, Date.now());
	const writer = createStateWriter(path.join(jobDir, "state.json"), state);
	const log = fs.createWriteStream(path.join(jobDir, "output.log"), { flags: "a" });

	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		const child = currentChild;
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, KILL_GRACE_MS).unref();
		}
	};
	process.on("SIGTERM", cancel);
	process.on("SIGINT", cancel);
	process.on("SIGHUP", () => {});

	writer.flush();

	try {
		const onLine = (/** @type {string} */ line) => {
			if (applyLine(state, line)) writer.schedule();
		};
		const result = await runProcess(job.ytdlp.bin, job.ytdlp.args, job.ytdlp.env, { stdout: onLine, stderr: onLine }, log);

		if (cancelled) {
			state.status = "cancelled";
		} else if (result.error) {
			state.status = "failed";
			state.error = `Could not start yt-dlp: ${result.error.message}`;
		} else {
			state.exitCode = result.code;
			const encoded = state.files.length > 0 ? await reencodeFiles(job, state, writer, log) : true;
			if (cancelled) state.status = "cancelled";
			else if (!encoded) state.status = "failed";
			else if (result.code === 0) state.status = "completed";
			else if (state.files.length > 0) state.status = "partial";
			else {
				state.status = "failed";
				state.error = state.error ?? `yt-dlp exited with code ${result.code}`;
			}
		}
	} catch (error) {
		state.status = cancelled ? "cancelled" : "failed";
		state.error = state.error ?? String(error instanceof Error ? error.message : error);
	}

	state.stage = null;
	state.speed = null;
	state.eta = null;
	state.finishedAt = Date.now();
	writer.flush();

	try {
		fs.rmSync(job.tempDir, { recursive: true, force: true });
	} catch {
		// Leftover temp files are removed with the job directory later on.
	}

	await new Promise((r) => log.end(r));

	const acknowledged = await waitForAck(path.join(jobDir, "ack"), ACK_TIMEOUT_MS);
	if (!acknowledged) fallbackFinish(job, state);
}

module.exports = {
	applyLine,
	buildEncodeArgs,
	cleanError,
	createState,
	describeOutcome,
	parseRate,
	snapFrameRate,
};

if (require.main === module) {
	const jobDir = process.argv[2];
	if (!jobDir) {
		console.error("usage: runner.js <job-dir>");
		process.exit(2);
	}
	main(jobDir).then(
		() => process.exit(0),
		() => process.exit(1),
	);
}
