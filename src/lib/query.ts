import { parseQuality, type Quality } from "./constants";
import {
	type AudioReencodeCodec,
	parseAudioReencode,
	parseReencode,
	type ReencodeCodec,
} from "./reencode";
import { ShellWordsError, splitShellWords } from "./shell-words";

export type QueryKey =
	| "container"
	| "quality"
	| "selector"
	| "ffmpeg"
	| "args"
	| "playlist"
	| "reencode"
	| "audioReencode";

interface KeyDef {
	names: readonly string[];
	key: QueryKey;
	takesValue: boolean | "optional";
}

const KEYS: readonly KeyDef[] = [
	{ names: ["-f", "--format"], key: "container", takesValue: true },
	{ names: ["-q", "--quality"], key: "quality", takesValue: true },
	{ names: ["-yt", "--yt-dlp"], key: "selector", takesValue: true },
	{ names: ["-ff", "--ffmpeg"], key: "ffmpeg", takesValue: true },
	{ names: ["-a", "--args"], key: "args", takesValue: true },
	{ names: ["-p", "--playlist"], key: "playlist", takesValue: false },
	{
		names: ["-e", "--edit", "--reencode"],
		key: "reencode",
		takesValue: "optional",
	},
	{
		names: ["-ea", "--audio-encode", "--audio-reencode"],
		key: "audioReencode",
		takesValue: "optional",
	},
];

export const ALL_KEYS: readonly QueryKey[] = KEYS.map((k) => k.key);

export interface ParsedQuery {
	url: string;
	container?: string;
	quality?: Quality;
	selector?: string;
	ffmpegArgs?: string;
	extraArgs?: string[];
	playlist: boolean;
	/** true: re-encode with the configured codec; false: "-e off". */
	reencode?: ReencodeCodec | boolean;
	/** true: re-encode audio with the configured codec; false: "-ea off". */
	audioReencode?: AudioReencodeCodec | boolean;
}

export class QueryError extends Error {}

export function keyName(key: QueryKey): string {
	return KEYS.find((k) => k.key === key)?.names[0] ?? key;
}

/** Validates a URL typed by the user, adding https:// when the scheme is missing. */
export function normalizeUrl(raw: string): string {
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
		? raw
		: `https://${raw}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new QueryError(`"${raw}" is not a valid URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new QueryError(`Unsupported URL scheme "${url.protocol}"`);
	}
	if (!url.hostname.includes(".") && url.hostname !== "localhost") {
		throw new QueryError(`"${raw}" is not a valid URL`);
	}
	return candidate;
}

/**
 * Parses "URL [keys]" as typed into a command argument. The URL may appear
 * anywhere; keys accept both "-f mp4" and "--format=mp4" forms.
 */
export function parseQuery(
	input: string,
	allowed: readonly QueryKey[] = ALL_KEYS,
): ParsedQuery {
	let words: string[];
	try {
		words = splitShellWords(input);
	} catch (error) {
		throw new QueryError(
			error instanceof ShellWordsError ? error.message : String(error),
		);
	}

	const result: ParsedQuery = { url: "", playlist: false };
	let url: string | undefined;

	for (let i = 0; i < words.length; i++) {
		const word = words[i];

		if (!word.startsWith("-") || word === "-") {
			if (url !== undefined) {
				throw new QueryError(
					`Unexpected "${word}". Wrap values that contain spaces in quotes, e.g. -ff '-c:v libx264 -crf 20'`,
				);
			}
			url = word;
			continue;
		}

		const eq = word.indexOf("=");
		const name = word.startsWith("--") && eq > 0 ? word.slice(0, eq) : word;
		const inline =
			word.startsWith("--") && eq > 0 ? word.slice(eq + 1) : undefined;
		const def = KEYS.find((k) => k.names.includes(name));

		if (!def) throw new QueryError(`Unknown key "${name}"`);
		if (!allowed.includes(def.key))
			throw new QueryError(`"${name}" is not supported by this command`);

		let value: string | undefined;
		if (def.takesValue === "optional") {
			// "-e prores" takes the next word only when it names a codec, so
			// "-e https://..." still treats the URL as the URL.
			const parse =
				def.key === "audioReencode" ? parseAudioReencode : parseReencode;
			if (inline !== undefined) value = inline;
			else if (parse(words[i + 1]) !== undefined) value = words[++i];
		} else if (def.takesValue) {
			value = inline ?? words[++i];
			if (value === undefined || value === "")
				throw new QueryError(`"${name}" needs a value`);
		} else if (inline !== undefined) {
			throw new QueryError(`"${name}" does not take a value`);
		}

		switch (def.key) {
			case "container":
				result.container = value;
				break;
			case "quality": {
				const quality = parseQuality(value);
				if (quality === undefined)
					throw new QueryError(
						`Invalid quality "${value}" (use e.g. 1080, 720p, 4k or best)`,
					);
				result.quality = quality;
				break;
			}
			case "selector":
				result.selector = value;
				break;
			case "ffmpeg":
				result.ffmpegArgs = value;
				break;
			case "args":
				try {
					result.extraArgs = [
						...(result.extraArgs ?? []),
						...splitShellWords(value ?? ""),
					];
				} catch (error) {
					throw new QueryError(
						`${name}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				break;
			case "playlist":
				result.playlist = true;
				break;
			case "reencode": {
				if (value === undefined) {
					result.reencode = true;
					break;
				}
				const reencode = parseReencode(value);
				if (reencode === undefined)
					throw new QueryError(
						`Unknown codec "${value}" (use e.g. h264, h265, av1, prores, dnxhr, h264-nvenc, h264-vaapi or off)`,
					);
				result.reencode = reencode;
				break;
			}
			case "audioReencode": {
				if (value === undefined) {
					result.audioReencode = true;
					break;
				}
				const audioReencode = parseAudioReencode(value);
				if (audioReencode === undefined)
					throw new QueryError(
						`Unknown audio codec "${value}" (use e.g. aac, opus, mp3, flac, pcm or off)`,
					);
				result.audioReencode = audioReencode;
				break;
			}
		}
	}

	if (!url) throw new QueryError("No URL provided");
	result.url = normalizeUrl(url);
	return result;
}
