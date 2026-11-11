import type { LaunchProps } from "@vicinae/api";
import { runQuickDownload } from "./lib/download";

export default async function Video(
	props: LaunchProps<{ arguments: { query: string } }>,
) {
	await runQuickDownload("video", props.arguments.query, [
		"container",
		"quality",
		"selector",
		"ffmpeg",
		"args",
		"playlist",
		"reencode",
		"audioReencode",
	]);
}
