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

function valueOf(args: string[], flag: string): string | undefined {
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
	assert.equal(s.compat, "prefer");
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
	assert.equal(valueOf(single, "--playlist-items"), "1");
	const p = buildPlan(req({ playlist: true }), settings, undefined, env).args;
	assert.ok(p.includes("--yes-playlist"));
	assert.ok(!p.includes("--playlist-items"));
	assert.equal(valueOf(p, "-o"), settings.playlistTemplate);
});

test("URL comes last after --", () => {
	const { args } = buildPlan(req(), settings, undefined, env);
	assert.deepEqual(args.slice(-2), ["--", "https://example.com/v"]);
	assert.equal(valueOf(args, "--ffmpeg-location"), "/usr/bin/ffmpeg");
	assert.deepEqual(valuesOf(args, "-P"), ["home:/tmp/dl", "temp:/tmp/job/tmp"]);
});

test("container is applied to merged and single-file downloads", () => {
	const { args } = buildPlan(
		req({ container: "mkv" }),
		normalizeSettings({ editingCompatibility: "original" }),
		undefined,
		env,
	);
	assert.equal(valueOf(args, "--merge-output-format"), "mkv");
	assert.equal(valueOf(args, "--remux-video"), "mkv");
	assert.equal(valueOf(args, "-S"), undefined);
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
	assert.equal(valueOf(args, "-f"), "bv[vcodec^=av01]+ba");
	assert.equal(valueOf(args, "-S"), "res:1080");
	assert.equal(valueOf(args, "--merge-output-format"), "mkv");
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
	assert.equal(valueOf(fromRule, "--remux-video"), "webm");
	assert.equal(valueOf(fromRule, "-S"), "res:720");
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
	assert.equal(valueOf(fromQuery, "--remux-video"), "mp4");
	assert.equal(valueOf(fromQuery, "-S"), undefined);
	assert.deepEqual(valuesOf(fromQuery, "--postprocessor-args"), [
		"Merger:-c:a libopus",
		"VideoRemuxer:-c:a libopus",
	]);

	const fromPrefs = buildPlan(req(), s, undefined, env).args;
	assert.equal(valueOf(fromPrefs, "--remux-video"), "mov");
	assert.equal(valueOf(fromPrefs, "-S"), "res:480");
});

test("editing compatibility: prefer sorts for H.264/AAC without changing resolution priority", () => {
	const { args, reencodeArgs } = buildPlan(
		req({ quality: 1080 }),
		settings,
		undefined,
		env,
	);
	assert.equal(valueOf(args, "-S"), "res:1080,fps,vcodec:h264,acodec:aac");
	assert.equal(reencodeArgs, null);
});

test("editing compatibility: reencode merges to mkv and returns ffmpeg args", () => {
	const plan = buildPlan(
		req({ compat: "reencode", ffmpegArgs: "-crf 20" }),
		settings,
		undefined,
		env,
	);
	assert.equal(valueOf(plan.args, "--merge-output-format"), "mkv");
	assert.equal(valueOf(plan.args, "--remux-video"), undefined);
	assert.equal(valueOf(plan.args, "--postprocessor-args"), undefined);
	assert.ok(plan.reencodeArgs?.includes("libx264"));
	assert.deepEqual(plan.reencodeArgs?.slice(-2), ["-crf", "20"]);
	assert.equal(plan.summary.container, "mp4");
});

test("audio uses a fallback selector, the rule's audio format and ExtractAudio args", () => {
	const rule = parseDomainConfig(
		`example.com: audio-format="mp3" audio-ffmpeg="-ac 1" format="mkv"`,
	).rules[0];
	const { args } = buildPlan(req({ kind: "audio" }), settings, rule, env);
	assert.equal(valueOf(args, "-f"), "ba/b");
	assert.equal(valueOf(args, "--audio-format"), "mp3");
	assert.equal(valueOf(args, "--audio-quality"), "0");
	assert.equal(valueOf(args, "--postprocessor-args"), "ExtractAudio:-ac 1");
	assert.equal(valueOf(args, "--remux-video"), undefined);

	const wav = buildPlan(
		req({ kind: "audio", container: "wav" }),
		settings,
		undefined,
		env,
	).args;
	assert.equal(valueOf(wav, "--audio-quality"), undefined);
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

test("best commands ignore container and compatibility settings", () => {
	const video = buildPlan(
		req({ kind: "video-best" }),
		settings,
		undefined,
		env,
	).args;
	assert.equal(valueOf(video, "-f"), "bv*+ba/b");
	assert.equal(valueOf(video, "--remux-video"), undefined);
	assert.equal(valueOf(video, "-S"), undefined);
	const audio = buildPlan(
		req({ kind: "audio-best" }),
		settings,
		undefined,
		env,
	).args;
	assert.equal(valueOf(audio, "--audio-format"), "wav");
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
	assert.equal(valueOf(args, "--cookies-from-browser"), "firefox");
});
