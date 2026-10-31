import type { LaunchProps } from "@vicinae/api";
import { runQuickDownload } from "./lib/download";

export default async function Audio(
	props: LaunchProps<{ arguments: { query: string } }>,
) {
	await runQuickDownload("audio", props.arguments.query, [
		"container",
		"selector",
		"ffmpeg",
		"args",
		"playlist",
	]);
}
