export const VIDEO_CONTAINERS = [
	"mp4",
	"mkv",
	"webm",
	"mov",
	"avi",
	"flv",
] as const;
export type VideoContainer = (typeof VIDEO_CONTAINERS)[number];

/** Values accepted by `yt-dlp --audio-format`. */
export const AUDIO_FORMATS = [
	"m4a",
	"mp3",
	"opus",
	"vorbis",
	"flac",
	"alac",
	"wav",
	"aac",
] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

/** Names people commonly type that yt-dlp spells differently. */
const AUDIO_FORMAT_ALIASES: Record<string, AudioFormat> = { ogg: "vorbis" };

const LOSSLESS_AUDIO: readonly AudioFormat[] = ["flac", "alac", "wav"];
const THUMBNAIL_AUDIO: readonly AudioFormat[] = [
	"m4a",
	"mp3",
	"opus",
	"vorbis",
	"flac",
	"alac",
];
const THUMBNAIL_VIDEO: readonly VideoContainer[] = ["mp4", "mkv", "mov"];

/**
 * original: keep whatever streams the site serves.
 * prefer:   prefer H.264 + AAC streams at the same resolution (no re-encoding).
 * reencode: re-encode to H.264/AAC MP4 with a constant frame rate.
 */
export const COMPAT_MODES = ["original", "prefer", "reencode"] as const;
export type CompatMode = (typeof COMPAT_MODES)[number];

export type Quality = number | "best";

export const DEFAULT_VIDEO_SELECTOR = "bv*+ba/b";
export const DEFAULT_AUDIO_SELECTOR = "ba/b";
export const DEFAULT_OUTPUT_TEMPLATE = "%(title)s.%(ext)s";
export const DEFAULT_PLAYLIST_TEMPLATE =
	"%(playlist_title,playlist_id|Playlist)s/%(playlist_index&{:03d} - |)s%(title)s.%(ext)s";
export const DEFAULT_REENCODE_ARGS =
	"-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart";

export const COOKIE_BROWSERS = [
	"brave",
	"chrome",
	"chromium",
	"edge",
	"firefox",
	"opera",
	"safari",
	"vivaldi",
	"whale",
] as const;

export function asVideoContainer(
	value: string | undefined,
): VideoContainer | undefined {
	const v = value?.trim().toLowerCase().replace(/^\./, "");
	return (VIDEO_CONTAINERS as readonly string[]).includes(v ?? "")
		? (v as VideoContainer)
		: undefined;
}

export function asAudioFormat(
	value: string | undefined,
): AudioFormat | undefined {
	const v = value?.trim().toLowerCase().replace(/^\./, "") ?? "";
	if (v in AUDIO_FORMAT_ALIASES) return AUDIO_FORMAT_ALIASES[v];
	return (AUDIO_FORMATS as readonly string[]).includes(v)
		? (v as AudioFormat)
		: undefined;
}

export function asCompatMode(
	value: string | undefined,
): CompatMode | undefined {
	const v = value?.trim().toLowerCase();
	return (COMPAT_MODES as readonly string[]).includes(v ?? "")
		? (v as CompatMode)
		: undefined;
}

export function isLossless(format: AudioFormat): boolean {
	return LOSSLESS_AUDIO.includes(format);
}

export function audioSupportsThumbnail(format: AudioFormat): boolean {
	return THUMBNAIL_AUDIO.includes(format);
}

export function videoSupportsThumbnail(container: VideoContainer): boolean {
	return THUMBNAIL_VIDEO.includes(container);
}

/** Accepts "1080", "1080p", "4k", "best". Returns undefined when unrecognised. */
export function parseQuality(value: string | undefined): Quality | undefined {
	const v = value?.trim().toLowerCase();
	if (!v) return undefined;
	if (v === "best" || v === "max" || v === "any") return "best";
	const k = /^(\d)k$/.exec(v);
	if (k)
		return ({ "2": 1440, "4": 2160, "8": 4320 } as Record<string, number>)[
			k[1]
		];
	const p = /^(\d{3,4})p?$/.exec(v);
	return p ? Number(p[1]) : undefined;
}
