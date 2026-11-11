import {
	AUDIO_FORMATS,
	type AudioFormat,
	asAudioFormat,
	asVideoContainer,
	audioSupportsThumbnail,
	DEFAULT_AUDIO_SELECTOR,
	DEFAULT_VIDEO_SELECTOR,
	isLossless,
	type Quality,
	VIDEO_CONTAINERS,
	type VideoContainer,
	videoSupportsThumbnail,
} from "./constants";
import type { DomainRule } from "./domain-config";
import {
	AUDIO_CODEC_PRESETS,
	type AudioReencodeCodec,
	CODEC_PRESETS,
	type EncodeAttempt,
	type EncoderSupport,
	planAudioEncode,
	planEncode,
	type ReencodeCodec,
	resolveAudioReencodeCodec,
	resolveReencodeCodec,
} from "./reencode";
import type { Settings } from "./settings";
import { ShellWordsError, splitShellWords } from "./shell-words";

export type DownloadKind = "video" | "audio" | "video-best" | "audio-best";

export interface DownloadRequest {
	kind: DownloadKind;
	url: string;
	container?: string;
	quality?: Quality;
	selector?: string;
	ffmpegArgs?: string;
	extraArgs?: string[];
	/** Codec, true (preference codec), false (off) or undefined (rule/preferences decide). */
	reencode?: ReencodeCodec | boolean;
	/** Audio codec for the video's audio track, false (off) or undefined (preferences decide). */
	audioReencode?: AudioReencodeCodec | boolean;
	playlist: boolean;
}

export interface PlanEnv {
	tempDir: string;
	ffmpegPath?: string;
	/** Value for `--js-runtimes`, only set when the yt-dlp build supports it. */
	jsRuntime?: string;
	/** When set, unavailable encoders are skipped or reported before downloading. */
	encoders?: EncoderSupport;
}

export interface PlanSummary {
	kind: DownloadKind;
	selector: string;
	container?: VideoContainer;
	audioFormat?: AudioFormat;
	quality: Quality;
	reencode: { codec: ReencodeCodec; title: string; notice?: string } | null;
	audioReencode: { codec: AudioReencodeCodec; title: string } | null;
	playlist: boolean;
	rule?: { line: number; domains: string[] };
}

export interface DownloadPlan {
	args: string[];
	/** ffmpeg attempts for the post-download re-encode pass (fallbacks after the first). */
	encode: EncodeAttempt[] | null;
	summary: PlanSummary;
}

export class PlanError extends Error {}

/*
 * Machine-readable lines consumed by assets/runner.js. Free-text fields (title,
 * file path) come last so that "|" inside them cannot shift other columns.
 */
const PROGRESS_TEMPLATE =
	"download:MDL|dl|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(info.vcodec)s|%(info.acodec)s";
const POSTPROCESS_TEMPLATE =
	"postprocess:MDL|pp|%(progress.status)s|%(progress.postprocessor)s";
const START_PRINT =
	"before_dl:MDL|start|%(playlist_index)s|%(n_entries)s|%(format_id)s|%(title)s";
const FILE_PRINT = "after_move:MDL|file|%(duration)s|%(fps)s|%(filepath)s";

function words(value: string | undefined, label: string): string[] {
	if (!value?.trim()) return [];
	try {
		return splitShellWords(value);
	} catch (error) {
		throw new PlanError(
			`${label}: ${error instanceof ShellWordsError ? error.message : String(error)}`,
		);
	}
}

function resolveContainer(value: string): VideoContainer {
	const container = asVideoContainer(value);
	if (!container)
		throw new PlanError(
			`Unknown video format "${value}". Use one of: ${VIDEO_CONTAINERS.join(", ")}`,
		);
	return container;
}

function resolveAudioFormat(value: string): AudioFormat {
	const format = asAudioFormat(value);
	if (!format)
		throw new PlanError(
			`Unknown audio format "${value}". Use one of: ${AUDIO_FORMATS.join(", ")}, ogg`,
		);
	return format;
}

/**
 * Resolves the effective settings (query keys > domain rule > preferences)
 * and turns them into a yt-dlp command line.
 */
export function buildPlan(
	req: DownloadRequest,
	settings: Settings,
	rule: DomainRule | undefined,
	env: PlanEnv,
): DownloadPlan {
	const r = rule?.settings ?? {};
	const args: string[] = [
		"--newline",
		"--progress",
		"--no-simulate",
		"--progress-template",
		PROGRESS_TEMPLATE,
		"--progress-template",
		POSTPROCESS_TEMPLATE,
		"--print",
		START_PRINT,
		"--print",
		FILE_PRINT,
		"--no-mtime",
		// --no-playlist only resolves "video inside a playlist" links; some
		// extractors (archive.org, pure playlist URLs) still return every entry.
		...(req.playlist
			? ["--yes-playlist"]
			: ["--no-playlist", "--playlist-items", "1"]),
		"-P",
		`home:${settings.downloadDir}`,
		"-P",
		`temp:${env.tempDir}`,
		"-o",
		req.playlist ? settings.playlistTemplate : settings.outputTemplate,
	];

	if (env.ffmpegPath) args.push("--ffmpeg-location", env.ffmpegPath);
	if (env.jsRuntime) args.push("--js-runtimes", env.jsRuntime);
	if (settings.cookiesFromBrowser)
		args.push("--cookies-from-browser", settings.cookiesFromBrowser);
	if (settings.embedMetadata) args.push("--embed-metadata");

	let encode: EncodeAttempt[] | null = null;
	const summary: PlanSummary = {
		kind: req.kind,
		selector: "",
		quality: "best",
		reencode: null,
		audioReencode: null,
		playlist: req.playlist,
		rule: rule ? { line: rule.line, domains: rule.domains } : undefined,
	};

	switch (req.kind) {
		case "video": {
			const selector = req.selector ?? r.selector ?? settings.videoSelector;
			const container = resolveContainer(
				req.container ?? r.container ?? settings.videoContainer,
			);
			const quality = req.quality ?? r.quality ?? settings.quality;
			const ffmpeg = req.ffmpegArgs ?? r.ffmpegArgs;
			const codec = resolveReencodeCodec(
				req.reencode,
				r.reencode,
				settings.reencodeCodec,
			);
			const audioCodec = resolveAudioReencodeCodec(
				req.audioReencode,
				r.audioReencode,
				settings.reencodeAudioCodec,
			);

			args.push("-f", selector);
			// Format sorting (unlike filters in the selector) keeps the user's
			// selector working: it only changes which matching format wins.
			if (quality !== "best") args.push("-S", `res:${quality}`);

			if (audioCodec && env.encoders) {
				const preset = AUDIO_CODEC_PRESETS[audioCodec];
				if (!env.encoders.encoders.has(preset.encoder)) {
					throw new PlanError(
						`Your ffmpeg has no ${preset.encoder} encoder. Pick another audio re-encode codec.`,
					);
				}
			}

			if (codec || audioCodec) {
				const extra = [
					...words(settings.reencodeExtraArgs, "Re-encode arguments"),
					...words(ffmpeg, "ffmpeg arguments"),
				];

				if (codec) {
					const { attempts, notice } = planEncode(
						codec,
						extra,
						env.encoders,
						audioCodec ? AUDIO_CODEC_PRESETS[audioCodec].args : undefined,
					);
					if (!attempts.length) {
						const preset = CODEC_PRESETS[codec];
						throw new PlanError(
							preset.hardware === "vaapi" &&
								env.encoders?.encoders.has(preset.encoder)
								? "No VA-API device found (/dev/dri/renderD*)"
								: `Your ffmpeg has no ${preset.encoder} encoder. Pick another re-encode codec.`,
						);
					}
					encode = attempts;
					summary.reencode = {
						codec,
						title: CODEC_PRESETS[codec].title,
						notice,
					};
					// Matroska accepts any codec pair, so the merge never fails before the re-encode pass.
					args.push("--merge-output-format", "mkv");
				} else if (audioCodec) {
					// The video stream is copied, so keep the requested container.
					// The audio pass runs after yt-dlp has merged/remuxed the file.
					encode = [planAudioEncode(audioCodec, extra, container)];
					args.push(
						"--merge-output-format",
						container,
						"--remux-video",
						container,
					);
				}

				if (audioCodec) {
					summary.audioReencode = {
						codec: audioCodec,
						title: AUDIO_CODEC_PRESETS[audioCodec].title,
					};
				}
			} else {
				args.push(
					"--merge-output-format",
					container,
					"--remux-video",
					container,
				);
				if (ffmpeg)
					args.push(
						"--postprocessor-args",
						`Merger:${ffmpeg}`,
						"--postprocessor-args",
						`VideoRemuxer:${ffmpeg}`,
					);
				if (settings.embedThumbnail && videoSupportsThumbnail(container))
					args.push("--embed-thumbnail");
			}

			Object.assign(summary, {
				selector,
				container: encode ? encode[0].ext : container,
				quality,
			});
			break;
		}

		case "audio": {
			const selector = req.selector ?? DEFAULT_AUDIO_SELECTOR;
			const format = resolveAudioFormat(
				req.container ?? r.audioFormat ?? settings.audioFormat,
			);
			const ffmpeg = req.ffmpegArgs ?? r.audioFfmpegArgs;

			args.push("-f", selector, "-x", "--audio-format", format);
			if (!isLossless(format))
				args.push("--audio-quality", settings.audioQuality);
			if (ffmpeg) args.push("--postprocessor-args", `ExtractAudio:${ffmpeg}`);
			if (settings.embedThumbnail && audioSupportsThumbnail(format))
				args.push("--embed-thumbnail");

			Object.assign(summary, { selector, audioFormat: format });
			break;
		}

		case "video-best":
			args.push("-f", DEFAULT_VIDEO_SELECTOR);
			summary.selector = DEFAULT_VIDEO_SELECTOR;
			break;

		case "audio-best":
			args.push("-f", DEFAULT_AUDIO_SELECTOR, "-x", "--audio-format", "wav");
			Object.assign(summary, {
				selector: DEFAULT_AUDIO_SELECTOR,
				audioFormat: "wav",
			});
			break;
	}

	args.push(
		...words(settings.extraArgs, "Extra yt-dlp arguments"),
		...words(r.extraArgs, `domain-config.txt line ${rule?.line}`),
		...(req.extraArgs ?? []),
	);
	args.push("--", req.url);

	return { args, encode, summary };
}
