import * as fs from "node:fs";
import * as path from "node:path";
import {
	environment,
	getPreferenceValues,
	open,
	sendDesktopNotification,
	showInFileBrowser,
	showToast,
	Toast,
} from "@vicinae/api";
import { type DomainConfig, findRule, loadDomainConfig } from "./domain-config";
import {
	acknowledge,
	cleanupOldJobs,
	type Job,
	prepareJob,
	readJobState,
	startJob,
} from "./jobs";
import {
	buildPlan,
	type DownloadKind,
	type DownloadPlan,
	type DownloadRequest,
	PlanError,
} from "./plan";
import {
	type ParsedQuery,
	parseQuery,
	QueryError,
	type QueryKey,
} from "./query";
import { normalizeSettings, type Settings } from "./settings";
import {
	describeOutcome,
	describeProgress,
	explainError,
	isSuccess,
	isTerminal,
	type JobState,
} from "./status";
import {
	isOutdated,
	resolveToolchain,
	type Toolchain,
	ToolError,
} from "./tools";

const POLL_INTERVAL_MS = 500;

/**
 * Vicinae has a single footer toast slot; every showToast() call replaces it.
 * Keeping one Toast and serialising updates avoids flicker and out-of-order
 * states when updates arrive faster than the RPC round-trip.
 */
export class StatusToast {
	private toast: Toast | undefined;
	private last = "";
	private queue: Promise<void> = Promise.resolve();

	set(style: Toast.Style, title: string, message = ""): Promise<void> {
		const key = `${style}\u0000${title}\u0000${message}`;
		if (key === this.last) return this.queue;
		this.last = key;
		this.queue = this.queue
			.then(async () => {
				if (!this.toast) {
					this.toast = await showToast({ style, title, message });
					return;
				}
				// The message setter does not push an update by itself; the
				// title setter (or update()) sends all fields at once.
				this.toast.message = message;
				if (this.toast.style !== style) this.toast.style = style;
				if (this.toast.title !== title) this.toast.title = title;
				else await this.toast.update();
			})
			.catch((error) => console.error("Toast update failed:", error));
		return this.queue;
	}

	progress(title: string, message = ""): Promise<void> {
		return this.set(Toast.Style.Animated, title, message);
	}

	success(title: string, message = ""): Promise<void> {
		return this.set(Toast.Style.Success, title, message);
	}

	failure(title: string, message = ""): Promise<void> {
		return this.set(Toast.Style.Failure, title, message);
	}
}

export function loadSettings(): Settings {
	return normalizeSettings(getPreferenceValues<Record<string, unknown>>());
}

export function loadConfig(settings: Settings): DomainConfig | undefined {
	try {
		const config = loadDomainConfig(settings.domainConfigDir);
		for (const warning of config.warnings)
			console.warn(`${config.path}: ${warning}`);
		return config;
	} catch (error) {
		console.error("Could not read the domain config:", error);
		return undefined;
	}
}

export function requestFromQuery(
	kind: DownloadKind,
	query: ParsedQuery,
): DownloadRequest {
	return {
		kind,
		url: query.url,
		container: query.container,
		quality: query.quality,
		selector: query.selector,
		ffmpegArgs: query.ffmpegArgs,
		extraArgs: query.extraArgs,
		reencode: query.reencode,
		audioReencode: query.audioReencode,
		playlist: query.playlist,
	};
}

export interface StartedDownload {
	job: Job;
	plan: DownloadPlan;
	toolchain: Toolchain;
	settings: Settings;
}

export async function startDownload(
	req: DownloadRequest,
	toast: StatusToast,
): Promise<StartedDownload> {
	const settings = loadSettings();
	const config = loadConfig(settings);
	const rule = config ? findRule(config.rules, req.url) : undefined;

	await toast.progress("Preparing download…");
	const toolchain = await resolveToolchain(
		settings,
		(title, message) => void toast.progress(title, message),
	);

	fs.mkdirSync(settings.downloadDir, { recursive: true });
	cleanupOldJobs();

	const job = prepareJob();
	try {
		const plan = buildPlan(req, settings, rule, {
			tempDir: job.tempDir,
			ffmpegPath: toolchain.ffmpeg,
			jsRuntime: toolchain.jsRuntime,
			encoders: toolchain.encoders,
		});

		startJob(job, {
			url: req.url,
			kind: req.kind,
			request: req,
			playlist: req.playlist,
			downloadDir: settings.downloadDir,
			ytdlp: { bin: toolchain.ytdlp, args: plan.args },
			reencode:
				plan.encode && toolchain.ffmpeg
					? {
							ffmpeg: toolchain.ffmpeg,
							ffprobe: toolchain.ffprobe ?? null,
							attempts: plan.encode,
						}
					: null,
			notice: plan.summary.reencode?.notice ?? null,
			notify: settings.notify,
			progressNotification: settings.progressNotification,
			openFolder: settings.openFolder,
			iconPath: path.join(environment.assetsPath, "icon.png"),
		});

		console.log(
			`Started job ${job.id}: ${toolchain.ytdlp} ${plan.args.join(" ")}`,
		);
		return { job, plan, toolchain, settings };
	} catch (error) {
		fs.rmSync(job.dir, { recursive: true, force: true });
		throw error;
	}
}

export interface MonitorOptions {
	onState?: (state: JobState) => void;
	isCancelled?: () => boolean;
}

/** Polls the job until it ends, mirroring progress into the toast. */
export async function monitorDownload(
	started: StartedDownload,
	toast: StatusToast,
	options: MonitorOptions = {},
): Promise<JobState | undefined> {
	const { job, toolchain, settings } = started;
	const playlist = started.plan.summary.playlist;
	let lastUpdate = 0;
	let state: JobState | undefined;

	while (!options.isCancelled?.()) {
		state = readJobState(job);
		if (state && state.updatedAt !== lastUpdate) {
			lastUpdate = state.updatedAt;
			options.onState?.(state);
			if (isTerminal(state.status)) break;
			const { title, message } = describeProgress(state, playlist);
			await toast.progress(title, message);
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}

	if (!state || !isTerminal(state.status)) return state;

	// Tells the runner that this command handles notifications itself.
	acknowledge(job);

	if (state.error)
		state.error = explainError(state.error, isOutdated(toolchain.ytdlpVersion));
	options.onState?.(state);
	const { title, message } = describeOutcome(state, playlist);

	if (state.status === "completed" || state.status === "cancelled")
		await toast.success(title, message);
	else await toast.failure(title, message);

	// A runner showing a progress notification turns it into the result itself.
	if (
		settings.notify &&
		state.status !== "cancelled" &&
		!state.notificationOwned
	) {
		sendDesktopNotification({
			title,
			body: message,
			icon: path.join(environment.assetsPath, "icon.png"),
		}).catch((error: unknown) =>
			console.warn("Desktop notification failed:", error),
		);
	}

	if (settings.openFolder && isSuccess(state.status))
		await revealResult(state, settings);

	return state;
}

export async function revealResult(
	state: JobState,
	settings: Settings,
): Promise<void> {
	const first = state.files[0]?.path;
	try {
		if (first && fs.existsSync(first)) await showInFileBrowser(first);
		else await open(settings.downloadDir);
	} catch (error) {
		console.warn("Could not open the file manager:", error);
	}
}

export function errorMessage(error: unknown): {
	title: string;
	message: string;
} {
	if (error instanceof QueryError)
		return { title: "Invalid input", message: error.message };
	if (error instanceof PlanError)
		return { title: "Invalid settings", message: error.message };
	if (error instanceof ToolError)
		return { title: "Missing tool", message: error.message };
	return {
		title: "Download failed",
		message: error instanceof Error ? error.message : String(error),
	};
}

/** Entry point shared by the no-view commands. */
export async function runQuickDownload(
	kind: DownloadKind,
	input: string | undefined,
	keys: readonly QueryKey[],
) {
	const toast = new StatusToast();
	try {
		if (!input?.trim()) {
			await toast.failure(
				"No URL entered",
				"Paste a link after the command name",
			);
			return;
		}
		const req = requestFromQuery(kind, parseQuery(input, keys));
		const started = await startDownload(req, toast);
		await toast.progress("Fetching video info…");
		await monitorDownload(started, toast);
	} catch (error) {
		const { title, message } = errorMessage(error);
		console.error(title, error);
		await toast.failure(title, message);
	}
}
