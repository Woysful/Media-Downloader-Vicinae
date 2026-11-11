import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AudioFormat,
	asAudioFormat,
	asVideoContainer,
	parseQuality,
	type Quality,
	type VideoContainer,
} from "./constants";
import { configHome } from "./paths";
import {
	type AudioReencodeCodec,
	parseAudioReencode,
	parseReencode,
	type ReencodeCodec,
} from "./reencode";

export const CONFIG_FILE_NAME = "domain-config.txt";

export interface RuleSettings {
	selector?: string;
	container?: VideoContainer;
	ffmpegArgs?: string;
	audioFormat?: AudioFormat;
	audioFfmpegArgs?: string;
	quality?: Quality;
	extraArgs?: string;
	/** true: re-encode with the preference codec; false: never re-encode. */
	reencode?: ReencodeCodec | boolean;
	/** true: use the preference audio codec; false: keep the original audio. */
	audioReencode?: AudioReencodeCodec | boolean;
}

export interface DomainRule {
	domains: string[];
	line: number;
	settings: RuleSettings;
}

export interface DomainConfig {
	path: string;
	rules: DomainRule[];
	warnings: string[];
}

export const DEFAULT_CONFIG_TEXT = `# Media Downloader - per-domain settings
#
# Format (one rule per line, all keys optional):
#   domain1, domain2: key="value" key='value' ...
#
# Keys:
#   yt-dlp        yt-dlp format selector for video, e.g. "bv*[height<=1080]+ba/b"
#   format        video container: mp4, mkv, webm, mov, avi, flv
#   quality       maximum video height: 2160, 1440, 1080, 720, ... or best
#   ffmpeg        extra ffmpeg arguments used when merging/remuxing video
#   reencode      re-encode for video editors: on, off or a codec (h264, h265, av1,
#                 prores, dnxhr, h264-nvenc, h265-nvenc, av1-nvenc, h264-vaapi,
#                 h265-vaapi, av1-vaapi). "on" uses the codec from the preferences
#   audio-reencode  re-encode the audio track of a video: on, off or a codec
#                 (aac, opus, mp3, flac, pcm)
#   audio-format  audio format for the Audio command: m4a, mp3, opus, ogg, flac, wav
#   audio-ffmpeg  extra ffmpeg arguments used when extracting audio
#   args          any extra yt-dlp arguments, e.g. "--cookies-from-browser firefox"
#
# A domain also matches its subdomains: "youtube.com" covers music.youtube.com.
# Values typed after the URL (-f, -q, -yt, -ff, ...) override these rules, and
# these rules override the extension preferences.
#
# Examples (remove the leading "#" to enable):
# youtube.com, youtu.be: quality="1080" format="mp4"
# instagram.com: reencode="on"
# twitch.tv: reencode="prores"
# tiktok.com: audio-reencode="aac"
# twitter.com, x.com: format="mp4"
# vimeo.com: yt-dlp="bv*+ba/b" args="--cookies-from-browser firefox"
# soundcloud.com: audio-format="mp3"
`;

const KEY_MAP: Record<string, keyof RuleSettings> = {
	"yt-dlp": "selector",
	format: "container",
	ffmpeg: "ffmpegArgs",
	"audio-format": "audioFormat",
	"audio-ffmpeg": "audioFfmpegArgs",
	quality: "quality",
	args: "extraArgs",
	reencode: "reencode",
	"audio-reencode": "audioReencode",
	// Pre-2.0 name of the setting.
	compat: "reencode",
};

export function configFilePath(customDir?: string): string {
	return customDir
		? path.join(customDir, CONFIG_FILE_NAME)
		: path.join(configHome(), "media-downloader", CONFIG_FILE_NAME);
}

/** Creates the config file with documentation if it doesn't exist yet. */
export function ensureConfigFile(file: string): boolean {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	try {
		fs.writeFileSync(file, DEFAULT_CONFIG_TEXT, {
			encoding: "utf8",
			flag: "wx",
		});
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

export function loadDomainConfig(
	customDir?: string,
): DomainConfig & { created: boolean } {
	const file = configFilePath(customDir);
	const created = ensureConfigFile(file);
	const parsed = parseDomainConfig(fs.readFileSync(file, "utf8"));
	return { path: file, created, ...parsed };
}

export function normalizeDomain(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
		.replace(/[/?#].*$/, "")
		.replace(/:\d+$/, "")
		.replace(/^\*\./, "")
		.replace(/^www\./, "")
		.replace(/\.$/, "");
}

interface ParamsResult {
	values: Record<string, string>;
	error?: string;
}

function parseParams(text: string): ParamsResult {
	const values: Record<string, string> = {};
	let i = 0;

	while (i < text.length) {
		while (i < text.length && /\s/.test(text[i])) i++;
		if (i >= text.length) break;

		const keyMatch = /^[\w-]+/.exec(text.slice(i));
		if (!keyMatch)
			return { values, error: `unexpected "${text.slice(i, i + 10)}"` };
		const key = keyMatch[0];
		i += key.length;
		while (i < text.length && text[i] === " ") i++;
		if (text[i] !== "=") return { values, error: `missing "=" after ${key}` };
		i++;
		while (i < text.length && text[i] === " ") i++;

		const quote = text[i];
		let value = "";
		if (quote === '"' || quote === "'") {
			i++;
			let closed = false;
			while (i < text.length) {
				const ch = text[i];
				if (ch === quote) {
					closed = true;
					i++;
					break;
				}
				if (
					quote === '"' &&
					ch === "\\" &&
					(text[i + 1] === '"' || text[i + 1] === "\\")
				) {
					value += text[i + 1];
					i += 2;
					continue;
				}
				value += ch;
				i++;
			}
			if (!closed) return { values, error: `unclosed quote in ${key}` };
		} else {
			const m = /^\S*/.exec(text.slice(i));
			value = m ? m[0] : "";
			i += value.length;
		}
		values[key.toLowerCase()] = value;
	}

	return { values };
}

function applySetting(
	settings: RuleSettings,
	key: keyof RuleSettings,
	value: string,
): string | undefined {
	switch (key) {
		case "container": {
			const container = asVideoContainer(value);
			if (!container) return `unknown format "${value}"`;
			settings.container = container;
			return;
		}
		case "audioFormat": {
			const format = asAudioFormat(value);
			if (!format) return `unknown audio-format "${value}"`;
			settings.audioFormat = format;
			return;
		}
		case "quality": {
			const quality = parseQuality(value);
			if (quality === undefined) return `invalid quality "${value}"`;
			settings.quality = quality;
			return;
		}
		case "reencode": {
			const v = value.trim().toLowerCase();
			const reencode =
				v === "reencode" ? true : v === "prefer" ? false : parseReencode(v);
			if (reencode === undefined)
				return `invalid reencode "${value}" (on, off or a codec such as h264, prores, h264-nvenc)`;
			settings.reencode = reencode;
			return;
		}
		case "audioReencode": {
			const v = value.trim().toLowerCase();
			const audio =
				v === "reencode"
					? true
					: v === "prefer"
						? false
						: parseAudioReencode(v);
			if (audio === undefined)
				return `invalid audio-reencode "${value}" (on, off or a codec such as aac, opus, mp3, flac, pcm)`;
			settings.audioReencode = audio;
			return;
		}
		default:
			if (value.trim()) settings[key] = value.trim();
			return;
	}
}

export function parseDomainConfig(text: string): {
	rules: DomainRule[];
	warnings: string[];
} {
	const rules: DomainRule[] = [];
	const warnings: string[] = [];

	text.split(/\r?\n/).forEach((rawLine, index) => {
		const lineNo = index + 1;
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) return;

		// The first ":" that is followed by a key="..." pair separates domains from
		// settings, so "https://x.com: ..." and values containing ":" both work.
		const match = /^(.*?):\s*([\w-]+\s*=.*)$/.exec(line);
		if (!match) {
			warnings.push(`Line ${lineNo}: expected "domain: key=\\"value\\""`);
			return;
		}

		const domains = [
			...new Set(match[1].split(",").map(normalizeDomain).filter(Boolean)),
		];
		if (!domains.length) {
			warnings.push(`Line ${lineNo}: no domain before ":"`);
			return;
		}

		const { values, error } = parseParams(match[2]);
		if (error) warnings.push(`Line ${lineNo}: ${error}`);

		const settings: RuleSettings = {};
		for (const [key, value] of Object.entries(values)) {
			const target = KEY_MAP[key];
			if (!target) {
				warnings.push(`Line ${lineNo}: unknown key "${key}"`);
				continue;
			}
			const problem = applySetting(settings, target, value);
			if (problem) warnings.push(`Line ${lineNo}: ${problem}`);
		}

		if (Object.keys(settings).length)
			rules.push({ domains, line: lineNo, settings });
	});

	return { rules, warnings };
}

function matchScore(host: string, domain: string): number {
	if (domain.includes(".")) {
		if (host === domain) return 10_000 + domain.length;
		if (host.endsWith(`.${domain}`)) return 1_000 + domain.length;
		return 0;
	}
	// Legacy single-label entries such as "instagram" match any label of the host.
	return host.split(".").includes(domain) ? 1 : 0;
}

/** Most specific match wins; on a tie the rule written later in the file wins. */
export function findRule(
	rules: readonly DomainRule[],
	url: string,
): DomainRule | undefined {
	let host: string;
	try {
		host = normalizeDomain(new URL(url).hostname);
	} catch {
		return undefined;
	}

	let best: DomainRule | undefined;
	let bestScore = 0;
	for (const rule of rules) {
		for (const domain of rule.domains) {
			const score = matchScore(host, domain);
			if (score > 0 && score >= bestScore) {
				best = rule;
				bestScore = score;
			}
		}
	}
	return best;
}
