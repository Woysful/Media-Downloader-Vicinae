import { Action, ActionPanel, Icon, showToast, Toast, open, environment, getPreferenceValues } from "@vicinae/api";
import { exec, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as os from "os";
import { CommandArguments, Preferences, DomainConfig } from "./types";

const execAsync = promisify(exec);

// Global state for download cancellation
let currentDownloadProcess: ChildProcess | null = null;
let currentDownloadPid: number | null = null;
let isDownloadInProgress = false;

// Video command - accepts URL with optional parameters
export default async function video(args: CommandArguments): Promise<void> {
	const query = args.arguments.query || "";
	await handleDownload("video", query);
}

// Audio command - accepts URL with optional parameters
export async function audio(args: CommandArguments): Promise<void> {
	const query = args.arguments.query || "";
	await handleDownload("audio", query);
}

// Video Best command - accepts only URL
export async function videoBest(args: CommandArguments): Promise<void> {
	const url = args.arguments.url || "";
	await handleDownload("video_best", url);
}

// Audio Best command - accepts only URL
export async function audioBest(args: CommandArguments): Promise<void> {
	const url = args.arguments.url || "";
	await handleDownload("audio_best", url);
}

// Cancel current download if in progress
export async function cancelDownload(): Promise<void> {
	if (!isDownloadInProgress) {
		await showToast({
			style: Toast.Style.Success,
			title: "No active download",
			message: "There is no download currently in progress"
		});
		return;
	}

	console.log(`Cancelling download process, PID: ${currentDownloadPid}`);

	try {
		// Show immediate feedback
		await showToast({
			style: Toast.Style.Animated,
			title: "⏹️ Cancelling download...",
			message: "Stopping all download processes"
		});

		// Method 1: Kill the entire process group if we have the PID
		if (currentDownloadPid) {
			try {
				console.log(`Killing process group for PID: ${currentDownloadPid}`);
				// Kill the entire process group (negative PID kills the group)
				await execAsync(`kill -TERM -${currentDownloadPid} || kill -KILL -${currentDownloadPid} || true`);
			} catch (e) {
				console.log(`Failed to kill process group for PID ${currentDownloadPid}:`, e);
			}
		}

		// Method 2: Force kill all yt-dlp processes by name
		try {
			console.log("Force killing all yt-dlp processes by name");
			await execAsync("pkill -9 yt-dlp || killall -9 yt-dlp || true");
		} catch (e) {
			console.log("No yt-dlp processes found by name");
		}

		// Method 3: Force kill all ffmpeg processes by name
		try {
			console.log("Force killing all ffmpeg processes by name");
			await execAsync("pkill -9 ffmpeg || killall -9 ffmpeg || true");
		} catch (e) {
			console.log("No ffmpeg processes found by name");
		}

		// Method 4: Kill by command pattern (more aggressive)
		try {
			console.log("Force killing processes by command pattern");
			await execAsync("pkill -9 -f 'yt-dlp' || pkill -9 -f 'ffmpeg' || true");
		} catch (e) {
			console.log("No processes found by pattern");
		}

		// Method 5: Also kill the tracked process if it exists
		if (currentDownloadProcess && !currentDownloadProcess.killed) {
			try {
				console.log("Killing tracked process directly");
				currentDownloadProcess.kill('SIGKILL');
			} catch (e) {
				console.log("Tracked process already dead");
			}
		}

		// Reset state
		currentDownloadProcess = null;
		currentDownloadPid = null;
		isDownloadInProgress = false;

		console.log("Download cancellation completed");

		await showToast({
			style: Toast.Style.Success,
			title: "✅ Download cancelled",
			message: "All download processes have been forcefully stopped"
		});

	} catch (error) {
		console.error("Error cancelling download:", error);
		// Even if there was an error, reset the state
		currentDownloadProcess = null;
		currentDownloadPid = null;
		isDownloadInProgress = false;

		await showToast({
			style: Toast.Style.Failure,
			title: "❌ Cancel failed",
			message: "Could not stop download processes. Try manually killing yt-dlp and ffmpeg processes."
		});
	}
}

// Check if download is currently in progress
export function isDownloadActive(): boolean {
	return isDownloadInProgress && currentDownloadProcess !== null && !currentDownloadProcess.killed;
}

// Main download handler
export async function handleDownload(downloadType: string, input: string): Promise<void> {
	try {
		// Check for empty input
		if (!input || !input.trim()) {
			const commandName = downloadType.replace('_', ' ').toUpperCase();
			await showToast({
				style: Toast.Style.Success,
				title: `${commandName} - No URL entered`,
				message: "Select the command again and enter a URL in the input field"
			});
			return;
		}

		// Get user preferences
		const preferences = getPreferenceValues<Preferences>();

		// Set default download directory to Downloads folder if not specified
		if (!preferences.downloadDirectory || !preferences.downloadDirectory.trim()) {
			preferences.downloadDirectory = path.join(os.homedir(), 'Downloads');
		}

		// Check if yt-dlp and ffmpeg are installed
		const ytdlpPath = await ensureYtdlpInstalled();
		const ffmpegPath = await ensureFfmpegInstalled();

		if (!ytdlpPath || !ffmpegPath) {
			await showToast({ style: Toast.Style.Failure, title: "Required tools not available" });
			console.error("Tools not available - yt-dlp:", ytdlpPath, "ffmpeg:", ffmpegPath);
			return;
		}

		// Show immediate feedback that download started
		showToast({
			style: Toast.Style.Animated,
			title: "🚀 Starting download...",
			message: ""
		});

		// Parse input based on download type
		let parsedInput: { url: string; params: Record<string, string> };

		if (downloadType === "video_best" || downloadType === "audio_best") {
			// These commands only accept URL
			parsedInput = { url: input.trim(), params: {} };
		} else {
			// These commands accept URL with optional parameters
			parsedInput = parseParametersFromQuery(input);
		}

		// Validate URL
		if (!parsedInput.url || !parsedInput.url.trim()) {
			await showToast({ style: Toast.Style.Failure, title: "No URL provided" });
			console.error("No URL provided in input:", input);
			return;
		}

		try {
			new URL(parsedInput.url);
	
		} catch (urlError) {
			await showToast({ style: Toast.Style.Failure, title: "Invalid URL format" });
			console.error("Invalid URL format:", parsedInput.url, urlError);
			return;
		}

		// Build command arguments
		const args = buildDownloadArgs(downloadType, parsedInput.url, parsedInput.params, preferences);



		// Execute the download with progress tracking
		const result = await runCommandWithProgress(ytdlpPath, args);
	} catch (error: any) {
		let errorTitle = "Error occurred";
		let errorMessage = error.message;

		// Provide more user-friendly error messages
		if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
			errorTitle = "Network Error";
			errorMessage = "Unable to connect to the video service. Check your internet connection.";
		} else if (error.message.includes('ENOENT')) {
			errorTitle = "File System Error";
			errorMessage = "Unable to save file to the specified directory.";
		} else if (error.message.includes('EACCES') || error.message.includes('EPERM')) {
			errorTitle = "Permission Error";
			errorMessage = "No permission to write to the download directory.";
		} else if (error.message.includes('spawn') && error.message.includes('ENOENT')) {
			errorTitle = "Tool Missing";
			errorMessage = "Required tool (yt-dlp or ffmpeg) is not available.";
		}

		await showToast({ style: Toast.Style.Failure, title: errorTitle, message: errorMessage });
		console.error("Download error:", error);
	}
}

// Parse parameters from query string (e.g., "https://youtube.com/video -q 1080 -f mp4")
function parseParametersFromQuery(input: string): { url: string; params: Record<string, string> } {
	const params: Record<string, string> = {};

	// Split input by spaces, but handle quoted strings
	const parts = input.match(/(?:[^\s"]+|"[^"]*")+/g) || [input];
	const url = parts[0].replace(/^"(.*)"$/, '$1'); // Remove surrounding quotes if present

	// Parse parameters
	for (let i = 1; i < parts.length; i++) {
		const param = parts[i];
		const nextParam = parts[i + 1];

		if (param === '-q' && nextParam) {
			params.quality = nextParam.replace(/^"(.*)"$/, '$1');
			i++; // Skip next parameter
		} else if (param === '-f' && nextParam) {
			params.format = nextParam.replace(/^"(.*)"$/, '$1');
			i++; // Skip next parameter
		} else if (param === '-yt' && nextParam) {
			params.ytdlpParams = nextParam.replace(/^"(.*)"$/, '$1');
			i++; // Skip next parameter
		} else if (param === '-ff' && nextParam) {
			params.ffmpegParams = nextParam.replace(/^"(.*)"$/, '$1');
			i++; // Skip next parameter
		}
	}

	return { url, params };
}

// Parse domain settings from preferences
function parseDomainSettings(preferences: Preferences): DomainConfig {
	const config: DomainConfig = {};

	// Check multiple possible locations for config file
	const possiblePaths = [];

	// Custom config directory (from preferences)
	if (preferences.customDomainConfig && preferences.customDomainConfig.trim()) {
		possiblePaths.push(path.join(preferences.customDomainConfig, 'domain-config.txt'));
	}

	// Default config location in user home
	possiblePaths.push(path.join(os.homedir(), '.config', 'media-downloader', 'domain-config.txt'));

	// Try to read from first available config file
	for (const configFilePath of possiblePaths) {
		try {

			if (fs.existsSync(configFilePath)) {

				const configText = fs.readFileSync(configFilePath, 'utf8');

				const parsedConfig = parseDomainSettingsFromText(configText);

				if (Object.keys(parsedConfig).length > 0) {

					return parsedConfig;
				} else {

				}
			}
		} catch (error) {
			console.error('Failed to read domain config file:', configFilePath, error);
		}
	}

	// Fallback to default hardcoded settings
	return {
		// 'youtube': {
		// 	'yt-dlp': '(bv[vcodec^=av01]/bv[ext=webm]/bv[vcodec^=avc1])+(ba[ext=m4a]/ba)',
		// 	'format': 'mkv'
		// },
		// 'instagram': {
		// 	'ffmpeg': '-c:v copy -c:a aac'
		// },
		// 'twitter': {
		// 	'format': 'mp4'
		// }
	};
}

// Parse domain settings from text format (for config file)
function parseDomainSettingsFromText(text: string): DomainConfig {
	const config: DomainConfig = {};

	if (!text || !text.trim()) {
		return config;
	}

	const lines = text.split('\n');

	for (const line of lines) {
		const trimmedLine = line.trim();
		// Skip empty lines and comments
		if (!trimmedLine || trimmedLine.startsWith('#') || !trimmedLine.includes(':')) {
			continue;
		}

		const [domainPart, paramsPart] = trimmedLine.split(':', 2);

		if (!domainPart || !paramsPart) {
			continue;
		}

		// Parse parameters once for all domains
		const parsedParams = parseDomainParams(paramsPart.trim());
		if (Object.keys(parsedParams).length === 0) {
			continue;
		}

		// Support multiple domains separated by comma: "youtube, youtu.be" or "youtube.com, youtu.be"
		const domainStrings = domainPart.split(',').map(d => d.trim().toLowerCase()).filter(d => d.length > 0);
		const domainsToAdd: string[] = [];

		for (const domainStr of domainStrings) {
			// Remove protocol if present
			let cleanDomain = domainStr.replace(/^https?:\/\//, '');
			// Remove www. prefix
			cleanDomain = cleanDomain.replace(/^www\./, '');
			
			// Extract first part before dot (e.g., "youtube.com" -> "youtube", "youtu.be" -> "youtu")
			const domainParts = cleanDomain.split('.');
			const firstPart = domainParts[0];
			
			// Add both the full domain (without www) and the first part
			// This allows matching both "youtube.com" and "youtu.be" when specified as "youtube, youtu"
			if (cleanDomain.includes('.')) {
				// Full domain (e.g., "youtube.com", "youtu.be")
				domainsToAdd.push(cleanDomain);
			}
			// First part (e.g., "youtube", "youtu")
			domainsToAdd.push(firstPart);
		}

		// Apply same settings to all specified domains (remove duplicates)
		const uniqueDomains = [...new Set(domainsToAdd)];
		for (const domain of uniqueDomains) {
			config[domain] = parsedParams;
	
		}
	}

	return config;
}

// Parse parameters from a single domain settings string
function parseDomainParams(paramsString: string): { "yt-dlp"?: string; "format"?: string; "ffmpeg"?: string } {
	const config: { "yt-dlp"?: string; "format"?: string; "ffmpeg"?: string } = {};

	if (!paramsString || !paramsString.trim()) {
		return config;
	}

	// Parse parameters like: yt-dlp="value" format="value" ffmpeg="value"
	// Note: param name can contain hyphens (yt-dlp)
	const paramRegex = /([\w-]+)="([^"]*)"/g;
	let match;

	while ((match = paramRegex.exec(paramsString)) !== null) {
		const [, paramName, paramValue] = match;
		if (paramName === 'yt-dlp' || paramName === 'format' || paramName === 'ffmpeg') {
			config[paramName] = paramValue;
	
		}
	}

	return config;
}

// Get domain-specific settings for a URL
function getDomainSpecificSettings(domainInfo: { full: string; firstPart: string }, preferences: Preferences) {
	const domainConfigs = parseDomainSettings(preferences);
	
	// Try to find config by full domain first, then by first part
	// This allows matching both "youtube.com" and "youtu.be" when config has "youtube.com, youtu.be: format=mp4"
	let domainConfig = domainConfigs[domainInfo.full.toLowerCase()] ||
	                   domainConfigs[domainInfo.firstPart.toLowerCase()] || {};

	// Priority: file settings > Vicinae preferences > hardcoded defaults
	const result = {
		videoParams: domainConfig["yt-dlp"] || 'bv+ba/best',
		videoFormat: domainConfig["format"] || preferences.defaultVideoFormat,
		audioFormat: preferences.defaultAudioFormat,
		ffmpegParams: domainConfig["ffmpeg"] || ''
	};

	return result;
}

// Get domain from URL
function getDomainFromUrl(url: string): { full: string; firstPart: string } {
	try {
		const urlObj = new URL(url);
		let domain = urlObj.hostname;
		if (domain.startsWith('www.')) {
			domain = domain.slice(4);
		}
		return {
			full: domain,
			firstPart: domain.split('.')[0]
		};
	} catch {
		return { full: '', firstPart: '' };
	}
}

// Build yt-dlp command arguments
function buildDownloadArgs(downloadType: string, url: string, params: Record<string, string>, preferences: Preferences): string[] {
	const args: string[] = [];

	// Output path (should always be set due to default logic above)
	const outputPath = preferences.downloadDirectory!;
	if (!outputPath) {
		throw new Error("Download directory not specified");
	}

	// Ensure output directory exists
	try {
		if (!fs.existsSync(outputPath)) {
			fs.mkdirSync(outputPath, { recursive: true });
	
		}
	} catch (dirError) {
		console.error("Failed to create output directory:", dirError);
	}

	args.push("-o", `${outputPath}/%(title)s.%(ext)s`);

	// Add progress and verbose options for better feedback
	args.push("--progress", "--newline");

	// Add embed metadata
	args.push("--embed-metadata");

	const domainInfo = getDomainFromUrl(url);

	// Get domain-specific settings (from config file or preferences)
	const domainSettings = getDomainSpecificSettings(domainInfo, preferences);

	// Priority: user params > domain config > preferences defaults
	const defaultVideoParams = domainSettings.videoParams;
	const defaultVideoFormat = domainSettings.videoFormat;
	const defaultAudioFormat = domainSettings.audioFormat;
	const defaultFfmpegParams = domainSettings.ffmpegParams;

	switch (downloadType) {
		case "video":
			const quality = params.quality || "";
			// User params override domain settings
			const videoParams = params.ytdlpParams || defaultVideoParams;
			const videoFormat = params.format || defaultVideoFormat;
			const ffmpegParams = params.ffmpegParams || defaultFfmpegParams;

	

			if (quality) {
				args.push("-f", `bv[height<=${quality}]+(ba[ext=${defaultAudioFormat}]/ba[ext=m4a]/ba)/`);
			} else {
				args.push("-f", videoParams);
			}
			args.push("--merge-output-format", videoFormat);
			if (ffmpegParams) {
				args.push("--postprocessor-args", ffmpegParams);
			}
			break;

		case "video_best":
	
			args.push("-f", "bestvideo+bestaudio/best");
			break;

		case "audio":
			// User params override domain settings
			const audioFormat = params.format || defaultAudioFormat;
			const audioFfmpegParams = params.ffmpegParams || defaultFfmpegParams;
	

			args.push("-f", "bestaudio");
			args.push("-x", "--audio-format", audioFormat);
			if (audioFfmpegParams) {
				args.push("--postprocessor-args", audioFfmpegParams);
			}
			break;

		case "audio_best":
	
			args.push("-f", "bestaudio");
			args.push("-x", "--audio-format", "wav");
			break;
	}

	// Add the URL at the end
	args.push(url);

	return args;
}

async function runCommand(command: string, args: string[]): Promise<{ success: boolean; output?: string; error?: string }> {
	try {
		const fullCommand = `${command} ${args.map(arg => `"${arg}"`).join(" ")}`;


		const { stdout, stderr } = await execAsync(fullCommand);



		return { success: true, output: stdout };
	} catch (error: any) {
		console.error("Command execution failed:", error);
		console.error("Error code:", error.code);
		console.error("Error signal:", error.signal);
		console.error("Error message:", error.message);
		return { success: false, error: error.message };
	}
}

// Parse progress information from yt-dlp output
function parseProgressInfo(output: string): { percentage: string; speed: string } {
	// Look for percentage first
	const percentMatch = output.match(/(\d+(?:\.\d+)?)%/);
	const percentage = percentMatch ? percentMatch[1] : '';

	// Look for speed in the same line (format: "at X.XMiB/s")
	const speedMatch = output.match(/at\s+([^\s]+(?:\/s)?)/);
	let speed = speedMatch ? speedMatch[1].replace('/s', '') : '';

	return { percentage, speed };
}

async function runCommandWithProgress(command: string, args: string[]): Promise<{ success: boolean; output?: string; error?: string }> {
	return new Promise((resolve) => {
		// Check if another download is already in progress
		if (isDownloadInProgress) {
			resolve({ success: false, error: "Another download is already in progress" });
			return;
		}

		const process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

		// Set global download state
		currentDownloadProcess = process;
		currentDownloadPid = process.pid || null;
		isDownloadInProgress = true;

		console.log(`Started download process with PID: ${currentDownloadPid}`);

		let stdout = '';
		let stderr = '';
		let lastProgressUpdate = Date.now();
		let lastProgressMessage = '';

		// Handle stdout (progress information and status)
		process.stdout?.on('data', (data) => {
			const output = data.toString();
			stdout += output;

			const { percentage, speed } = parseProgressInfo(output);

			if (percentage) {
				let progressMessage = `${percentage}%`;
				if (speed) {
					progressMessage += ` ${speed}`;
				}

				// Update progress only if it's different or enough time has passed
				const now = Date.now();
				if (progressMessage !== lastProgressMessage || now - lastProgressUpdate > 1000) {
					showToast({
						style: Toast.Style.Animated,
						title: progressMessage,
						message: ""
					});
					lastProgressUpdate = now;
					lastProgressMessage = progressMessage;
				}
			}

			// Parse video processing stages from stdout
			if (output.includes('Merging formats into')) {
				showToast({
					style: Toast.Style.Animated,
					title: "🔄 Final merge...",
					message: "Creating final output file"
				});
			} else if (output.includes('Deleting original file')) {
				showToast({
					style: Toast.Style.Animated,
					title: "🧹 Cleaning up...",
					message: "Removing temporary files"
				});
			} else if (output.includes('Destination:')) {
				// Extract filename from destination message
				const filenameMatch = output.match(/Destination:\s+(.+)/);
				if (filenameMatch) {
					const filename = filenameMatch[1].split('/').pop();
					showToast({
						style: Toast.Style.Animated,
						title: "Download Started",
						message: `Saving as: ${filename}`
					});
				}
			}
		});

		// Handle stderr (error information and additional progress)
		process.stderr?.on('data', (data) => {
			const errorOutput = data.toString();
			stderr += errorOutput;

			const { percentage, speed } = parseProgressInfo(errorOutput);

			if (percentage) {
				let progressMessage = `${percentage}%`;
				if (speed) {
					progressMessage += ` ${speed}`;
				}

				const now = Date.now();
				if (progressMessage !== lastProgressMessage || now - lastProgressUpdate > 1000) {
					showToast({
						style: Toast.Style.Animated,
						title: progressMessage,
						message: ""
					});
					lastProgressUpdate = now;
					lastProgressMessage = progressMessage;
				}
			}

			// Parse common yt-dlp errors and status messages
			if (errorOutput.includes('Video unavailable')) {
				showToast({
					style: Toast.Style.Failure,
					title: "Video Unavailable",
					message: "The requested video is not available or has been removed"
				});
			} else if (errorOutput.includes('Private video') || errorOutput.includes('This video is private')) {
				showToast({
					style: Toast.Style.Failure,
					title: "Private Video",
					message: "This video is private and cannot be downloaded"
				});
			} else if (errorOutput.includes('Sign in to confirm') || errorOutput.includes('age-restricted')) {
				showToast({
					style: Toast.Style.Failure,
					title: "Age Restricted",
					message: "This video is age-restricted. Sign in to YouTube to access it"
				});
			} else if (errorOutput.includes('Requested format is not available') ||
					   errorOutput.includes('not available') && errorOutput.includes('format')) {
				showToast({
					style: Toast.Style.Animated,
					title: "Format Not Available",
					message: "Requested quality/format not available, using best available"
				});
			} else if (errorOutput.includes('Unable to extract') || errorOutput.includes('Unable to download webpage')) {
				showToast({
					style: Toast.Style.Failure,
					title: "Extraction Error",
					message: "Unable to extract video information. URL may be invalid"
				});
			} else if (errorOutput.includes('HTTP Error 403')) {
				showToast({
					style: Toast.Style.Failure,
					title: "Access Forbidden",
					message: "Access forbidden - video may be region-locked or requires authentication"
				});
			} else if (errorOutput.includes('Network is unreachable') || errorOutput.includes('Connection timed out')) {
				showToast({
					style: Toast.Style.Failure,
					title: "Network Error",
					message: "Network connection error. Check your internet connection"
				});
			} else if (errorOutput.includes('ExtractAudio')) {
				showToast({
					style: Toast.Style.Animated,
					title: "🎵 Extracting audio...",
					message: "Converting video to audio format"
				});
			} else if (errorOutput.includes('Merging formats')) {
				showToast({
					style: Toast.Style.Animated,
					title: "🔄 Merging streams...",
					message: "Combining video and audio tracks"
				});
			} else if (errorOutput.includes('Embedding metadata')) {
				showToast({
					style: Toast.Style.Animated,
					title: "📝 Adding metadata...",
					message: "Embedding title, artist and other info"
				});
			} else if (errorOutput.includes('ffmpeg') && errorOutput.includes('postprocessor')) {
				showToast({
					style: Toast.Style.Animated,
					title: "🎬 Post-processing...",
					message: "Applying custom ffmpeg filters and conversions"
				});
			} else if (errorOutput.includes('ffmpeg')) {
				showToast({
					style: Toast.Style.Animated,
					title: "⚙️ Processing with ffmpeg...",
					message: "Applying video/audio processing"
				});
			}
		});

		process.on('close', (code) => {
			// Reset global download state
			currentDownloadProcess = null;
			currentDownloadPid = null;
			isDownloadInProgress = false;

			console.log(`Download process completed with code: ${code}`);

			if (code === 0) {
				showToast({
					style: Toast.Style.Success,
					title: "✅ Download completed!",
					message: ""
				});

				// Open file manager in download directory if preference is enabled
				const preferences = getPreferenceValues<Preferences>();
				if (preferences.openFileManagerAfterDownload) {
					const downloadDir = preferences.downloadDirectory || path.join(os.homedir(), 'Downloads');
					open(downloadDir);
				}

				resolve({ success: true, output: stdout });
			} else {
				let errorMessage = stderr || stdout;

				// Try to extract more specific error messages
				if (errorMessage.includes('Video unavailable')) {
					errorMessage = 'Video is not available or has been removed';
				} else if (errorMessage.includes('Private video') || errorMessage.includes('This video is private')) {
					errorMessage = 'This video is private and cannot be downloaded';
				} else if (errorMessage.includes('Sign in to confirm') || errorMessage.includes('age-restricted')) {
					errorMessage = 'Video is age-restricted - sign in to YouTube to access it';
				} else if (errorMessage.includes('Requested format is not available') ||
						   (errorMessage.includes('not available') && errorMessage.includes('format'))) {
					errorMessage = 'Requested quality/format not available. Try a different quality setting';
				} else if (errorMessage.includes('Unable to extract') || errorMessage.includes('Unable to download webpage')) {
					errorMessage = 'Unable to extract video information. URL may be invalid or site may be blocking access';
				} else if (errorMessage.includes('Network is unreachable') || errorMessage.includes('Connection timed out')) {
					errorMessage = 'Network connection error. Check your internet connection';
				} else if (errorMessage.includes('HTTP Error 403')) {
					errorMessage = 'Access forbidden - video may be region-locked or requires authentication';
				} else if (errorMessage.includes('HTTP Error 404')) {
					errorMessage = 'Video not found (404 error)';
				} else if (errorMessage.includes('ffmpeg') && errorMessage.includes('No such file')) {
					errorMessage = 'FFmpeg not found. Custom audio/video processing requires FFmpeg';
				} else if (errorMessage.includes('ffmpeg') && errorMessage.includes('error')) {
					errorMessage = 'FFmpeg processing failed. Check your ffmpeg parameters';
				} else if (errorMessage.includes('postprocessor') && errorMessage.includes('failed')) {
					errorMessage = 'Post-processing failed. Custom conversion parameters may be invalid';
				} else if (errorMessage.includes('Invalid URL')) {
					errorMessage = 'Invalid URL format provided';
				}

				showToast({
					style: Toast.Style.Failure,
					title: "❌ Download failed",
					message: errorMessage.substring(0, 50)
				});

				resolve({ success: false, error: errorMessage });
			}
		});

		process.on('error', (error) => {
			// Reset global download state
			currentDownloadProcess = null;
			currentDownloadPid = null;
			isDownloadInProgress = false;

			console.error(`Download process error:`, error);

			showToast({
				style: Toast.Style.Failure,
				title: "Command Error",
				message: error.message
			});
			resolve({ success: false, error: error.message });
		});
	});
}

async function downloadFile(url: string, destPath: string): Promise<void> {
	return new Promise((resolve, reject) => {


		const request = https.get(url, (response) => {
	
	

			// Handle redirects
			if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
		
				response.destroy();
				return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
			}

			if (response.statusCode !== 200) {
				response.destroy();
				return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
			}

			const file = fs.createWriteStream(destPath);
			let downloadedBytes = 0;

			response.on('data', (chunk) => {
				downloadedBytes += chunk.length;
			});

			response.pipe(file);

			file.on('finish', () => {
				file.close();
		
				resolve();
			});

			file.on('error', (err) => {
				console.error('File write error:', err);
				fs.unlink(destPath, () => {});
				reject(err);
			});
		});

		request.on('error', (err) => {
			console.error('Request error:', err);
			fs.unlink(destPath, () => {});
			reject(err);
		});

		request.setTimeout(30000, () => {
			console.error('Request timeout');
			request.destroy();
			fs.unlink(destPath, () => {});
			reject(new Error('Request timeout'));
		});
	});
}

// Get latest yt-dlp version from GitHub API
async function getLatestYtdlpVersion(): Promise<string | null> {
	try {
		const apiUrl = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

		return new Promise((resolve, reject) => {
			const request = https.get(apiUrl, {
				headers: {
					'User-Agent': 'vicinae-media-downloader'
				}
			}, (response) => {
				let data = '';

				response.on('data', (chunk) => {
					data += chunk;
				});

				response.on('end', () => {
					try {
						if (response.statusCode !== 200) {
							resolve(null);
							return;
						}

						const release = JSON.parse(data);
						const tagName = release.tag_name;

						// Remove 'v' prefix if present (e.g., "v2024.01.01" -> "2024.01.01")
						const version = tagName.startsWith('v') ? tagName.substring(1) : tagName;
						resolve(version);
					} catch (parseError) {
						console.error('Failed to parse GitHub API response:', parseError);
						resolve(null);
					}
				});
			});

			request.on('error', (error) => {
				console.error('Failed to fetch latest yt-dlp version:', error);
				resolve(null);
			});

			request.setTimeout(10000, () => {
				console.error('GitHub API request timeout');
				request.destroy();
				resolve(null);
			});
		});
	} catch (error) {
		console.error('Error getting latest yt-dlp version:', error);
		return null;
	}
}

// Get current yt-dlp version
async function getCurrentYtdlpVersion(ytdlpPath: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync(`"${ytdlpPath}" --version`);
		return stdout.trim();
	} catch (error) {
		console.error('Failed to get current yt-dlp version:', error);
		return null;
	}
}

// Check if version1 is older than version2 (simple comparison)
function isVersionOlder(version1: string, version2: string): boolean {
	try {
		const v1Parts = version1.split('.').map(n => parseInt(n, 10));
		const v2Parts = version2.split('.').map(n => parseInt(n, 10));

		for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
			const v1 = v1Parts[i] || 0;
			const v2 = v2Parts[i] || 0;

			if (v1 < v2) return true;
			if (v1 > v2) return false;
		}

		return false; // versions are equal
	} catch (error) {
		console.error('Error comparing versions:', error);
		return false;
	}
}

// Check for yt-dlp updates and update if necessary
async function checkAndUpdateYtdlp(ytdlpPath: string): Promise<void> {
	try {
		// Get current and latest versions
		const [currentVersion, latestVersion] = await Promise.all([
			getCurrentYtdlpVersion(ytdlpPath),
			getLatestYtdlpVersion()
		]);

		if (!currentVersion || !latestVersion) {
			console.log('Could not check yt-dlp version - skipping update check');
			return;
		}

		console.log(`Current yt-dlp version: ${currentVersion}, Latest: ${latestVersion}`);

		if (!isVersionOlder(currentVersion, latestVersion)) {
			console.log('yt-dlp is up to date');
			return;
		}

		console.log(`yt-dlp update available: ${currentVersion} -> ${latestVersion}`);

		// Show update notification
		await showToast({
			style: Toast.Style.Animated,
			title: "🔄 Updating yt-dlp...",
			message: `New version available (${latestVersion})`
		});

		// For local installation, download new version
		if (ytdlpPath !== "yt-dlp") {
			const binDir = path.dirname(ytdlpPath);
			const backupPath = `${ytdlpPath}.backup`;

			try {
				// Create backup of current version
				if (fs.existsSync(ytdlpPath)) {
					fs.copyFileSync(ytdlpPath, backupPath);
				}

				// Download new version
				const ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/" +
					(os.platform() === "win32" ? "yt-dlp.exe" : "yt-dlp");

				await downloadFile(ytdlpUrl, ytdlpPath);

				// Verify the downloaded file
				const stats = fs.statSync(ytdlpPath);
				if (stats.size === 0) {
					throw new Error("Downloaded file is empty");
				}

				if (os.platform() !== "win32") {
					fs.chmodSync(ytdlpPath, 0o755);
				}

				// Test the new version
				const newVersion = await getCurrentYtdlpVersion(ytdlpPath);
				if (!newVersion) {
					throw new Error("Could not verify new yt-dlp version");
				}

				// Remove backup if update successful
				if (fs.existsSync(backupPath)) {
					fs.unlinkSync(backupPath);
				}

				await showToast({
					style: Toast.Style.Success,
					title: "✅ yt-dlp updated!",
					message: `Updated to version ${newVersion}`
				});

				console.log(`yt-dlp successfully updated to ${newVersion}`);

			} catch (updateError) {
				console.error('Failed to update yt-dlp:', updateError);

				// Restore backup if available
				if (fs.existsSync(backupPath)) {
					fs.copyFileSync(backupPath, ytdlpPath);
					fs.unlinkSync(backupPath);
					console.log('Restored yt-dlp backup');
				}

				await showToast({
					style: Toast.Style.Failure,
					title: "❌ Update failed",
					message: "Could not update yt-dlp, using existing version"
				});
			}
		} else {
			// For system yt-dlp, just notify user
			await showToast({
				style: Toast.Style.Animated,
				title: "ℹ️ yt-dlp update available",
				message: `System yt-dlp can be updated manually to ${latestVersion}`
			});
		}

	} catch (error) {
		console.error('Error during yt-dlp update check:', error);
		// Don't show error toast for background update checks to avoid spam
	}
}

async function ensureYtdlpInstalled(): Promise<string | null> {
	// First try to use system yt-dlp
	try {
		await execAsync("yt-dlp --version");

		// Check for updates in background (don't block the download)
		checkAndUpdateYtdlp("yt-dlp").catch(error => {
			console.error('Background yt-dlp update check failed:', error);
		});

		return "yt-dlp";
	} catch (systemError) {
		// System yt-dlp not available, will try local installation
	}

	const binDir = path.join(environment.supportPath, "bin");
	const ytdlpPath = path.join(binDir, os.platform() === "win32" ? "yt-dlp.exe" : "yt-dlp");

	console.log("Checking yt-dlp at:", ytdlpPath);
	console.log("Bin dir exists:", fs.existsSync(binDir));

	// Check if file exists and is not empty (size > 0)
	let needsDownload = true;
	if (fs.existsSync(ytdlpPath)) {
		const stats = fs.statSync(ytdlpPath);
		if (stats.size > 0) {
	
			try {
				// Test if the binary works
				await execAsync(`"${ytdlpPath}" --version`);

				// Check for updates in background (don't block the download)
				checkAndUpdateYtdlp(ytdlpPath).catch(error => {
					console.error('Background yt-dlp update check failed:', error);
				});
		
				return ytdlpPath;
			} catch (testError) {
				console.error('Local yt-dlp test failed:', testError);
				// Remove corrupted file
				fs.unlinkSync(ytdlpPath);
			}
		} else {
	
			fs.unlinkSync(ytdlpPath);
		}
	}

	try {

		await showToast({ style: Toast.Style.Animated, title: "Installing yt-dlp..." });
		fs.mkdirSync(binDir, { recursive: true });

		const ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/" +
			(os.platform() === "win32" ? "yt-dlp.exe" : "yt-dlp");


		await downloadFile(ytdlpUrl, ytdlpPath);

		// Verify the downloaded file
		const stats = fs.statSync(ytdlpPath);
		if (stats.size === 0) {
			throw new Error("Downloaded file is empty");
		}

		if (os.platform() !== "win32") {
			fs.chmodSync(ytdlpPath, 0o755);
	
		}

		// Test the freshly downloaded binary
		try {
			await execAsync(`"${ytdlpPath}" --version`);
	
		} catch (verifyError: any) {
			throw new Error(`Downloaded yt-dlp verification failed: ${verifyError.message}`);
		}


		await showToast({ style: Toast.Style.Success, title: "yt-dlp installed successfully" });
		return ytdlpPath;
	} catch (error) {
		console.error("Failed to install yt-dlp:", error);
		// Clean up failed download
		if (fs.existsSync(ytdlpPath)) {
			fs.unlinkSync(ytdlpPath);
		}
		return null;
	}
}

async function ensureFfmpegInstalled(): Promise<string | null> {
	const binDir = path.join(environment.supportPath, "bin");
	const ffmpegPath = path.join(binDir, os.platform() === "win32" ? "ffmpeg.exe" : "ffmpeg");

	console.log("Checking ffmpeg at:", ffmpegPath);

	// Check if local ffmpeg exists and works
	if (fs.existsSync(ffmpegPath)) {
		const stats = fs.statSync(ffmpegPath);
		if (stats.size > 0) {
	
			try {
				await execAsync(`"${ffmpegPath}" -version`);
		
				return ffmpegPath;
			} catch (testError) {
		
				fs.unlinkSync(ffmpegPath);
			}
		} else {
	
			fs.unlinkSync(ffmpegPath);
		}
	}

	try {

		// Try to use system ffmpeg first
		await execAsync("ffmpeg -version");

		return "ffmpeg";
	} catch (systemError) {

		// System ffmpeg not available, would need to implement download
		// For now, return null to indicate ffmpeg is not available
		console.warn("System ffmpeg not found and automatic installation not implemented yet");
		return null;
	}
}
