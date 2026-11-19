import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	audioMatchFor,
	type EncodeAttempt,
	planAudioEncode,
	planEncode,
} from "../src/lib/reencode";

const runner =
	require("../assets/runner.js") as typeof import("../assets/runner.js");

// --- planning (no ffmpeg needed) -------------------------------------------

test("audio presets know which codec they produce", () => {
	assert.deepEqual(planAudioEncode("opus", [], "mp4").audioMatch, ["opus"]);
	assert.deepEqual(planAudioEncode("aac", [], "mp4").audioMatch, ["aac"]);
	assert.deepEqual(planAudioEncode("mp3", [], "mp4").audioMatch, ["mp3"]);
	assert.deepEqual(planAudioEncode("flac", [], "mp4").audioMatch, ["flac"]);
	// 24-bit PCM into 16-bit PCM is a real change, so only 16-bit matches
	assert.deepEqual(planAudioEncode("pcm", [], "mov").audioMatch, ["pcm_s16le"]);
});

test("audio arguments typed by the user always get their encode", () => {
	for (const extra of [
		["-b:a", "96k"],
		["-ar", "44100"],
		["-c:a", "aac"],
		["-af", "volume=2"],
		["-an"],
	]) {
		assert.equal(
			planAudioEncode("opus", extra, "mp4").audioMatch,
			undefined,
			extra.join(" "),
		);
		const [video] = planEncode("h264", extra).attempts;
		assert.equal(video.audioMatch, undefined, extra.join(" "));
		assert.equal(video.outputAudioCopy, undefined, extra.join(" "));
	}
	// video-only arguments leave the audio shortcut alone
	assert.deepEqual(
		planAudioEncode("opus", ["-movflags", "+faststart"], "mp4").audioMatch,
		["opus"],
	);
	assert.ok(planEncode("h264", ["-crf", "16"]).attempts[0].audioMatch);
	assert.equal(audioMatchFor(["-c:a", "something-unknown"], []), undefined);
});

test("video presets carry a variant that copies matching audio", () => {
	const [h264] = planEncode("h264", ["-crf", "16"]).attempts;
	assert.deepEqual(h264.audioMatch, ["aac"]);
	assert.ok(h264.output.join(" ").includes("-c:a aac"));
	assert.ok(h264.outputAudioCopy?.join(" ").includes("-c:a copy"));
	assert.ok(!h264.outputAudioCopy?.join(" ").includes("-b:a"));
	// everything else in the command stays identical
	assert.equal(
		h264.output.filter((a) => a === "-crf").length,
		h264.outputAudioCopy?.filter((a) => a === "-crf").length,
	);
	// an explicit audio codec replaces the preset's own
	const [withOpus] = planEncode("h264", [], undefined, [
		"-c:a",
		"libopus",
		"-b:a",
		"192k",
	]).attempts;
	assert.deepEqual(withOpus.audioMatch, ["opus"]);
	// ProRes goes with PCM
	assert.deepEqual(planEncode("prores", []).attempts[0].audioMatch, [
		"pcm_s16le",
	]);
});

// --- the runner on real files ----------------------------------------------

function has(bin: string, args: string[]): boolean {
	return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}
function encoders(): string {
	return (
		spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" })
			.stdout ?? ""
	);
}
const ready = has("ffmpeg", ["-version"]) && has("ffprobe", ["-version"]);
const list = ready ? encoders() : "";
const canOpus = list.includes("libopus");
const canX264 = list.includes("libx264");

function makeVideo(dir: string, audio: "opus" | "aac"): string {
	const file = path.join(dir, `in-${audio}.mp4`);
	const r = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=1:size=160x120:rate=25",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-c:v",
			"mpeg4",
			"-c:a",
			audio === "opus" ? "libopus" : "aac",
			file,
		],
		{ encoding: "utf8" },
	);
	assert.equal(r.status, 0, r.stderr);
	return file;
}
function audioCodec(file: string): string {
	return spawnSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			"a:0",
			"-show_entries",
			"stream=codec_name",
			"-of",
			"csv=p=0",
			file,
		],
		{ encoding: "utf8" },
	).stdout.trim();
}
async function run(file: string, attempts: EncodeAttempt[]) {
	const state = runner.createState(1, 0);
	state.files = [{ path: file, duration: null, fps: null }];
	const lines: string[] = [];
	const log = { write: (s: string) => void lines.push(s), end() {} };
	const writer = { schedule() {}, flush() {} };
	const ok = await runner.reencodeFiles(
		{ reencode: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", attempts } } as never,
		state,
		writer,
		log as never,
	);
	return { ok, state, log: lines.join("") };
}

test(
	"audio already in the target codec is left alone",
	{ skip: !(ready && canOpus) },
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-skip-"));
		const file = makeVideo(dir, "opus");
		const before = fs.readFileSync(file);

		const { ok, state, log } = await run(file, [
			planAudioEncode("opus", [], "mp4"),
		]);
		assert.equal(ok, true);
		assert.match(log, /Audio is already opus, no re-encode needed/);
		assert.doesNotMatch(log, /Re-encoding with/);
		assert.deepEqual(fs.readFileSync(file), before, "file untouched");
		assert.equal(state.files[0].path, file);
	},
);

test(
	"audio in another codec is still re-encoded",
	{ skip: !(ready && canOpus) },
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-skip-"));
		const file = makeVideo(dir, "aac");
		assert.equal(audioCodec(file), "aac");

		const { ok, log } = await run(file, [planAudioEncode("opus", [], "mp4")]);
		assert.equal(ok, true);
		assert.match(log, /Re-encoding with Opus/);
		assert.equal(audioCodec(file), "opus");
	},
);

test(
	"a user-set bitrate re-encodes even when the codec matches",
	{ skip: !(ready && canOpus) },
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-skip-"));
		const file = makeVideo(dir, "opus");
		const { log } = await run(file, [
			planAudioEncode("opus", ["-b:a", "64k"], "mp4"),
		]);
		assert.match(log, /Re-encoding with Opus/);
		assert.doesNotMatch(log, /no re-encode needed/);
	},
);

test(
	"video re-encode copies matching audio and re-encodes the rest",
	{ skip: !(ready && canX264) },
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-skip-"));
		const file = makeVideo(dir, "aac");
		const { ok, log } = await run(
			file,
			planEncode("h264", ["-crf", "30"]).attempts,
		);
		assert.equal(ok, true);
		assert.match(log, /Audio is already aac, copying it/);
		assert.match(log, /Re-encoding with H\.264/);
		assert.equal(audioCodec(file), "aac");
		const video = spawnSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=codec_name",
				"-of",
				"csv=p=0",
				file,
			],
			{ encoding: "utf8" },
		).stdout.trim();
		assert.equal(video, "h264", "the video was still re-encoded");
	},
);

test(
	"without ffprobe nothing can be skipped, so the encode runs as before",
	{ skip: !(ready && canOpus) },
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-skip-"));
		const file = makeVideo(dir, "opus");
		const state = runner.createState(1, 0);
		state.files = [{ path: file, duration: null, fps: null }];
		const lines: string[] = [];
		await runner.reencodeFiles(
			{
				reencode: {
					ffmpeg: "ffmpeg",
					ffprobe: null,
					attempts: [planAudioEncode("opus", [], "mp4")],
				},
			} as never,
			state,
			{ schedule() {}, flush() {} },
			{ write: (s: string) => void lines.push(s), end() {} } as never,
		);
		assert.match(lines.join(""), /Re-encoding with Opus/);
	},
);
