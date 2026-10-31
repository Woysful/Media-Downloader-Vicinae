import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { environment } from "@vicinae/api";
import type { Settings } from "./settings";

export interface Toolchain {
	ytdlp: string;
	ytdlpVersion: string;
	ytdlpIsLocal: boolean;
	ffmpeg?: string;
	ffprobe?: string;
	/** Value for `--js-runtimes`, set when the yt-dlp build supports it. */
	jsRuntime?: string;
}

export class ToolError extends Error {}

type Report = (title: string, message?: string) => void;

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** First yt-dlp release with `--js-runtimes` (YouTube needs a JS runtime since then). */
const JS_RUNTIMES_SINCE = "2025.11.12";
const OUTDATED_AFTER_DAYS = 60;

/**
 * Launchers started from a desktop session often have a minimal PATH, so the
 * usual user-level install locations are searched as well.
 */
export function searchPath(): string[] {
	const home = os.homedir();
	const extra = [
		path.join(home, ".local", "bin"),
		path.join(home, "bin"),
		path.join(home, ".nix-profile", "bin"),
		"/run/current-system/sw/bin",
		"/usr/local/bin",
		"/opt/homebrew/bin",
		"/usr/bin",
		"/bin",
		"/snap/bin",
	];
	const fromEnv = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean);
	return [...new Set([...fromEnv, ...extra])];
}

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

export function findExecutable(name: string): string | undefined {
	for (const dir of searchPath()) {
		const candidate = path.join(dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{
				timeout: timeoutMs,
				env: { ...process.env, PATH: searchPath().join(path.delimiter) },
			},
			(error, stdout, stderr) => {
				if (error) reject(new Error(stderr?.trim() || error.message));
				else resolve(stdout.trim());
			},
		);
	});
}

function binDir(): string {
	return path.join(environment.supportPath, "bin");
}

function localYtdlpPath(): string {
	return path.join(
		binDir(),
		process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
	);
}

function releaseAsset(): string {
	if (process.platform === "darwin") return "yt-dlp_macos";
	if (process.platform === "win32") return "yt-dlp.exe";
	if (process.platform === "linux" && process.arch === "x64")
		return "yt-dlp_linux";
	if (process.platform === "linux" && process.arch === "arm64")
		return "yt-dlp_linux_aarch64";
	// Zipapp build: works anywhere python3 is installed.
	return "yt-dlp";
}

function download(
	url: string,
	dest: string,
	onProgress: (percent: number | null) => void,
	redirects = 5,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = https.get(
			url,
			{ headers: { "User-Agent": "vicinae-media-downloader" } },
			(response) => {
				const status = response.statusCode ?? 0;
				if (status >= 300 && status < 400 && response.headers.location) {
					response.resume();
					if (redirects <= 0) return reject(new Error("Too many redirects"));
					const next = new URL(response.headers.location, url).toString();
					download(next, dest, onProgress, redirects - 1).then(resolve, reject);
					return;
				}
				if (status !== 200) {
					response.resume();
					return reject(new Error(`HTTP ${status} while downloading ${url}`));
				}

				const total = Number(response.headers["content-length"]) || 0;
				let received = 0;
				const file = fs.createWriteStream(dest, { mode: 0o755 });
				response.on("data", (chunk: Buffer) => {
					received += chunk.length;
					onProgress(total ? (received / total) * 100 : null);
				});
				response.pipe(file);
				file.on("finish", () => file.close(() => resolve()));
				file.on("error", reject);
				response.on("error", reject);
			},
		);
		request.on("error", reject);
		request.setTimeout(30_000, () =>
			request.destroy(new Error("Connection timed out")),
		);
	});
}

async function installYtdlp(report: Report): Promise<string> {
	const target = localYtdlpPath();
	fs.mkdirSync(binDir(), { recursive: true });

	const assets = [...new Set([releaseAsset(), "yt-dlp"])];
	let lastError: unknown;
	for (const asset of assets) {
		const tmp = `${target}.download`;
		try {
			report("Installing yt-dlp…", asset);
			let lastShown = -1;
			await download(
				`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`,
				tmp,
				(percent) => {
					const shown = percent === null ? null : Math.floor(percent / 5) * 5;
					if (shown !== null && shown !== lastShown) {
						lastShown = shown;
						report(`Installing yt-dlp… ${shown}%`, asset);
					}
				},
			);
			fs.chmodSync(tmp, 0o755);
			await run(tmp, ["--version"], 30_000);
			fs.renameSync(tmp, target);
			fs.writeFileSync(
				path.join(binDir(), ".last-update-check"),
				String(Date.now()),
			);
			return target;
		} catch (error) {
			lastError = error;
			fs.rmSync(tmp, { force: true });
		}
	}
	throw new ToolError(
		`yt-dlp is not installed and could not be downloaded automatically (${
			lastError instanceof Error ? lastError.message : String(lastError)
		}). Install it with your package manager or set its path in the extension preferences.`,
	);
}

async function maybeUpdateLocal(bin: string, report: Report): Promise<void> {
	const stamp = path.join(binDir(), ".last-update-check");
	let last = 0;
	try {
		last = Number(fs.readFileSync(stamp, "utf8")) || 0;
	} catch {
		// Never checked.
	}
	if (Date.now() - last < UPDATE_INTERVAL_MS) return;

	// Written up front so a failing update (e.g. offline) is not retried on every download.
	fs.writeFileSync(stamp, String(Date.now()));
	report("Updating yt-dlp…");
	try {
		await run(bin, ["-U"], 120_000);
	} catch (error) {
		console.warn("yt-dlp self-update failed:", error);
	}
}

async function resolveYtdlp(
	settings: Settings,
	report: Report,
): Promise<{ bin: string; local: boolean }> {
	if (settings.ytdlpPath) {
		if (!isExecutable(settings.ytdlpPath)) {
			throw new ToolError(
				`yt-dlp path from preferences is not an executable file: ${settings.ytdlpPath}`,
			);
		}
		return { bin: settings.ytdlpPath, local: false };
	}

	const system = findExecutable("yt-dlp");
	if (system) return { bin: system, local: false };

	const local = localYtdlpPath();
	if (isExecutable(local)) {
		if (settings.autoUpdateYtdlp) await maybeUpdateLocal(local, report);
		return { bin: local, local: true };
	}

	return { bin: await installYtdlp(report), local: true };
}

function resolveFfmpeg(settings: Settings): {
	ffmpeg?: string;
	ffprobe?: string;
} {
	const local = path.join(binDir(), "ffmpeg");
	const ffmpeg =
		settings.ffmpegPath ??
		findExecutable("ffmpeg") ??
		(isExecutable(local) ? local : undefined);
	if (settings.ffmpegPath && !isExecutable(settings.ffmpegPath)) {
		throw new ToolError(
			`ffmpeg path from preferences is not an executable file: ${settings.ffmpegPath}`,
		);
	}
	if (!ffmpeg) return {};
	const sibling = path.join(path.dirname(ffmpeg), "ffprobe");
	const ffprobe = isExecutable(sibling) ? sibling : findExecutable("ffprobe");
	return { ffmpeg, ffprobe };
}

export function versionAgeDays(
	version: string,
	now = Date.now(),
): number | undefined {
	const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version);
	if (!m) return undefined;
	const released = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return Math.floor((now - released) / 86_400_000);
}

export function isOutdated(version: string): boolean {
	return (versionAgeDays(version) ?? 0) > OUTDATED_AFTER_DAYS;
}

export async function resolveToolchain(
	settings: Settings,
	report: Report,
): Promise<Toolchain> {
	const { bin, local } = await resolveYtdlp(settings, report);

	let version: string;
	try {
		version = (await run(bin, ["--version"], 30_000)).split(/\s+/)[0];
	} catch (error) {
		throw new ToolError(
			`yt-dlp at ${bin} does not run: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const { ffmpeg, ffprobe } = resolveFfmpeg(settings);
	if (!ffmpeg) {
		throw new ToolError(
			"ffmpeg was not found. Install it (e.g. `sudo apt install ffmpeg`, `sudo pacman -S ffmpeg`) or set its path in the extension preferences.",
		);
	}

	return {
		ytdlp: bin,
		ytdlpVersion: version,
		ytdlpIsLocal: local,
		ffmpeg,
		ffprobe,
		// yt-dlp needs a JavaScript runtime for YouTube; the Node binary running
		// this extension is always available, unlike deno.
		jsRuntime:
			version.slice(0, 10) >= JS_RUNTIMES_SINCE
				? `node:${process.execPath}`
				: undefined,
	};
}
