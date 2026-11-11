import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	DEFAULT_CONFIG_TEXT,
	ensureConfigFile,
	findRule,
	parseDomainConfig,
} from "../src/lib/domain-config";

const CONFIG = `
# comment
youtube.com, youtu.be: yt-dlp="(bv[vcodec^=avc1]/bv)+ba" format="mp4" quality=1080
music.youtube.com: audio-format='mp3'
instagram: ffmpeg="-vf scale=1280:720 -c:a aac"
https://x.com/home, twitter.com: format="mkv" compat="reencode" args="--cookies-from-browser firefox"
broken line without settings
vimeo.com: format="wmv" foo="bar"
`;

test("parses rules, keeping ':' inside values", () => {
	const { rules } = parseDomainConfig(CONFIG);
	assert.equal(rules.length, 4, "the vimeo rule only has invalid settings");
	assert.deepEqual(rules[0].domains, ["youtube.com", "youtu.be"]);
	assert.equal(rules[0].settings.selector, "(bv[vcodec^=avc1]/bv)+ba");
	assert.equal(rules[0].settings.quality, 1080);
	assert.equal(rules[2].settings.ffmpegArgs, "-vf scale=1280:720 -c:a aac");
	assert.deepEqual(rules[3].domains, ["x.com", "twitter.com"]);
	assert.equal(rules[3].settings.reencode, true, "legacy compat key");
	assert.equal(rules[3].settings.extraArgs, "--cookies-from-browser firefox");
});

test("reports problems with line numbers instead of silently ignoring them", () => {
	const { warnings } = parseDomainConfig(CONFIG);
	assert.ok(warnings.some((w) => w.startsWith("Line 7:")));
	assert.ok(warnings.some((w) => /Line 8: unknown format "wmv"/.test(w)));
	assert.ok(warnings.some((w) => /Line 8: unknown key "foo"/.test(w)));
});

test("reencode accepts on/off and codec names", () => {
	const { rules, warnings } = parseDomainConfig(
		[
			'a.com: reencode="on"',
			'b.com: reencode="off"',
			'c.com: reencode="ProRes"',
			'd.com: reencode="hevc_nvenc"',
			'e.com: reencode="h266"',
		].join("\n"),
	);
	assert.deepEqual(
		rules.map((r) => r.settings.reencode),
		[true, false, "prores", "h265-nvenc"],
	);
	assert.ok(warnings.some((w) => /Line 5: invalid reencode "h266"/.test(w)));
});

test("audio-reencode accepts on/off and audio codec names", () => {
	const { rules, warnings } = parseDomainConfig(
		[
			'a.com: audio-reencode="on"',
			'b.com: audio-reencode="off"',
			'c.com: audio-reencode="Opus"',
			'd.com: audio-reencode="pcm_s16le"',
			'e.com: audio-reencode="vorbis"',
		].join("\n"),
	);
	assert.deepEqual(
		rules.map((r) => r.settings.audioReencode),
		[true, false, "opus", "pcm"],
	);
	assert.ok(
		warnings.some((w) => /Line 5: invalid audio-reencode "vorbis"/.test(w)),
	);
});

test("matches subdomains and prefers the most specific rule", () => {
	const { rules } = parseDomainConfig(CONFIG);
	assert.equal(findRule(rules, "https://www.youtube.com/watch?v=1")?.line, 3);
	assert.equal(findRule(rules, "https://m.youtube.com/watch?v=1")?.line, 3);
	assert.equal(findRule(rules, "https://music.youtube.com/watch?v=1")?.line, 4);
	assert.equal(findRule(rules, "https://youtu.be/1")?.line, 3);
	assert.equal(findRule(rules, "https://www.instagram.com/p/1")?.line, 5);
	assert.equal(findRule(rules, "https://x.com/user/status/1")?.line, 6);
	assert.equal(findRule(rules, "https://notyoutube.com/")?.line, undefined);
	assert.equal(findRule(rules, "https://example.org/"), undefined);
});

test("default config has only commented examples and parses cleanly", () => {
	const { rules, warnings } = parseDomainConfig(DEFAULT_CONFIG_TEXT);
	assert.equal(rules.length, 0);
	assert.deepEqual(warnings, []);
	const uncommented = DEFAULT_CONFIG_TEXT.split("\n")
		.filter((l) => /^# \S+\.\S+.*: /.test(l))
		.map((l) => l.slice(2))
		.join("\n");
	const examples = parseDomainConfig(uncommented);
	assert.deepEqual(examples.warnings, []);
	assert.equal(examples.rules.length, 7);
});

test("creates the config file once, including missing directories", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-config-"));
	const file = path.join(dir, "nested", "domain-config.txt");
	assert.equal(ensureConfigFile(file), true);
	fs.writeFileSync(file, "custom");
	assert.equal(ensureConfigFile(file), false);
	assert.equal(fs.readFileSync(file, "utf8"), "custom");
	fs.rmSync(dir, { recursive: true });
});
