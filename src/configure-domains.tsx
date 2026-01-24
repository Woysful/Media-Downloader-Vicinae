import { showToast, Toast, getPreferenceValues } from "@vicinae/api";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);

interface CommandArguments {
	arguments: {};
}

// Configure Domains command - opens the domain configuration file
export default async function configureDomains(args: CommandArguments): Promise<void> {
	try {
		const preferences = getPreferenceValues<{ customDomainConfig?: string }>();

		let configFilePath: string;

		if (preferences.customDomainConfig && preferences.customDomainConfig.trim()) {
			// Use custom config directory
			configFilePath = path.join(preferences.customDomainConfig, 'domain-config.txt');
		} else {
			// Use default location in user's home directory
			configFilePath = path.join(os.homedir(), '.config', 'media-downloader', 'domain-config.txt');
		}

		// Ensure directory exists
		const configDir = path.dirname(configFilePath);
		if (!fs.existsSync(configDir)) {
			fs.mkdirSync(configDir, { recursive: true });
		}

		// Create file if it doesn't exist
		if (!fs.existsSync(configFilePath)) {
			const exampleConfig = `# Domain configuration for Media Downloader
# Format: domain: yt-dlp="parameters" format="extension" ffmpeg="arguments"
# One domain per line, parameters are optional
# You can specify multiple domains separated by comma to use the same settings

# Add your custom domains below
# mysite: yt-dlp="bv+ba/best" format="mkv" ffmpeg="-c:v libx264 -c:a aac"

# YouTube - high quality with fallback codecs (supports both youtube.com and youtu.be)
youtube.com, youtu.be: yt-dlp="(bv[vcodec^=av01]/bv[ext=webm]/bv[vcodec^=avc1])+(ba[ext=m4a]/ba)" format="mkv"
`;

			fs.writeFileSync(configFilePath, exampleConfig, 'utf8');
			await showToast({
				style: Toast.Style.Success,
				title: "Config file created",
				message: `Created ${configFilePath} with example settings`
			});
		}

		// Try to open file with system default editor
		try {
			if (os.platform() === "win32") {
				await execAsync(`start "" "${configFilePath}"`);
			} else if (os.platform() === "darwin") {
				await execAsync(`open "${configFilePath}"`);
			} else {
				// Linux/Unix - try common editors
				const editors = ['xdg-open', 'nano', 'vim', 'gedit', 'kate'];
				let opened = false;

				for (const editor of editors) {
					try {
						await execAsync(`${editor} "${configFilePath}"`);
						opened = true;
						break;
					} catch {
						// Try next editor
					}
				}

				if (!opened) {
					throw new Error("No suitable editor found");
				}
			}

			await showToast({
				style: Toast.Style.Success,
				title: "Config file opened",
				message: `Opened ${configFilePath} for editing`
			});
		} catch (error) {
			// If opening fails, at least show the path
			await showToast({
				style: Toast.Style.Success,
				title: "Config file location",
				message: `Edit file manually: ${configFilePath}`
			});
		}

	} catch (error: any) {
		await showToast({
			style: Toast.Style.Failure,
			title: "Error opening config",
			message: error.message
		});
		console.error("Configure domains error:", error);
	}
}