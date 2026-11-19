import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ffmpegArchiveUrl,
	ffmpegBuild,
	hasMutagen,
	isStandaloneYtdlp,
	ytdlpAsset,
} from "../src/lib/binaries";

test("detects mutagen in yt-dlp's debug header", () => {
	assert.equal(
		hasMutagen(
			"[debug] Optional libraries: Cryptodome-3.24.1, certifi-2026.10.23, mutagen-1.48.1, requests-2.34.2",
		),
		true,
	);
	// What a pip or distro install without the module prints.
	assert.equal(
		hasMutagen(
			"[debug] Optional libraries: certifi-2026.10.18, requests-2.34.2, sqlite3-3.45.1",
		),
		false,
	);
	assert.equal(
		hasMutagen(
			"[debug] Optional libraries: sqlite3-3.45.1\n[debug] mutagen-1.0",
		),
		false,
	);
	assert.equal(hasMutagen(""), false);
});

test("picks the yt-dlp asset and knows which ones bundle their libraries", () => {
	assert.equal(ytdlpAsset("linux", "x64"), "yt-dlp_linux");
	assert.equal(ytdlpAsset("linux", "arm64"), "yt-dlp_linux_aarch64");
	assert.equal(ytdlpAsset("darwin", "arm64"), "yt-dlp_macos");
	assert.equal(ytdlpAsset("linux", "riscv64"), "yt-dlp");
	assert.equal(isStandaloneYtdlp("yt-dlp_linux"), true);
	assert.equal(isStandaloneYtdlp("yt-dlp"), false);
});

test("ffmpeg is only downloaded where a static build exists", () => {
	assert.equal(ffmpegBuild("linux", "x64"), "linux64");
	assert.equal(ffmpegBuild("linux", "arm64"), "linuxarm64");
	assert.equal(ffmpegBuild("darwin", "arm64"), undefined);
	assert.equal(ffmpegBuild("linux", "ia32"), undefined);
	assert.equal(
		ffmpegArchiveUrl("linux64"),
		"https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
	);
});
