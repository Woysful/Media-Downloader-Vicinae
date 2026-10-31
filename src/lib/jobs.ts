import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { environment } from "@vicinae/api";
import { isTerminal, type JobState } from "./status";
import { searchPath } from "./tools";

/** Read by assets/runner.js. */
export interface JobSpec {
	version: 1;
	id: string;
	url: string;
	kind: string;
	createdAt: number;
	tempDir: string;
	downloadDir: string;
	ytdlp: { bin: string; args: string[]; env?: Record<string, string> };
	reencode: { ffmpeg: string; ffprobe: string | null; args: string[] } | null;
	notify: boolean;
	openFolder: boolean;
	iconPath: string | null;
}

export interface Job {
	id: string;
	dir: string;
	tempDir: string;
}

const JOB_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const START_TIMEOUT_MS = 10_000;
const CANCEL_TIMEOUT_MS = 5_000;

export function jobsRoot(): string {
	return path.join(environment.supportPath, "jobs");
}

export function prepareJob(): Job {
	const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
	const dir = path.join(jobsRoot(), id);
	const tempDir = path.join(dir, "tmp");
	fs.mkdirSync(tempDir, { recursive: true });
	return { id, dir, tempDir };
}

export function startJob(
	job: Job,
	spec: Omit<JobSpec, "version" | "id" | "tempDir" | "createdAt">,
): void {
	const runner = path.join(environment.assetsPath, "runner.js");
	if (!fs.existsSync(runner))
		throw new Error(
			`Download runner is missing: ${runner}. Rebuild the extension.`,
		);

	const full: JobSpec = {
		version: 1,
		id: job.id,
		tempDir: job.tempDir,
		createdAt: Date.now(),
		...spec,
	};
	fs.writeFileSync(
		path.join(job.dir, "job.json"),
		JSON.stringify(full, null, 2),
	);

	// Own process group, no pipes: the download must outlive this command's worker.
	const child = spawn(process.execPath, [runner, job.dir], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, PATH: searchPath().join(path.delimiter) },
	});
	child.on("error", (error) =>
		console.error("Failed to start download runner:", error),
	);
	if (child.pid) fs.writeFileSync(path.join(job.dir, "pid"), String(child.pid));
	child.unref();
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readPid(dir: string): number | undefined {
	try {
		const pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
		return pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function readRawState(dir: string): JobState | undefined {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(dir, "state.json"), "utf8"),
		) as JobState;
	} catch {
		return undefined;
	}
}

function writeState(dir: string, state: JobState): void {
	const file = path.join(dir, "state.json");
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state));
	fs.renameSync(tmp, file);
}

function deadState(
	dir: string,
	previous: JobState | undefined,
	error: string,
): JobState {
	const cancelled = fs.existsSync(path.join(dir, "cancel-requested"));
	const now = Date.now();
	return {
		status: cancelled ? "cancelled" : "failed",
		stage: null,
		title: previous?.title ?? null,
		item: previous?.item ?? null,
		stream: null,
		streamCount: previous?.streamCount ?? 1,
		percent: null,
		speed: null,
		eta: null,
		downloaded: null,
		total: null,
		files: previous?.files ?? [],
		error: cancelled ? null : error,
		exitCode: null,
		pid: previous?.pid ?? 0,
		startedAt: previous?.startedAt ?? now,
		updatedAt: now,
		finishedAt: now,
	};
}

/** The job state, accounting for a runner that died without reporting. */
export function readJobState(job: Pick<Job, "dir">): JobState | undefined {
	const state = readRawState(job.dir);
	if (state && isTerminal(state.status)) return state;

	const pid = state?.pid || readPid(job.dir);
	if (pid && isProcessAlive(pid)) return state;

	if (!state) {
		const age =
			Date.now() -
			(fs.statSync(job.dir, { throwIfNoEntry: false })?.mtimeMs ?? 0);
		if (age < START_TIMEOUT_MS) return undefined;
		return deadState(job.dir, undefined, "The download process did not start");
	}
	return deadState(job.dir, state, "The download process stopped unexpectedly");
}

export function acknowledge(job: Pick<Job, "dir">): void {
	try {
		fs.writeFileSync(path.join(job.dir, "ack"), "");
	} catch {
		// Job directory was cleaned up already.
	}
}

function listJobDirs(): string[] {
	try {
		return fs
			.readdirSync(jobsRoot(), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => path.join(jobsRoot(), e.name));
	} catch {
		return [];
	}
}

export function listActiveJobs(): Job[] {
	return listJobDirs()
		.filter((dir) => {
			const state = readRawState(dir);
			if (state && isTerminal(state.status)) return false;
			const pid = state?.pid || readPid(dir);
			return pid !== undefined && isProcessAlive(pid);
		})
		.map((dir) => ({
			id: path.basename(dir),
			dir,
			tempDir: path.join(dir, "tmp"),
		}));
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

/** Stops the runner and everything it spawned (yt-dlp, ffmpeg) — and nothing else. */
export async function cancelJob(job: Job): Promise<void> {
	fs.writeFileSync(path.join(job.dir, "cancel-requested"), "");
	const pid = readRawState(job.dir)?.pid || readPid(job.dir);
	if (!pid) return;

	killGroup(pid, "SIGTERM");
	const deadline = Date.now() + CANCEL_TIMEOUT_MS;
	while (isProcessAlive(pid) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
	}
	if (isProcessAlive(pid)) killGroup(pid, "SIGKILL");

	const state = readRawState(job.dir);
	if (!state || !isTerminal(state.status))
		writeState(job.dir, deadState(job.dir, state, ""));
	fs.rmSync(job.tempDir, { recursive: true, force: true });
}

export function cleanupOldJobs(now = Date.now()): void {
	for (const dir of listJobDirs()) {
		const state = readRawState(dir);
		const finished =
			state?.finishedAt ?? (state ? undefined : fs.statSync(dir).mtimeMs);
		if (finished === undefined || now - finished < JOB_RETENTION_MS) continue;
		const pid = state?.pid || readPid(dir);
		if (pid && isProcessAlive(pid) && !(state && isTerminal(state.status)))
			continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
