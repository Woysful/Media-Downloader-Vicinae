import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDomainConfig } from "../src/lib/domain-config";
import { buildPlan, type DownloadRequest } from "../src/lib/plan";
import { normalizeSettings } from "../src/lib/settings";

const settings = normalizeSettings({ downloadDirectory: "/tmp/dl" });
const env = { tempDir: "/tmp/job/tmp", ffmpegPath: "/usr/bin/ffmpeg" };
const req = (over: Partial<DownloadRequest> = {}): DownloadRequest => ({
	kind: "video",
	url: "https://example.com/v",
	playlist: false,
	...over,
});

function argValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i === -1 ? undefined : args[i + 1];
}

function valuesOf(args: string[], flag: string): string[] {
	return args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
}

test("settings fall back to sane defaults for null/unknown preference values", () => {
	const s = normalizeSettings({
		defaultVideoFormat: null,
		defaultAudioFormat: "ogg",
		cookiesFromBrowser: "none",
	});
	assert.equal(s.videoContainer, "mp4");
	assert.equal(s.audioFormat, "vorbis");
	assert.equal(s.cookiesFromBrowser, undefined);
	assert.equal(s.reencodeCodec, "h264");
	assert.equal(s.reencodeAlways, false);
	assert.equal(
		normalizeSettings({ reencodeCodec: "bogus" }).reencodeCodec,
		"h264",
	);
	assert.equal(
		normalizeSettings({ downloadDirectory: "~/Videos" }).downloadDir.endsWith(
			"/Videos",
		),
		true,
	);
});

test("single videos never pull a whole playlist; -p does", () => {
	const single = buildPlan(req(), settings, undefined, env).args;
	assert.ok(single.includes("--no-playlist"));
	assert.equal(argValue(single, "--playlist-items"), "1");
	const p = buildPlan(req({ playlist: true }), settings, undefined, env).args;
	assert.ok(p.includes("--yes-playlist"));
	assert.ok(!p.includes("--playlist-items"));
	assert.equal(argValue(p, "-o"), settings.playlistTemplate);
});

test("URL comes last after --", () => {
	const { args } = buildPlan(req(), settings, undefined, env);
	assert.deepEqual(args.slice(-2), ["--", "https://example.com/v"]);
	assert.equal(argValue(args, "--ffmpeg-location"), "/usr/bin/ffmpeg");
	assert.deepEqual(valuesOf(args, "-P"), ["home:/tmp/dl", "temp:/tmp/job/tmp"]);
});

test("container is applied to merged and single-file downloads", () => {
	const { args } = buildPlan(
		req({ container: "mkv" }),
		normalizeSettings({ editingCompatibility: "original" }),
		undefined,
		env,
	);
	assert.equal(argValue(args, "--merge-output-format"), "mkv");
	assert.equal(argValue(args, "--remux-video"), "mkv");
	assert.equal(argValue(args, "-S"), undefined);
});

test("quality keeps the selector and only adds a sort preference", () => {
	const rule = parseDomainConfig(
		`youtube.com: yt-dlp="bv[vcodec^=av01]+ba" format="mkv"`,
	).rules[0];
	const { args } = buildPlan(
		req({ url: "https://youtube.com/watch?v=1", quality: 1080 }),
		normalizeSettings({ editingCompatibility: "original" }),
		rule,
		env,
	);
	assert.equal(argValue(args, "-f"), "bv[vcodec^=av01]+ba");
	assert.equal(argValue(args, "-S"), "res:1080");
	assert.equal(argValue(args, "--merge-output-format"), "mkv");
});

test("precedence: query > domain rule > preferences", () => {
	const rule = parseDomainConfig(
		`example.com: format="webm" quality="720" ffmpeg="-c:a aac"`,
	).rules[0];
	const s = normalizeSettings({
		defaultVideoFormat: "mov",
		defaultQuality: "480",
		editingCompatibility: "original",
	});
	const fromRule = buildPlan(req(), s, rule, env).args;
	assert.equal(argValue(fromRule, "--remux-video"), "webm");
	assert.equal(argValue(fromRule, "-S"), "res:720");
	assert.deepEqual(valuesOf(fromRule, "--postprocessor-args"), [
		"Merger:-c:a aac",
		"VideoRemuxer:-c:a aac",
	]);

	const fromQuery = buildPlan(
		req({ container: "mp4", quality: "best", ffmpegArgs: "-c:a libopus" }),
		s,
		rule,
		env,
	).args;
	assert.equal(argValue(fromQuery, "--remux-video"), "mp4");
	assert.equal(argValue(fromQuery, "-S"), undefined);
	assert.deepEqual(valuesOf(fromQuery, "--postprocessor-args"), [
		"Merger:-c:a libopus",
		"VideoRemuxer:-c:a libopus",
	]);

	const fromPrefs = buildPlan(req(), s, undefined, env).args;
	assert.equal(argValue(fromPrefs, "--remux-video"), "mov");
	assert.equal(argValue(fromPrefs, "-S"), "res:480");
});

test("no re-encode by default: the container comes from the settings", () => {
	const plan = buildPlan(req({ quality: 1080 }), settings, undefined, env);
	assert.equal(argValue(plan.args, "-S"), "res:1080");
	assert.equal(argValue(plan.args, "--remux-video"), "mp4");
	assert.equal(plan.encode, null);
	assert.equal(plan.summary.reencode, null);
});

test("-e re-encodes with the preference codec, merging to mkv first", () => {
	const plan = buildPlan(
		req({ reencode: true, ffmpegArgs: "-crf 20" }),
		normalizeSettings({ reencodeExtraArguments: "-preset slow" }),
		undefined,
		env,
	);
	assert.equal(argValue(plan.args, "--merge-output-format"), "mkv");
	assert.equal(argValue(plan.args, "--remux-video"), undefined);
	assert.equal(argValue(plan.args, "--postprocessor-args"), undefined);
	assert.equal(plan.encode?.length, 1);
	const [attempt] = plan.encode ?? [];
	assert.equal(attempt.codec, "h264");
	assert.equal(attempt.ext, "mp4");
	assert.equal(argValue(attempt.output, "-c:v"), "libx264");
	assert.deepEqual(attempt.output.slice(-4), ["-preset", "slow", "-crf", "20"]);
	assert.equal(plan.summary.container, "mp4");
});

test("codec precedence: query codec > rule codec > preference codec; -e off wins over rules", () => {
	const rule = parseDomainConfig(`example.com: reencode="prores"`).rules[0];
	const fromRule = buildPlan(req(), settings, rule, env);
	assert.equal(fromRule.encode?.[0].codec, "prores");
	assert.equal(fromRule.encode?.[0].ext, "mov");
	assert.equal(
		argValue(fromRule.encode?.[0].output ?? [], "-c:a"),
		"pcm_s16le",
	);
	assert.equal(
		buildPlan(req({ reencode: true }), settings, rule, env).encode?.[0].codec,
		"prores",
	);
	assert.equal(
		buildPlan(req({ reencode: "dnxhr" }), settings, rule, env).encode?.[0]
			.codec,
		"dnxhr",
	);
	assert.equal(
		buildPlan(req({ reencode: false }), settings, rule, env).encode,
		null,
	);

	const always = normalizeSettings({
		reencodeAlways: true,
		reencodeCodec: "av1",
	});
	assert.equal(
		buildPlan(req(), always, undefined, env).encode?.[0].codec,
		"av1",
	);
	const off = parseDomainConfig(`example.com: reencode="off"`).rules[0];
	assert.equal(buildPlan(req(), always, off, env).encode, null);
});

test("GPU codecs fall back to the CPU encoder", () => {
	const all = buildPlan(
		req({ reencode: "h265-nvenc" }),
		settings,
		undefined,
		env,
	).encode;
	assert.deepEqual(
		all?.map((a) => a.codec),
		["h265-nvenc", "h265"],
	);

	const noNvenc = {
		...env,
		encoders: { encoders: new Set(["libx264", "libx265", "h264_vaapi"]) },
	};
	const plan = buildPlan(
		req({ reencode: "h265-nvenc" }),
		settings,
		undefined,
		noNvenc,
	);
	assert.deepEqual(
		plan.encode?.map((a) => a.codec),
		["h265"],
	);
	assert.match(plan.summary.reencode?.notice ?? "", /not available/);

	const vaapi = buildPlan(
		req({ reencode: "h264-vaapi" }),
		settings,
		undefined,
		{
			...env,
			encoders: {
				encoders: new Set(["libx264", "h264_vaapi"]),
				vaapiDevice: "/dev/dri/renderD129",
			},
		},
	).encode;
	assert.deepEqual(vaapi?.[0].input, ["-vaapi_device", "/dev/dri/renderD129"]);
	assert.deepEqual(
		vaapi?.map((a) => a.codec),
		["h264-vaapi", "h264"],
	);

	assert.throws(
		() => buildPlan(req({ reencode: "av1" }), settings, undefined, noNvenc),
		/no libsvtav1 encoder/,
	);
});
test("audio uses a fallback selector, the rule's audio format and ExtractAudio args", () => {
	const rule = parseDomainConfig(
		`example.com: audio-format="mp3" audio-ffmpeg="-ac 1" format="mkv"`,
	).rules[0];
	const { args } = buildPlan(req({ kind: "audio" }), settings, rule, env);
	assert.equal(argValue(args, "-f"), "ba/b");
	assert.equal(argValue(args, "--audio-format"), "mp3");
	assert.equal(argValue(args, "--audio-quality"), "0");
	assert.equal(argValue(args, "--postprocessor-args"), "ExtractAudio:-ac 1");
	assert.equal(argValue(args, "--remux-video"), undefined);

	const wav = buildPlan(
		req({ kind: "audio", container: "wav" }),
		settings,
		undefined,
		env,
	).args;
	assert.equal(argValue(wav, "--audio-quality"), undefined);
	assert.throws(
		() =>
			buildPlan(
				req({ kind: "audio", container: "mkv" }),
				settings,
				undefined,
				env,
			),
		/Unknown audio format/,
	);
});

test("best commands ignore container and re-encode settings", () => {
	const video = buildPlan(
		req({ kind: "video-best", reencode: true }),
		settings,
		undefined,
		env,
	).args;
	assert.equal(argValue(video, "-f"), "bv*+ba/b");
	assert.equal(argValue(video, "--remux-video"), undefined);
	assert.equal(argValue(video, "-S"), undefined);
	const audio = buildPlan(
		req({ kind: "audio-best" }),
		settings,
		undefined,
		env,
	).args;
	assert.equal(argValue(audio, "--audio-format"), "wav");
});

test("extra arguments from preferences, rule and query are appended in that order", () => {
	const rule = parseDomainConfig(`example.com: args="--rule-arg"`).rules[0];
	const s = normalizeSettings({
		extraArguments: "--pref-arg 'a b'",
		cookiesFromBrowser: "firefox",
	});
	const { args } = buildPlan(req({ extraArgs: ["--query-arg"] }), s, rule, env);
	assert.deepEqual(args.slice(-6), [
		"--pref-arg",
		"a b",
		"--rule-arg",
		"--query-arg",
		"--",
		"https://example.com/v",
	]);
	assert.equal(argValue(args, "--cookies-from-browser"), "firefox");
});
