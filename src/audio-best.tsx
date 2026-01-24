import { handleDownload } from "./video";
import { CommandArguments } from "./types";

// Audio Best command - accepts only URL
export default async function audioBest(args: CommandArguments): Promise<void> {
	const url = args.arguments.url || "";
	await handleDownload("audio_best", url);
}