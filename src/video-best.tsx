import { handleDownload } from "./video";
import { CommandArguments } from "./types";

// Video Best command - accepts only URL
export default async function videoBest(args: CommandArguments): Promise<void> {
	const url = args.arguments.url || "";
	await handleDownload("video_best", url);
}