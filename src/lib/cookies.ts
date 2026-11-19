import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	COOKIE_BROWSER_TITLES,
	COOKIE_BROWSERS,
	type CookieBrowser,
} from "./constants";
import { expandHome } from "./paths";

export class CookieError extends Error {}

export interface CookieSpec {
	browser: CookieBrowser;
	keyring?: string;
	profile?: string;
	container?: string;
}

/**
 * Parses yt-dlp's `BROWSER[+KEYRING][:PROFILE][::CONTAINER]` syntax.
 * Returns undefined when the browser is not one we know.
 */
export function parseCookieSpec(
	raw: string | undefined,
): CookieSpec | undefined {
	const text = raw?.trim();
	if (!text) return undefined;

	let main = text;
	let container: string | undefined;
	const containerAt = text.indexOf("::");
	if (containerAt >= 0) {
		main = text.slice(0, containerAt);
		container = text.slice(containerAt + 2).trim() || undefined;
	}

	const match = /^([^+:]+?)\s*(?:\+\s*([^:]+?))?\s*(?::\s*(.+))?$/.exec(main);
	if (!match) return undefined;

	const browser = match[1].trim().toLowerCase();
	if (!(COOKIE_BROWSERS as readonly string[]).includes(browser))
		return undefined;
	return {
		browser: browser as CookieBrowser,
		keyring: match[2]?.trim() || undefined,
		profile: match[3]?.trim() || undefined,
		container,
	};
}

export function formatCookieSpec(spec: CookieSpec): string {
	return (
		spec.browser +
		(spec.keyring ? `+${spec.keyring}` : "") +
		(spec.profile ? `:${spec.profile}` : "") +
		(spec.container ? `::${spec.container}` : "")
	);
}

/** Canonical form of a user-typed value, or undefined when it is not a known browser. */
export function asCookieSpec(value: string | undefined): string | undefined {
	const spec = parseCookieSpec(value);
	return spec ? formatCookieSpec(spec) : undefined;
}

/** "zen:Work" -> "Zen (Work)" for status lines. */
export function describeCookieSpec(value: string): string {
	const spec = parseCookieSpec(value);
	if (!spec) return value;
	const title = COOKIE_BROWSER_TITLES[spec.browser];
	return spec.profile ? `${title} (${spec.profile})` : title;
}

/**
 * Picks the browser for one download: keys typed after the URL, then the
 * domain rule, then the preferences. `true` means "use cookies" without naming
 * a browser, `false` means "no cookies for this download".
 */
export function resolveCookies(
	fromQuery: string | boolean | undefined,
	fromRule: string | boolean | undefined,
	fromPreferences: string | undefined,
): string | undefined {
	const choice = fromQuery ?? fromRule;
	if (choice === false) return undefined;
	if (typeof choice === "string") return choice;
	if (choice === true) {
		const named = typeof fromRule === "string" ? fromRule : fromPreferences;
		if (!named)
			throw new CookieError(
				"No browser chosen for cookies. Use e.g. -c firefox, or pick one in “Cookies From Browser” in the preferences",
			);
		return named;
	}
	return fromPreferences;
}

// --- Zen Browser ----------------------------------------------------------

export interface ZenLocations {
	home: string;
	platform: NodeJS.Platform;
	/** XDG_CONFIG_HOME, when set. */
	configHome?: string;
}

export function defaultZenLocations(): ZenLocations {
	return {
		home: os.homedir(),
		platform: process.platform,
		configHome: process.env.XDG_CONFIG_HOME,
	};
}

/**
 * Directories that may hold Zen's profiles.ini. Zen keeps the Firefox layout
 * but not the Firefox location: ~/.zen on Linux (still used by existing
 * installs), ~/.config/zen for fresh installs since 1.18.6b, the same two
 * inside the Flatpak sandbox, and Application Support on macOS.
 */
export function zenRoots(loc: ZenLocations = defaultZenLocations()): string[] {
	if (loc.platform === "darwin")
		return [path.join(loc.home, "Library", "Application Support", "zen")];

	const xdg =
		loc.configHome && path.isAbsolute(loc.configHome)
			? loc.configHome
			: path.join(loc.home, ".config");
	const flatpak = path.join(loc.home, ".var", "app", "app.zen_browser.zen");
	return [
		path.join(loc.home, ".zen"),
		path.join(xdg, "zen"),
		path.join(flatpak, ".zen"),
		path.join(flatpak, "config", "zen"),
	];
}

interface IniSection {
	name: string;
	values: Map<string, string>;
}

function parseIni(text: string): IniSection[] {
	const sections: IniSection[] = [];
	let current: IniSection | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(";") || line.startsWith("#")) continue;
		const header = /^\[(.+)\]$/.exec(line);
		if (header) {
			current = { name: header[1], values: new Map() };
			sections.push(current);
			continue;
		}
		const eq = line.indexOf("=");
		if (current && eq > 0)
			current.values.set(
				line.slice(0, eq).trim().toLowerCase(),
				line.slice(eq + 1).trim(),
			);
	}
	return sections;
}

function isDir(file: string): boolean {
	try {
		return fs.statSync(file).isDirectory();
	} catch {
		return false;
	}
}

function hasCookies(dir: string): boolean {
	try {
		return fs.statSync(path.join(dir, "cookies.sqlite")).isFile();
	} catch {
		return false;
	}
}

interface ZenProfile {
	name: string;
	dir: string;
	isDefault: boolean;
	/** This profile is the one the installed Zen opens ([Install…] section). */
	isInstallDefault: boolean;
}

function readProfiles(root: string): ZenProfile[] {
	let text: string;
	try {
		text = fs.readFileSync(path.join(root, "profiles.ini"), "utf8");
	} catch {
		return [];
	}

	const sections = parseIni(text);
	const locate = (value: string, relative: boolean) =>
		relative ? path.join(root, value) : value;

	const installDefaults = new Set(
		sections
			.filter((s) => /^install/i.test(s.name) && s.values.has("default"))
			.map((s) => path.normalize(locate(s.values.get("default") ?? "", true))),
	);

	return sections
		.filter((s) => /^profile/i.test(s.name) && s.values.has("path"))
		.map((s) => {
			const dir = path.normalize(
				locate(s.values.get("path") ?? "", s.values.get("isrelative") !== "0"),
			);
			return {
				name: s.values.get("name") ?? path.basename(dir),
				dir,
				isDefault: s.values.get("default") === "1",
				isInstallDefault: installDefaults.has(dir),
			};
		})
		.filter((p) => isDir(p.dir));
}

/** Profile directories found by looking for cookies.sqlite, for installs without profiles.ini. */
function scanProfiles(root: string): string[] {
	const found: string[] = [];
	for (const base of [root, path.join(root, "Profiles")]) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(base, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const dir = path.join(base, entry.name);
			if (entry.isDirectory() && hasCookies(dir)) found.push(dir);
		}
	}
	return found;
}

function mtime(file: string): number {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Finds the Zen profile directory to read cookies from.
 *
 * `profile` may be a profile name or directory name as listed in
 * profiles.ini, or an absolute path. Without it, the profile Zen itself opens
 * is used, falling back to the most recently used one.
 */
export function findZenProfile(
	profile: string | undefined,
	locations: ZenLocations = defaultZenLocations(),
): string {
	const roots = zenRoots(locations);

	if (profile) {
		const wanted = expandHome(profile);
		if (path.isAbsolute(wanted)) {
			if (!isDir(wanted))
				throw new CookieError(`Zen profile directory not found: ${wanted}`);
			return wanted;
		}
		const key = wanted.toLowerCase();
		for (const root of roots) {
			const hit = readProfiles(root).find(
				(p) =>
					p.name.toLowerCase() === key ||
					path.basename(p.dir).toLowerCase() === key,
			);
			if (hit) return hit.dir;
		}
		const known = roots.flatMap((r) => readProfiles(r).map((p) => p.name));
		throw new CookieError(
			`Zen profile "${profile}" not found${
				known.length ? ` (found: ${known.join(", ")})` : ""
			}`,
		);
	}

	const all = roots.flatMap((root) => {
		const listed = readProfiles(root);
		const known = new Set(listed.map((p) => p.dir));
		// Profiles on disk that profiles.ini does not mention still count.
		const extra = scanProfiles(root)
			.filter((dir) => !known.has(path.normalize(dir)))
			.map<ZenProfile>((dir) => ({
				name: path.basename(dir),
				dir,
				isDefault: false,
				isInstallDefault: false,
			}));
		return [...listed, ...extra];
	});

	const pick =
		all.find((p) => p.isInstallDefault && hasCookies(p.dir)) ??
		all.find((p) => p.isDefault && hasCookies(p.dir)) ??
		all
			.filter((p) => hasCookies(p.dir))
			.sort(
				(a, b) =>
					mtime(path.join(b.dir, "cookies.sqlite")) -
					mtime(path.join(a.dir, "cookies.sqlite")),
			)[0];
	if (pick) return pick.dir;

	throw new CookieError(
		`Could not find a Zen profile with cookies (looked in ${roots.join(", ")}). Open Zen once, or point to the profile directory: -c zen:/path/to/profile`,
	);
}

/**
 * The value for `--cookies-from-browser`. Zen is not known to yt-dlp, so it is
 * handed over as a Firefox profile; everything else passes through.
 */
export function resolveCookieSpec(
	value: string,
	locations?: ZenLocations,
): string {
	const spec = parseCookieSpec(value);
	if (!spec)
		throw new CookieError(
			`Unknown browser "${value}" (use ${COOKIE_BROWSERS.join(", ")})`,
		);
	if (spec.browser !== "zen") return formatCookieSpec(spec);

	const dir = findZenProfile(spec.profile, locations);
	return `firefox:${dir}${spec.container ? `::${spec.container}` : ""}`;
}
