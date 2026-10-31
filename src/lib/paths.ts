import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

/** Turns a preference value (possibly "~/x", "file:///x" or null) into an absolute path. */
export function normalizeUserPath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let v = value.trim();
	if (!v) return undefined;
	if (v.startsWith("file://")) {
		try {
			v = decodeURIComponent(new URL(v).pathname);
		} catch {
			return undefined;
		}
	}
	return path.resolve(expandHome(v));
}

export function configHome(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
}

/** Honours a localised XDG download directory (e.g. ~/Загрузки) before falling back to ~/Downloads. */
export function defaultDownloadDir(): string {
	try {
		const dirs = fs.readFileSync(
			path.join(configHome(), "user-dirs.dirs"),
			"utf8",
		);
		const match = /^XDG_DOWNLOAD_DIR="([^"]+)"/m.exec(dirs);
		if (match) {
			const dir = match[1].replace(/^\$HOME(?=\/|$)/, os.homedir());
			if (path.isAbsolute(dir) && dir !== os.homedir()) return dir;
		}
	} catch {
		// No user-dirs file: not an XDG desktop or not configured.
	}
	return path.join(os.homedir(), "Downloads");
}
