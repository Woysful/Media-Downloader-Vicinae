export const REENCODE_CODECS = [
	"h264",
	"h265",
	"av1",
	"prores",
	"dnxhr",
	"h264-nvenc",
	"h265-nvenc",
	"av1-nvenc",
	"h264-vaapi",
	"h265-vaapi",
	"av1-vaapi",
] as const;
export type ReencodeCodec = (typeof REENCODE_CODECS)[number];

export type Hardware = "nvenc" | "vaapi";

export interface CodecPreset {
	title: string;
	encoder: string;
	ext: "mp4" | "mov";
	video: readonly string[];
	audio: readonly string[];
	hardware?: Hardware;
	/** CPU codec used when the GPU encoder is missing or fails. */
	fallback?: ReencodeCodec;
}

const AAC = ["-c:a", "aac", "-b:a", "256k"] as const;
// Intermediate codecs go with uncompressed audio: DaVinci Resolve (free, Linux)
// cannot decode AAC at all.
const PCM = ["-c:a", "pcm_s16le"] as const;
// Apple players and Final Cut only accept HEVC in MP4 with the hvc1 tag.
const HVC1 = ["-tag:v", "hvc1"] as const;
const VAAPI_UPLOAD = ["-vf", "format=nv12,hwupload"] as const;

export const CODEC_PRESETS: Record<ReencodeCodec, CodecPreset> = {
	h264: {
		title: "H.264 (CPU, x264)",
		encoder: "libx264",
		ext: "mp4",
		video: [
			"-c:v",
			"libx264",
			"-preset",
			"medium",
			"-crf",
			"18",
			"-pix_fmt",
			"yuv420p",
		],
		audio: AAC,
	},
	h265: {
		title: "H.265 / HEVC (CPU, x265)",
		encoder: "libx265",
		ext: "mp4",
		video: [
			"-c:v",
			"libx265",
			"-preset",
			"medium",
			"-crf",
			"20",
			"-pix_fmt",
			"yuv420p",
			"-x265-params",
			"log-level=error",
			...HVC1,
		],
		audio: AAC,
	},
	av1: {
		title: "AV1 (CPU, SVT-AV1)",
		encoder: "libsvtav1",
		ext: "mp4",
		video: [
			"-c:v",
			"libsvtav1",
			"-preset",
			"6",
			"-crf",
			"30",
			"-pix_fmt",
			"yuv420p",
		],
		audio: AAC,
	},
	prores: {
		title: "ProRes 422 HQ (CPU, MOV)",
		encoder: "prores_ks",
		ext: "mov",
		video: [
			"-c:v",
			"prores_ks",
			"-profile:v",
			"3",
			"-vendor",
			"apl0",
			"-pix_fmt",
			"yuv422p10le",
		],
		audio: PCM,
	},
	dnxhr: {
		title: "DNxHR HQ (CPU, MOV)",
		encoder: "dnxhd",
		ext: "mov",
		video: ["-c:v", "dnxhd", "-profile:v", "dnxhr_hq", "-pix_fmt", "yuv422p"],
		audio: PCM,
	},
	"h264-nvenc": {
		title: "H.264 (NVIDIA NVENC)",
		encoder: "h264_nvenc",
		ext: "mp4",
		hardware: "nvenc",
		fallback: "h264",
		video: [
			"-c:v",
			"h264_nvenc",
			"-preset",
			"p5",
			"-tune",
			"hq",
			"-rc",
			"vbr",
			"-cq",
			"19",
			"-b:v",
			"0",
			"-pix_fmt",
			"yuv420p",
		],
		audio: AAC,
	},
	"h265-nvenc": {
		title: "H.265 / HEVC (NVIDIA NVENC)",
		encoder: "hevc_nvenc",
		ext: "mp4",
		hardware: "nvenc",
		fallback: "h265",
		video: [
			"-c:v",
			"hevc_nvenc",
			"-preset",
			"p5",
			"-tune",
			"hq",
			"-rc",
			"vbr",
			"-cq",
			"21",
			"-b:v",
			"0",
			"-pix_fmt",
			"yuv420p",
			...HVC1,
		],
		audio: AAC,
	},
	"av1-nvenc": {
		title: "AV1 (NVIDIA NVENC, RTX 40+)",
		encoder: "av1_nvenc",
		ext: "mp4",
		hardware: "nvenc",
		fallback: "av1",
		video: [
			"-c:v",
			"av1_nvenc",
			"-preset",
			"p5",
			"-tune",
			"hq",
			"-rc",
			"vbr",
			"-cq",
			"30",
			"-b:v",
			"0",
			"-pix_fmt",
			"yuv420p",
		],
		audio: AAC,
	},
	"h264-vaapi": {
		title: "H.264 (AMD/Intel VA-API)",
		encoder: "h264_vaapi",
		ext: "mp4",
		hardware: "vaapi",
		fallback: "h264",
		video: [
			...VAAPI_UPLOAD,
			"-c:v",
			"h264_vaapi",
			"-rc_mode",
			"CQP",
			"-qp",
			"20",
		],
		audio: AAC,
	},
	"h265-vaapi": {
		title: "H.265 / HEVC (AMD/Intel VA-API)",
		encoder: "hevc_vaapi",
		ext: "mp4",
		hardware: "vaapi",
		fallback: "h265",
		video: [
			...VAAPI_UPLOAD,
			"-c:v",
			"hevc_vaapi",
			"-rc_mode",
			"CQP",
			"-qp",
			"22",
			...HVC1,
		],
		audio: AAC,
	},
	"av1-vaapi": {
		title: "AV1 (AMD/Intel VA-API)",
		encoder: "av1_vaapi",
		ext: "mp4",
		hardware: "vaapi",
		fallback: "av1",
		// AV1 quantizers run 0-255, so this roughly matches the H.264/H.265 presets above.
		video: [
			...VAAPI_UPLOAD,
			"-c:v",
			"av1_vaapi",
			"-rc_mode",
			"CQP",
			"-qp",
			"110",
		],
		audio: AAC,
	},
};

const ALIASES: Record<string, ReencodeCodec> = {
	avc: "h264",
	x264: "h264",
	libx264: "h264",
	hevc: "h265",
	x265: "h265",
	libx265: "h265",
	"svt-av1": "av1",
	svtav1: "av1",
	prores_ks: "prores",
	dnxhd: "dnxhr",
	dnx: "dnxhr",
	nvenc: "h264-nvenc",
	"hevc-nvenc": "h265-nvenc",
	vaapi: "h264-vaapi",
	"hevc-vaapi": "h265-vaapi",
};

export function asReencodeCodec(
	value: string | undefined,
): ReencodeCodec | undefined {
	const v = value?.trim().toLowerCase().replace(/_/g, "-");
	if (!v) return undefined;
	if ((REENCODE_CODECS as readonly string[]).includes(v))
		return v as ReencodeCodec;
	return ALIASES[v] ?? ALIASES[v.replace(/-/g, "_")];
}

const OFF = ["off", "no", "false", "none", "original"];
const ON = ["on", "yes", "true"];

/**
 * Parses a re-encode setting from the domain config or the -e key:
 * a codec name, "on" (use the preference codec) or "off".
 */
export function parseReencode(
	value: string | undefined,
): ReencodeCodec | boolean | undefined {
	const v = value?.trim().toLowerCase();
	if (!v) return undefined;
	if (OFF.includes(v)) return false;
	if (ON.includes(v)) return true;
	return asReencodeCodec(v);
}

/** One ffmpeg invocation the runner may try; later attempts are fallbacks. */
export interface EncodeAttempt {
	codec: ReencodeCodec;
	label: string;
	input: string[];
	output: string[];
	ext: "mp4" | "mov";
}

export interface EncoderSupport {
	/** Encoders compiled into ffmpeg. */
	encoders: ReadonlySet<string>;
	/** VA-API render node, e.g. /dev/dri/renderD128. */
	vaapiDevice?: string;
}

function attemptFor(
	codec: ReencodeCodec,
	extra: readonly string[],
	vaapiDevice: string | undefined,
): EncodeAttempt {
	const preset = CODEC_PRESETS[codec];
	const input =
		preset.hardware === "vaapi"
			? ["-vaapi_device", vaapiDevice ?? "/dev/dri/renderD128"]
			: [];
	const output = [
		...preset.video,
		...preset.audio,
		"-movflags",
		"+faststart",
		...extra,
	];
	return { codec, label: preset.title, input, output, ext: preset.ext };
}

export interface EncodePlan {
	attempts: EncodeAttempt[];
	/** Set when the requested GPU encoder is unavailable and the CPU fallback is used. */
	notice?: string;
}

/**
 * Builds the attempts for a codec. With `support`, encoders missing from
 * ffmpeg (or VA-API without a render node) are skipped up front.
 */
export function planEncode(
	codec: ReencodeCodec,
	extraArgs: readonly string[],
	support?: EncoderSupport,
): EncodePlan {
	const chain: ReencodeCodec[] = [codec];
	const fallback = CODEC_PRESETS[codec].fallback;
	if (fallback) chain.push(fallback);

	const usable = (c: ReencodeCodec) => {
		if (!support) return true;
		const preset = CODEC_PRESETS[c];
		if (!support.encoders.has(preset.encoder)) return false;
		return preset.hardware !== "vaapi" || Boolean(support.vaapiDevice);
	};

	const available = chain.filter(usable);
	const attempts = available.map((c) =>
		attemptFor(c, extraArgs, support?.vaapiDevice),
	);
	const notice =
		available[0] !== codec && attempts.length
			? `${CODEC_PRESETS[codec].title} is not available, using ${attempts[0].label}`
			: undefined;
	return { attempts, notice };
}
