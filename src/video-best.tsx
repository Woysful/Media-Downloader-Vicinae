import type { LaunchProps } from "@vicinae/api";
import { runQuickDownload } from "./lib/download";

export default async function VideoBest(
	props: LaunchProps<{ arguments: { url: string } }>,
) {
	await runQuickDownload("video-best", props.arguments.url, [
		"playlist",
		"args",
	]);
}
