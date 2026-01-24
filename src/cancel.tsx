import { showToast, Toast } from "@vicinae/api";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Cancel download command - force stop all downloads
export default async function cancel(): Promise<void> {
	try {
		await showToast({
			style: Toast.Style.Animated,
			title: "⏹️ Cancelling download...",
			message: "Force stopping all download processes"
		});

		console.log("Starting force stop of all download processes");

		// Method 1: Kill by exact command names first
		try {
			await execAsync("pkill -9 yt-dlp || killall -9 yt-dlp || true");
			console.log("Force killed yt-dlp processes by name");
		} catch (e) {
			console.log("No yt-dlp processes found by name");
		}

		try {
			await execAsync("pkill -9 ffmpeg || killall -9 ffmpeg || true");
			console.log("Force killed ffmpeg processes by name");
		} catch (e) {
			console.log("No ffmpeg processes found by name");
		}

		// Method 2: Kill by command pattern (more aggressive)
		try {
			await execAsync("pkill -9 -f 'yt-dlp' || pkill -9 -f 'ffmpeg' || true");
			console.log("Force killed processes by command pattern");
		} catch (e) {
			console.log("No processes found by pattern");
		}

		// Method 3: Use ps and kill for maximum aggression
		try {
			// Find all yt-dlp PIDs and kill them
			const ytDlpPids = await execAsync("ps aux | grep 'yt-dlp' | grep -v grep | awk '{print $2}' || true");
			if (ytDlpPids.stdout.trim()) {
				const pids = ytDlpPids.stdout.trim().split('\n').filter(pid => pid.trim());
				if (pids.length > 0) {
					console.log(`Found yt-dlp PIDs: ${pids.join(', ')}`);
					await execAsync(`kill -9 ${pids.join(' ')} || true`);
					console.log("Force killed yt-dlp processes by PID");
				}
			}
		} catch (e) {
			console.log("Failed to find/kill yt-dlp processes by PID:", e);
		}

		try {
			// Find all ffmpeg PIDs and kill them
			const ffmpegPids = await execAsync("ps aux | grep 'ffmpeg' | grep -v grep | awk '{print $2}' || true");
			if (ffmpegPids.stdout.trim()) {
				const pids = ffmpegPids.stdout.trim().split('\n').filter(pid => pid.trim());
				if (pids.length > 0) {
					console.log(`Found ffmpeg PIDs: ${pids.join(', ')}`);
					await execAsync(`kill -9 ${pids.join(' ')} || true`);
					console.log("Force killed ffmpeg processes by PID");
				}
			}
		} catch (e) {
			console.log("Failed to find/kill ffmpeg processes by PID:", e);
		}

		console.log("Force stop completed");

		await showToast({
			style: Toast.Style.Success,
			title: "✅ Download cancelled",
			message: "All download processes have been forcefully stopped"
		});

	} catch (error) {
		console.error("Error cancelling download:", error);
		await showToast({
			style: Toast.Style.Failure,
			title: "❌ Cancel failed",
			message: "Could not stop download processes. Check system permissions."
		});
	}
}