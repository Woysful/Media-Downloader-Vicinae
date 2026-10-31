import * as path from "node:path";

/** Mirrors the state published by assets/runner.js. */
export type JobStatus =
	| "starting"
	| "downloading"
	| "processing"
	| "encoding"
	| "completed"
	| "partial"
	| "failed"
	| "cancelled";

export interface JobFile {
	path: string;
	duration: number | null;
	fps: number | null;
}

export interface JobState {
	status: JobStatus;
	stage: string | null;
	title: string | null;
	item: { index: number; count: number | null } | null;
	stream: "video" | "audio" | null;
	streamCount: number;
	percent: number | null;
	speed: number | null;
	eta: number | null;
	downloaded: number | null;
	total: number | null;
	files: JobFile[];
	error: string | null;
	exitCode: number | null;
	pid: number;
	startedAt: number;
	updatedAt: number;
	finishedAt: number | null;
}

export function isTerminal(status: JobStatus): boolean {
	return (
		status === "completed" ||
		status === "partial" ||
		status === "failed" ||
		status === "cancelled"
	);
}

export function isSuccess(status: JobStatus): boolean {
	return status === "completed" || status === "partial";
}

export function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatEta(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const STAGES: Record<string, string> = {
	Merger: "Merging video and audio",
	VideoRemuxer: "Remuxing",
	VideoConvertor: "Converting video",
	ExtractAudio: "Converting audio",
	Metadata: "Embedding metadata",
	EmbedThumbnail: "Embedding thumbnail",
	ThumbnailsConvertor: "Converting thumbnail",
	FixupM3u8: "Fixing up stream",
	FixupM4a: "Fixing up stream",
	FixupStretched: "Fixing up stream",
	FixupDuplicateMoov: "Fixing up stream",
	FixupTimestamp: "Fixing up stream",
	FixupDuration: "Fixing up stream",
	MoveFiles: "Finishing",
	"Re-encode": "Re-encoding for editing",
};

export function stageLabel(stage: string | null): string {
	if (!stage) return "Processing";
	return STAGES[stage] ?? stage;
}

function itemPrefix(state: JobState, playlist: boolean): string {
	if (!state.item || !playlist) return "";
	return state.item.count
		? `[${state.item.index}/${state.item.count}] `
		: `[${state.item.index}] `;
}

/**
 * Title is what Vicinae always shows in the footer; the message is muted and
 * elided first, so the numbers go in the title and the media name in the message.
 */
export function describeProgress(
	state: JobState,
	playlist = true,
): { title: string; message: string } {
	const prefix = itemPrefix(state, playlist);
	const name = state.title ?? "";

	switch (state.status) {
		case "starting":
			return { title: "Fetching video info…", message: "" };
		case "downloading": {
			const parts: string[] = [];
			const label =
				state.streamCount > 1 && state.stream ? `${state.stream} ` : "";
			parts.push(
				state.percent === null
					? `Downloading ${label}`.trimEnd() + "…"
					: `${label}${state.percent.toFixed(1)}%`,
			);
			if (state.speed) parts.push(`${formatBytes(state.speed)}/s`);
			if (state.eta) parts.push(`ETA ${formatEta(state.eta)}`);
			return { title: `${prefix}${parts.join(" · ")}`, message: name };
		}
		case "processing":
			return { title: `${prefix}${stageLabel(state.stage)}…`, message: name };
		case "encoding": {
			const parts = [`${prefix}${stageLabel(state.stage)}`];
			if (state.percent !== null) parts.push(`${state.percent.toFixed(0)}%`);
			if (state.eta) parts.push(`ETA ${formatEta(state.eta)}`);
			return { title: parts.join(" · "), message: name };
		}
		default:
			return describeOutcome(state, playlist);
	}
}

export function describeOutcome(
	state: JobState,
	playlist = true,
): { title: string; message: string } {
	const names = state.files.map((f) => path.basename(f.path));
	const saved =
		names.length > 1
			? `${names.length} files`
			: (names[0] ?? state.title ?? "");
	const skipped =
		!playlist && (state.item?.count ?? 0) > 1 ? state.item?.count : undefined;
	switch (state.status) {
		case "completed":
			if (skipped)
				return {
					title: `Downloaded 1 of ${skipped} playlist items`,
					message: `${saved} · add -p for all`,
				};
			return { title: "Download complete", message: saved };
		case "partial":
			return {
				title: `Downloaded ${names.length} file(s) with errors`,
				message: state.error ?? "",
			};
		case "cancelled":
			return { title: "Download cancelled", message: state.title ?? "" };
		default:
			return {
				title: "Download failed",
				message: state.error ?? "Unknown error",
			};
	}
}

/** Adds an actionable hint to common yt-dlp failures. */
export function explainError(error: string, ytdlpOutdated: boolean): string {
	let hint = "";
	if (
		/sign in|log(ged)?[ -]?in|cookies|age[- ]restricted|confirm you.?re not a bot/i.test(
			error,
		)
	) {
		hint = "Set “Cookies from browser” in the extension preferences.";
	} else if (/HTTP Error 403/i.test(error)) {
		hint = ytdlpOutdated
			? "Update yt-dlp, or set “Cookies from browser” in the preferences."
			: "The site may require cookies (“Cookies from browser” preference).";
	} else if (/Requested format is not available/i.test(error)) {
		hint = "Check -yt / -q or the domain rule for this site.";
	} else if (
		/ffmpeg|ffprobe/i.test(error) &&
		/not found|No such file/i.test(error)
	) {
		hint = "Install ffmpeg or set its path in the preferences.";
	} else if (ytdlpOutdated) {
		hint = "Your yt-dlp is outdated, update it.";
	}
	return hint ? `${error} — ${hint}` : error;
}
