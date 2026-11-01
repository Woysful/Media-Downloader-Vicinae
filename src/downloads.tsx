import * as fs from "node:fs";
import * as path from "node:path";
import {
	Action,
	ActionPanel,
	Alert,
	Color,
	confirmAlert,
	Icon,
	List,
	open,
	showInFileBrowser,
	showToast,
	Toast,
} from "@vicinae/api";
import { useEffect, useState } from "react";
import { loadSettings, StatusToast, startDownload } from "./lib/download";
import { cancelJob, type JobEntry, listJobs, removeJob } from "./lib/jobs";
import type { DownloadKind } from "./lib/plan";
import { describeOutcome, describeProgress, type JobState } from "./lib/status";

const REFRESH_MS = 1000;

const KIND_TITLES: Record<DownloadKind, string> = {
	video: "Video",
	audio: "Audio",
	"video-best": "Video Best",
	"audio-best": "Audio Best",
};

function progressIcon(percent: number | null): Icon {
	if (percent === null) return Icon.CircleProgress;
	if (percent >= 100) return Icon.CircleProgress100;
	if (percent >= 75) return Icon.CircleProgress75;
	if (percent >= 50) return Icon.CircleProgress50;
	if (percent >= 25) return Icon.CircleProgress25;
	return Icon.CircleProgress;
}

function statusIcon(entry: JobEntry): List.Item.Props["icon"] {
	const state = entry.state;
	if (!state) return { value: Icon.Clock, tooltip: "Starting" };
	switch (state.status) {
		case "completed":
			return {
				value: { source: Icon.CheckCircle, tintColor: Color.Green },
				tooltip: "Completed",
			};
		case "partial":
			return {
				value: { source: Icon.CheckCircle, tintColor: Color.Orange },
				tooltip: "Finished with errors",
			};
		case "failed":
			return {
				value: { source: Icon.XMarkCircle, tintColor: Color.Red },
				tooltip: "Failed",
			};
		case "cancelled":
			return { value: Icon.MinusCircle, tooltip: "Cancelled" };
		default:
			return {
				value: { source: progressIcon(state.percent), tintColor: Color.Blue },
				tooltip: "In progress",
			};
	}
}

function hostOf(url: string | undefined): string {
	if (!url) return "";
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function describe(entry: JobEntry): { title: string; subtitle: string } {
	const name = entry.state?.title || hostOf(entry.spec?.url) || entry.job.id;
	if (!entry.state) return { title: name, subtitle: "Starting…" };
	const playlist = entry.spec?.playlist ?? true;
	const text = entry.active
		? describeProgress(entry.state, playlist)
		: describeOutcome(entry.state, playlist);
	const subtitle =
		entry.state.status === "completed" || entry.active
			? text.title
			: [text.title, text.message].filter(Boolean).join(": ");
	return { title: name, subtitle };
}

function formatStarted(date: Date, now = new Date()): string {
	const time = date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	if (date.toDateString() === now.toDateString()) return time;
	return `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

function existingFiles(state: JobState | undefined): string[] {
	return (state?.files ?? [])
		.map((f) => f.path)
		.filter((p) => fs.existsSync(p));
}

export default function DownloadList() {
	const [entries, setEntries] = useState<JobEntry[]>();

	const refresh = () => setEntries(listJobs());

	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, REFRESH_MS);
		return () => clearInterval(timer);
	}, []);

	const active = entries?.filter((e) => e.active) ?? [];
	const finished = entries?.filter((e) => !e.active) ?? [];

	async function cancel(entry: JobEntry) {
		const toast = await showToast({
			style: Toast.Style.Animated,
			title: "Cancelling download…",
		});
		try {
			await cancelJob(entry.job);
			toast.style = Toast.Style.Success;
			toast.title = "Download cancelled";
		} catch (error) {
			toast.style = Toast.Style.Failure;
			toast.message = String(error);
			toast.title = "Could not cancel the download";
		}
		refresh();
	}

	async function retry(entry: JobEntry) {
		if (!entry.spec?.request) return;
		const toast = new StatusToast();
		try {
			await startDownload(entry.spec.request, toast);
			await toast.success("Download started");
		} catch (error) {
			await toast.failure(
				"Could not start the download",
				error instanceof Error ? error.message : String(error),
			);
		}
		refresh();
	}

	async function clearFinished() {
		const ok = await confirmAlert({
			title: "Clear finished downloads?",
			message: "Downloaded files are kept, only the list entries are removed.",
			primaryAction: { title: "Clear", style: Alert.ActionStyle.Destructive },
		});
		if (!ok) return;
		for (const entry of finished) removeJob(entry.job);
		refresh();
	}

	function item(entry: JobEntry) {
		const { title, subtitle } = describe(entry);
		const files = existingFiles(entry.state);
		const first = files[0];
		const url = entry.spec?.url;
		const log = path.join(entry.job.dir, "output.log");
		const kind = entry.spec?.kind as DownloadKind | undefined;
		const started = entry.spec?.createdAt
			? new Date(entry.spec.createdAt)
			: undefined;

		const accessories: List.Item.Accessory[] = [];
		if (files.length > 1) accessories.push({ text: `${files.length} files` });
		if (kind && KIND_TITLES[kind]) accessories.push({ tag: KIND_TITLES[kind] });
		if (started)
			accessories.push({
				text: formatStarted(started),
				tooltip: started.toLocaleString(),
			});

		return (
			<List.Item
				key={entry.job.id}
				id={entry.job.id}
				title={title}
				subtitle={subtitle}
				icon={statusIcon(entry)}
				keywords={[hostOf(url), ...files.map((f) => path.basename(f))]}
				accessories={accessories}
				actions={
					<ActionPanel>
						{entry.active && (
							<Action
								title="Cancel Download"
								icon={Icon.XMarkCircle}
								style="destructive"
								onAction={() => void cancel(entry)}
							/>
						)}
						{first && <Action.Open title="Open File" target={first} />}
						{first && (
							<Action
								title="Show in File Manager"
								icon={Icon.Folder}
								onAction={() => void showInFileBrowser(first)}
							/>
						)}
						{!entry.active && entry.spec?.request && (
							<Action
								title="Download Again"
								icon={Icon.ArrowClockwise}
								shortcut={{ modifiers: ["ctrl"], key: "r" }}
								onAction={() => void retry(entry)}
							/>
						)}
						{url && <Action.OpenInBrowser title="Open Link" url={url} />}
						{url && (
							<Action.CopyToClipboard
								title="Copy Link"
								content={url}
								shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
							/>
						)}
						{entry.state?.error && (
							<Action.CopyToClipboard
								title="Copy Error"
								content={entry.state.error}
							/>
						)}
						{fs.existsSync(log) && (
							<Action
								title="Open Log"
								icon={Icon.Terminal}
								shortcut={{ modifiers: ["ctrl"], key: "l" }}
								onAction={() => void open(log)}
							/>
						)}
						{!entry.active && (
							<Action
								title="Remove from List"
								icon={Icon.Trash}
								shortcut={{ modifiers: ["ctrl"], key: "x" }}
								onAction={() => {
									removeJob(entry.job);
									refresh();
								}}
							/>
						)}
						{finished.length > 0 && (
							<Action
								title="Clear Finished Downloads"
								icon={Icon.Eraser}
								shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
								onAction={() => void clearFinished()}
							/>
						)}
						<Action
							title="Open Download Folder"
							icon={Icon.Folder}
							shortcut={{ modifiers: ["ctrl"], key: "o" }}
							onAction={() => void open(loadSettings().downloadDir)}
						/>
					</ActionPanel>
				}
			/>
		);
	}

	return (
		<List
			isLoading={entries === undefined}
			searchBarPlaceholder="Search downloads"
		>
			<List.EmptyView
				title="No downloads yet"
				description="Downloads from the last 3 days appear here"
				icon={Icon.Download}
			/>
			{active.length > 0 && (
				<List.Section title="In Progress" subtitle={String(active.length)}>
					{active.map(item)}
				</List.Section>
			)}
			{finished.length > 0 && (
				<List.Section title="Recent" subtitle={String(finished.length)}>
					{finished.map(item)}
				</List.Section>
			)}
		</List>
	);
}
