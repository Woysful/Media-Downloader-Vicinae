import assert from "node:assert/strict";
import { test } from "node:test";
import {
	describeOutcome,
	describeProgress,
	explainError,
	type JobState,
} from "../src/lib/status";

const runner =
	require("../assets/runner.js") as typeof import("../assets/runner.js");

test("runner parses start, download, postprocess and file lines", () => {
	const state = runner.createState(1, 0);
	runner.applyLine(state, "MDL|start|2|10|137+140|Title | with pipe");
	assert.equal(state.title, "Title | with pipe");
	assert.deepEqual(state.item, { index: 2, count: 10 });
	assert.equal(state.streamCount, 2);

	runner.applyLine(
		state,
		"MDL|dl|downloading|500|1000|NA|2048|7|NA|NA|avc1.4d401f|none",
	);
	assert.equal(state.status, "downloading");
	assert.equal(state.percent, 50);
	assert.equal(state.stream, "video");
	assert.equal(state.speed, 2048);

	runner.applyLine(state, "MDL|dl|downloading|NA|NA|NA|NA|NA|3|12|none|opus");
	assert.equal(state.percent, 25);
	assert.equal(state.stream, "audio");

	runner.applyLine(state, "MDL|pp|started|Merger");
	assert.equal(state.status, "processing");
	assert.equal(state.stage, "Merger");

	runner.applyLine(state, "MDL|file|12.5|29.97|/tmp/a|b.mp4");
	assert.deepEqual(state.files, [
		{ path: "/tmp/a|b.mp4", duration: 12.5, fps: 29.97 },
	]);

	runner.applyLine(state, "ERROR: [youtube] abc123: Video unavailable");
	assert.equal(state.error, "Video unavailable");
	assert.equal(runner.applyLine(state, "WARNING: something"), false);
});

test("constant frame rate snaps VFR averages to standard rates", () => {
	assert.equal(runner.snapFrameRate(29.97), "30000/1001");
	assert.equal(runner.snapFrameRate(29.87), "30000/1001");
	assert.equal(runner.snapFrameRate(59.6), "60000/1001");
	assert.equal(runner.snapFrameRate(25), "25");
	assert.equal(runner.snapFrameRate(90000), null);
	assert.equal(runner.snapFrameRate(null), null);
	assert.equal(runner.parseRate("30000/1001")?.toFixed(3), "29.970");
});

test("re-encode args force CFR, put device options before the input and user overrides last", () => {
	const args = runner.buildEncodeArgs(
		{ path: "/in.mkv", duration: 10, fps: 30 },
		{ avgFrameRate: 23.976, frameRate: 24, duration: 10 },
		{
			codec: "h264-vaapi",
			label: "H.264 (AMD/Intel VA-API)",
			input: ["-vaapi_device", "/dev/dri/renderD128"],
			output: ["-c:v", "h264_vaapi", "-r", "50"],
			ext: "mp4",
		},
		"/out.mp4",
	);
	assert.ok(args.indexOf("-vaapi_device") < args.indexOf("-i"));
	assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), [
		"-map",
		"0:V:0?",
		"-map",
		"0:a?",
	]);
	const fpsIndex = args.indexOf("-fps_mode");
	assert.deepEqual(args.slice(fpsIndex, fpsIndex + 4), [
		"-fps_mode",
		"cfr",
		"-r",
		"24000/1001",
	]);
	assert.ok(args.lastIndexOf("-r") > fpsIndex + 2, "user -r wins");
	assert.equal(args.at(-1), "/out.mp4");
});

test("progress notification text follows the job state", () => {
	const state = runner.createState(1, 0);
	assert.equal(runner.progressText(state, false), null);
	runner.applyLine(state, "MDL|start|3|5|22|Song");
	runner.applyLine(
		state,
		"MDL|dl|downloading|256|1024|NA|2097152|90|NA|NA|avc1|mp4a",
	);
	assert.deepEqual(runner.progressText(state, true), {
		title: "[3/5] Downloading 25% · 2.0 MiB/s · ETA 1:30",
		body: "Song",
		percent: 25,
	});
	assert.equal(
		runner.progressText(state, false)?.title.startsWith("Downloading"),
		true,
	);
	runner.applyLine(state, "MDL|pp|started|Merger");
	assert.deepEqual(runner.progressText(state, false), {
		title: "Merging…",
		body: "Song",
		percent: null,
	});
	state.status = "completed";
	assert.equal(runner.progressText(state, false), null);
});
test("toast text puts numbers in the title and the name in the message", () => {
	const state = runner.createState(1, 0) as JobState;
	runner.applyLine(state, "MDL|start|NA|NA|137+140|My video");
	runner.applyLine(
		state,
		"MDL|dl|downloading|512|1024|NA|1048576|65|NA|NA|avc1|none",
	);
	assert.deepEqual(describeProgress(state), {
		title: "video 50.0% · 1.0 MiB/s · ETA 1:05",
		message: "My video",
	});
});

test("playlist position is hidden for single downloads and explained at the end", () => {
	const state = runner.createState(1, 0) as JobState;
	runner.applyLine(state, "MDL|start|1|23|2|Turning");
	runner.applyLine(state, "MDL|file|10|NA|/dl/Turning.m4a");
	assert.equal(describeProgress(state, true).title, "[1/23] Downloading…");
	assert.equal(describeProgress(state, false).title, "Downloading…");
	state.status = "completed";
	assert.deepEqual(describeOutcome(state, false), {
		title: "Downloaded 1 of 23 playlist items",
		message: "Turning.m4a · add -p for all",
	});
	assert.equal(describeOutcome(state, true).title, "Download complete");
});

test("errors get actionable hints", () => {
	assert.match(
		explainError("Sign in to confirm your age", false),
		/Cookies from browser/,
	);
	assert.match(
		explainError("HTTP Error 403: Forbidden", true),
		/Update yt-dlp/,
	);
	assert.equal(explainError("Something else", false), "Something else");
});
