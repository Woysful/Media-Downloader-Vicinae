/*
 * Pure helpers for the tools the extension can download by itself. Kept apart
 * from tools.ts, which needs the Vicinae runtime, so they can be unit tested.
 */

/** Release asset of yt-dlp for this platform. "yt-dlp" is the zipapp, which needs system Python. */
export function ytdlpAsset(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string {
	if (platform === "darwin") return "yt-dlp_macos";
	if (platform === "win32") return "yt-dlp.exe";
	if (platform === "linux" && arch === "x64") return "yt-dlp_linux";
	if (platform === "linux" && arch === "arm64") return "yt-dlp_linux_aarch64";
	return "yt-dlp";
}

/**
 * Standalone builds bundle their own Python and libraries (mutagen included);
 * the zipapp uses whatever the system Python has.
 */
export function isStandaloneYtdlp(asset: string): boolean {
	return asset !== "yt-dlp";
}

/**
 * Name of the static ffmpeg build for this platform in yt-dlp/FFmpeg-Builds,
 * or undefined where the extension cannot fetch one (macOS, Windows, other CPUs).
 */
export function ffmpegBuild(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string | undefined {
	if (platform !== "linux") return undefined;
	if (arch === "x64") return "linux64";
	if (arch === "arm64") return "linuxarm64";
	return undefined;
}

/**
 * The GPL build is used on purpose: the re-encode presets need libx264 and
 * libx265, which the LGPL builds leave out.
 */
export function ffmpegArchiveUrl(build: string): string {
	return `https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${build}-gpl.tar.xz`;
}

/**
 * Reads the "Optional libraries" line of `yt-dlp -v` output.
 * Distro and pip installs often lack mutagen, which yt-dlp needs to embed
 * thumbnails into opus, ogg and flac files.
 */
export function hasMutagen(debugOutput: string): boolean {
	return /Optional libraries:[^\n]*\bmutagen-/i.test(debugOutput);
}
