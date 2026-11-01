import {
	type AudioFormat,
	asAudioFormat,
	asVideoContainer,
	COOKIE_BROWSERS,
	DEFAULT_OUTPUT_TEMPLATE,
	DEFAULT_PLAYLIST_TEMPLATE,
	DEFAULT_VIDEO_SELECTOR,
	parseQuality,
	type Quality,
	type VideoContainer,
} from "./constants";
import { defaultDownloadDir, normalizeUserPath } from "./paths";
import { asReencodeCodec, type ReencodeCodec } from "./reencode";

export interface Settings {
	downloadDir: string;
	videoContainer: VideoContainer;
	videoSelector: string;
	quality: Quality;
	/** Re-encode every video download (otherwise only with -e or a domain rule). */
	reencodeAlways: boolean;
	reencodeCodec: ReencodeCodec;
	reencodeExtraArgs: string;
	audioFormat: AudioFormat;
	audioQuality: string;
	embedMetadata: boolean;
	embedThumbnail: boolean;
	cookiesFromBrowser?: string;
	extraArgs: string;
	outputTemplate: string;
	playlistTemplate: string;
	domainConfigDir?: string;
	ytdlpPath?: string;
	ffmpegPath?: string;
	autoUpdateYtdlp: boolean;
	notify: boolean;
	openFolder: boolean;
	progressNotification: boolean;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function flag(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Vicinae passes `null` for optional preferences that were never set, and
 * older installs may carry values that are no longer offered in dropdowns,
 * so every value is validated and defaulted here.
 */
export function normalizeSettings(raw: Record<string, unknown>): Settings {
	const browser = text(raw.cookiesFromBrowser)?.toLowerCase();
	const audioQuality = text(raw.audioQuality) ?? "0";

	return {
		downloadDir:
			normalizeUserPath(raw.downloadDirectory) ?? defaultDownloadDir(),
		videoContainer: asVideoContainer(text(raw.defaultVideoFormat)) ?? "mp4",
		videoSelector: text(raw.defaultVideoSelector) ?? DEFAULT_VIDEO_SELECTOR,
		quality: parseQuality(text(raw.defaultQuality)) ?? "best",
		reencodeAlways: flag(raw.reencodeAlways, false),
		reencodeCodec: asReencodeCodec(text(raw.reencodeCodec)) ?? "h264",
		reencodeExtraArgs: text(raw.reencodeExtraArguments) ?? "",
		audioFormat: asAudioFormat(text(raw.defaultAudioFormat)) ?? "m4a",
		audioQuality: /^(\d|10|\d+[kK])$/.test(audioQuality) ? audioQuality : "0",
		embedMetadata: flag(raw.embedMetadata, true),
		embedThumbnail: flag(raw.embedThumbnail, false),
		cookiesFromBrowser: (COOKIE_BROWSERS as readonly string[]).includes(
			browser ?? "",
		)
			? browser
			: undefined,
		extraArgs: text(raw.extraArguments) ?? "",
		outputTemplate: text(raw.outputTemplate) ?? DEFAULT_OUTPUT_TEMPLATE,
		playlistTemplate: text(raw.playlistTemplate) ?? DEFAULT_PLAYLIST_TEMPLATE,
		domainConfigDir: normalizeUserPath(raw.customDomainConfig),
		ytdlpPath: normalizeUserPath(raw.ytdlpPath),
		ffmpegPath: normalizeUserPath(raw.ffmpegPath),
		autoUpdateYtdlp: flag(raw.autoUpdateYtdlp, true),
		notify: flag(raw.notifyOnCompletion, true),
		openFolder: flag(raw.openFileManagerAfterDownload, false),
		progressNotification: flag(raw.progressNotification, true),
	};
}
