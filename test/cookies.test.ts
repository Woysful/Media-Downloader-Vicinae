import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	asCookieSpec,
	CookieError,
	describeCookieSpec,
	findZenProfile,
	parseCookieSpec,
	resolveCookies,
	resolveCookieSpec,
	zenRoots,
} from "../src/lib/cookies";

function makeHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "md-cookies-"));
}

/** Creates a Zen profile directory (with cookies.sqlite unless told otherwise). */
function profile(root: string, name: string, cookies = true): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	if (cookies) fs.writeFileSync(path.join(dir, "cookies.sqlite"), "");
	return dir;
}

const linux = (home: string, configHome?: string) => ({
	home,
	platform: "linux" as const,
	configHome,
});

test("parses yt-dlp's BROWSER[+KEYRING][:PROFILE][::CONTAINER] syntax", () => {
	assert.deepEqual(parseCookieSpec("Firefox"), {
		browser: "firefox",
		keyring: undefined,
		profile: undefined,
		container: undefined,
	});
	assert.deepEqual(parseCookieSpec("chrome+gnomekeyring:Profile 1"), {
		browser: "chrome",
		keyring: "gnomekeyring",
		profile: "Profile 1",
		container: undefined,
	});
	assert.deepEqual(parseCookieSpec("zen:/opt/profile::Work"), {
		browser: "zen",
		keyring: undefined,
		profile: "/opt/profile",
		container: "Work",
	});
	assert.equal(parseCookieSpec("firefox::none")?.container, "none");
	assert.equal(parseCookieSpec("netscape"), undefined);
	assert.equal(parseCookieSpec("https://a.com/v"), undefined);
	assert.equal(parseCookieSpec(undefined), undefined);
	assert.equal(asCookieSpec("ZEN : Work"), "zen:Work");
	assert.equal(asCookieSpec("none"), undefined);
	assert.equal(describeCookieSpec("zen:Work"), "Zen (Work)");
	assert.equal(describeCookieSpec("firefox"), "Firefox");
});

test("cookie choice: keys > domain rule > preferences", () => {
	assert.equal(resolveCookies(undefined, undefined, undefined), undefined);
	assert.equal(resolveCookies(undefined, undefined, "firefox"), "firefox");
	assert.equal(resolveCookies(undefined, "zen", "firefox"), "zen");
	assert.equal(resolveCookies("chrome", "zen", "firefox"), "chrome");
	// "off" wins over everything below it
	assert.equal(resolveCookies(false, "zen", "firefox"), undefined);
	assert.equal(resolveCookies(undefined, false, "firefox"), undefined);
	// a bare -c uses the rule's browser, then the preferences' one
	assert.equal(resolveCookies(true, "zen", "firefox"), "zen");
	assert.equal(resolveCookies(true, undefined, "firefox"), "firefox");
	assert.equal(resolveCookies(undefined, true, "firefox"), "firefox");
	assert.throws(
		() => resolveCookies(true, undefined, undefined),
		(e: Error) => e instanceof CookieError && /-c firefox/.test(e.message),
	);
});

test("Zen profile folders per platform and install type", () => {
	assert.deepEqual(zenRoots(linux("/h")), [
		"/h/.zen",
		"/h/.config/zen",
		"/h/.var/app/app.zen_browser.zen/.zen",
		"/h/.var/app/app.zen_browser.zen/config/zen",
	]);
	assert.equal(zenRoots(linux("/h", "/x/cfg"))[1], "/x/cfg/zen");
	assert.deepEqual(zenRoots({ home: "/Users/me", platform: "darwin" }), [
		"/Users/me/Library/Application Support/zen",
	]);
});

test("Zen: the profile Zen itself opens ([Install…]) is preferred", () => {
	const home = makeHome();
	const root = path.join(home, ".zen");
	const release = profile(root, "abc.Default (release)");
	profile(root, "def.Default (alpha)");
	fs.writeFileSync(
		path.join(root, "profiles.ini"),
		[
			"[Install4F96D1932A9F858E]",
			"Default=abc.Default (release)",
			"",
			"[Profile1]",
			"Name=Default (alpha)",
			"IsRelative=1",
			"Path=def.Default (alpha)",
			"Default=1",
			"",
			"[Profile0]",
			"Name=Default (release)",
			"IsRelative=1",
			"Path=abc.Default (release)",
		].join("\n"),
	);
	assert.equal(findZenProfile(undefined, linux(home)), release);
	assert.equal(resolveCookieSpec("zen", linux(home)), `firefox:${release}`);
});

test("Zen: falls back to Default=1, then to the newest cookies.sqlite", () => {
	const home = makeHome();
	const root = path.join(home, ".zen");
	profile(root, "a.One");
	const two = profile(root, "b.Two");
	fs.writeFileSync(
		path.join(root, "profiles.ini"),
		"[Profile0]\nName=One\nIsRelative=1\nPath=a.One\n\n[Profile1]\nName=Two\nIsRelative=1\nPath=b.Two\nDefault=1\n",
	);
	assert.equal(findZenProfile(undefined, linux(home)), two);

	// No profiles.ini at all: scan for cookies.sqlite, newest wins.
	const bare = makeHome();
	const bareRoot = path.join(bare, ".zen");
	profile(bareRoot, "old");
	const fresh = profile(bareRoot, "fresh");
	fs.utimesSync(path.join(bareRoot, "old", "cookies.sqlite"), 1, 1);
	assert.equal(findZenProfile(undefined, linux(bare)), fresh);
});

test("Zen: XDG, Flatpak and macOS locations are found", () => {
	for (const rel of [
		".config/zen",
		".var/app/app.zen_browser.zen/.zen",
		".var/app/app.zen_browser.zen/config/zen",
	]) {
		const home = makeHome();
		const dir = profile(path.join(home, rel), "x.Default");
		assert.equal(findZenProfile(undefined, linux(home)), dir, rel);
	}

	const mac = makeHome();
	const root = path.join(mac, "Library", "Application Support", "zen");
	const dir = profile(path.join(root, "Profiles"), "x.Default");
	fs.writeFileSync(
		path.join(root, "profiles.ini"),
		"[Profile0]\nName=Default\nIsRelative=1\nPath=Profiles/x.Default\nDefault=1\n",
	);
	assert.equal(
		findZenProfile(undefined, { home: mac, platform: "darwin" }),
		dir,
	);
});

test("Zen: a profile can be chosen by name, folder name or absolute path", () => {
	const home = makeHome();
	const root = path.join(home, ".zen");
	profile(root, "a.Default (release)");
	const work = profile(root, "b.Work");
	fs.writeFileSync(
		path.join(root, "profiles.ini"),
		"[Profile0]\nName=Default (release)\nIsRelative=1\nPath=a.Default (release)\nDefault=1\n\n[Profile1]\nName=Work\nIsRelative=1\nPath=b.Work\n",
	);
	assert.equal(findZenProfile("work", linux(home)), work);
	assert.equal(findZenProfile("b.Work", linux(home)), work);
	assert.equal(findZenProfile(work, linux(home)), work);
	assert.equal(
		resolveCookieSpec("zen:Work::Personal", linux(home)),
		`firefox:${work}::Personal`,
	);
	assert.throws(
		() => findZenProfile("Nope", linux(home)),
		/"Nope" not found \(found: Default \(release\), Work\)/,
	);
	assert.throws(
		() => findZenProfile("/does/not/exist", linux(home)),
		/not found: \/does\/not\/exist/,
	);
});

test("Zen: a clear error when Zen has no profile", () => {
	assert.throws(
		() => findZenProfile(undefined, linux(makeHome())),
		/Could not find a Zen profile.*-c zen:\/path\/to\/profile/,
	);
});

test("other browsers are passed to yt-dlp unchanged", () => {
	assert.equal(resolveCookieSpec("Firefox"), "firefox");
	assert.equal(resolveCookieSpec("chrome:Profile 2"), "chrome:Profile 2");
	assert.equal(resolveCookieSpec("firefox:/p/q::none"), "firefox:/p/q::none");
	assert.throws(() => resolveCookieSpec("netscape"), /Unknown browser/);
});
