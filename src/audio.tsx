import { handleDownload } from "./video";
import { CommandArguments } from "./types";

// Audio command - accepts URL with optional parameters
export default async function audio(args: CommandArguments): Promise<void> {
	const query = args.arguments.query || "";
	await handleDownload("audio", query);
}