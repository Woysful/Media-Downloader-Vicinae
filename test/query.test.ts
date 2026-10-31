import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuery, QueryError } from "../src/lib/query";
import { splitShellWords } from "../src/lib/shell-words";

test("splits shell words with both quote styles", () => {
	assert.deepEqual(splitShellWords(`a 'b c' "d \\"e\\"" f\\ g`), [
		"a",
		"b c",
		'd "e"',
		"f g",
	]);
	assert.deepEqual(splitShellWords(`-ff '-c:v libx265 -c:a aac'`), [
		"-ff",
		"-c:v libx265 -c:a aac",
	]);
	assert.throws(() => splitShellWords(`'oops`));
});

test("parses the README example", () => {
	const q = parseQuery(
		`https://youtube.com/watch?v=x -f mp4 -q 1080 -yt bv+ba/best -ff '-c:v libx265'`,
	);
	assert.equal(q.url, "https://youtube.com/watch?v=x");
	assert.equal(q.container, "mp4");
	assert.equal(q.quality, 1080);
	assert.equal(q.selector, "bv+ba/best");
	assert.equal(q.ffmpegArgs, "-c:v libx265");
	assert.equal(q.playlist, false);
});

test("keeps URLs with & and list= intact and does not enable playlists", () => {
	const q = parseQuery(
		"https://www.youtube.com/watch?v=abc&list=PL123&index=2",
	);
	assert.equal(q.url, "https://www.youtube.com/watch?v=abc&list=PL123&index=2");
	assert.equal(q.playlist, false);
});

test("supports flags, long forms and URL in any position", () => {
	const q = parseQuery("-p --quality=4k youtu.be/abc -e -a '--limit-rate 1M'");
	assert.equal(q.url, "https://youtu.be/abc");
	assert.equal(q.playlist, true);
	assert.equal(q.reencode, true);
	assert.equal(q.quality, 2160);
	assert.deepEqual(q.extraArgs, ["--limit-rate", "1M"]);
});

test("rejects bad input with readable errors", () => {
	assert.throws(() => parseQuery("-f mp4"), QueryError);
	assert.throws(() => parseQuery("https://a.com -x"), /Unknown key/);
	assert.throws(() => parseQuery("https://a.com -q"), /needs a value/);
	assert.throws(() => parseQuery("https://a.com -q huge"), /Invalid quality/);
	assert.throws(() => parseQuery("https://a.com -ff -c:v copy"), /Wrap values/);
	assert.throws(
		() => parseQuery("https://a.com -q 720", ["playlist"]),
		/not supported/,
	);
	assert.throws(() => parseQuery("ftp://a.com/file"), /Unsupported URL scheme/);
	assert.throws(() => parseQuery("notaurl"), /not a valid URL/);
});
