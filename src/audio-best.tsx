import type { LaunchProps } from "@vicinae/api";
import { runQuickDownload } from "./lib/download";

export default async function AudioBest(
	props: LaunchProps<{ arguments: { url: string } }>,
) {
	await runQuickDownload("audio-best", props.arguments.url, [
		"playlist",
		"args",
	]);
}
