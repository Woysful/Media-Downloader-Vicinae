import {
	Action,
	ActionPanel,
	Clipboard,
	Form,
	Icon,
	open,
	openExtensionPreferences,
	showInFileBrowser,
	showToast,
	Toast,
} from "@vicinae/api";
import * as path from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	AUDIO_FORMATS,
	asCompatMode,
	type CompatMode,
	parseQuality,
	type Quality,
	VIDEO_CONTAINERS,
} from "./lib/constants";
import { findRule, loadDomainConfig } from "./lib/domain-config";
import {
	errorMessage,
	loadConfig,
	loadSettings,
	monitorDownload,
	type StartedDownload,
	StatusToast,
	startDownload,
} from "./lib/download";
import { cancelJob } from "./lib/jobs";
import { buildPlan, type DownloadKind, type DownloadRequest } from "./lib/plan";
import { normalizeUrl } from "./lib/query";
import { splitShellWords } from "./lib/shell-words";
import { describeProgress, isSuccess, type JobState } from "./lib/status";

type Phase = "edit" | "running" | "done";

const DEFAULT = "default";

const KIND_ITEMS: { value: DownloadKind; title: string; icon: Icon }[] = [
	{ value: "video", title: "Video", icon: Icon.Video },
	{ value: "audio", title: "Audio", icon: Icon.Music },
	{
		value: "video-best",
		title: "Video – best quality, untouched",
		icon: Icon.FilmStrip,
	},
	{
		value: "audio-best",
		title: "Audio – best quality as WAV",
		icon: Icon.Headphones,
	},
];

const QUALITIES = ["best", "2160", "1440", "1080", "720", "480", "360"];

const COMPAT_TITLES: Record<CompatMode, string> = {
	original: "Keep original streams",
	prefer: "Prefer H.264/AAC (no re-encode)",
	reencode: "Re-encode to H.264/AAC, constant frame rate",
};

function qualityLabel(quality: Quality): string {
	return quality === "best" ? "Best available" : `Up to ${quality}p`;
}

function looksLikeUrl(text: string): boolean {
	return /^https?:\/\/\S+$/i.test(text.trim());
}

export default function NewDownload() {
	const settings = useMemo(loadSettings, []);
	const config = useMemo(() => loadConfig(settings), [settings]);

	const [url, setUrl] = useState("");
	const [urlError, setUrlError] = useState<string>();
	const [kind, setKind] = useState<DownloadKind>("video");
	const [quality, setQuality] = useState(DEFAULT);
	const [container, setContainer] = useState(DEFAULT);
	const [audioFormat, setAudioFormat] = useState(DEFAULT);
	const [compat, setCompat] = useState(DEFAULT);
	const [playlist, setPlaylist] = useState(false);
	const [selector, setSelector] = useState("");
	const [ffmpegArgs, setFfmpegArgs] = useState("");
	const [extraArgs, setExtraArgs] = useState("");

	const [phase, setPhase] = useState<Phase>("edit");
	const [started, setStarted] = useState<StartedDownload>();
	const [jobState, setJobState] = useState<JobState>();

	const unmounted = useRef(false);
	useEffect(
		() => () => {
			unmounted.current = true;
		},
		[],
	);

	useEffect(() => {
		Clipboard.readText()
			.then((text) => {
				if (text && looksLikeUrl(text))
					setUrl((current) => current || text.trim());
			})
			.catch(() => {});
	}, []);

	const isVideo = kind === "video";
	const isAudio = kind === "audio";
	const customizable = isVideo || isAudio;

	const buildRequest = (): DownloadRequest => ({
		kind,
		url: normalizeUrl(url.trim()),
		quality: isVideo && quality !== DEFAULT ? parseQuality(quality) : undefined,
		container:
			isVideo && container !== DEFAULT
				? container
				: isAudio && audioFormat !== DEFAULT
					? audioFormat
					: undefined,
		compat: isVideo ? asCompatMode(compat) : undefined,
		selector: customizable && selector.trim() ? selector.trim() : undefined,
		ffmpegArgs:
			customizable && ffmpegArgs.trim() ? ffmpegArgs.trim() : undefined,
		extraArgs: extraArgs.trim() ? splitShellWords(extraArgs) : undefined,
		playlist,
	});

	const rule = useMemo(() => {
		if (!config || !looksLikeUrl(url)) return undefined;
		return findRule(config.rules, url.trim());
	}, [config, url]);

	const defaults = {
		quality: rule?.settings.quality ?? settings.quality,
		container: rule?.settings.container ?? settings.videoContainer,
		audioFormat: rule?.settings.audioFormat ?? settings.audioFormat,
		compat: rule?.settings.compat ?? settings.compat,
	};

	const preview = useMemo(() => {
		try {
			const req = {
				...buildRequest(),
				url: looksLikeUrl(url) ? url.trim() : "https://example.com/",
			};
			const { summary } = buildPlan(req, settings, rule, { tempDir: "" });
			const lines = [
				rule
					? `Domain rule: ${rule.domains.join(", ")} (line ${rule.line})`
					: "Domain rule: none",
				`Format selector: ${summary.selector}`,
			];
			if (summary.kind === "video") {
				lines.push(`Quality: ${qualityLabel(summary.quality)}`);
				lines.push(`Container: ${summary.container}`);
				lines.push(`Editing compatibility: ${COMPAT_TITLES[summary.compat]}`);
			}
			if (summary.audioFormat)
				lines.push(`Audio format: ${summary.audioFormat}`);
			lines.push(
				playlist
					? "Whole playlist into a subfolder"
					: "Single item (playlist links download one video)",
			);
			lines.push(`Saving to: ${settings.downloadDir}`);
			return lines.join("\n");
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}, [
		kind,
		quality,
		container,
		audioFormat,
		compat,
		playlist,
		selector,
		ffmpegArgs,
		extraArgs,
		url,
		rule,
		settings,
	]);

	const statusText = useMemo(() => {
		if (!jobState) return phase === "running" ? "Starting…" : "";
		const { title, message } = describeProgress(
			jobState,
			started?.plan.summary.playlist ?? true,
		);
		const files = isSuccess(jobState.status)
			? jobState.files.map((f) => path.basename(f.path))
			: [];
		return [
			title,
			message,
			...files.slice(0, 5),
			files.length > 5 ? `…and ${files.length - 5} more` : "",
		]
			.filter(Boolean)
			.join("\n");
	}, [jobState, phase, started]);

	async function submit() {
		let req: DownloadRequest;
		try {
			req = buildRequest();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!url.trim() || /URL/i.test(message))
				setUrlError(message || "Enter a URL");
			await showToast({
				style: Toast.Style.Failure,
				title: "Invalid input",
				message,
			});
			return;
		}

		setPhase("running");
		setJobState(undefined);
		const toast = new StatusToast();
		try {
			const download = await startDownload(req, toast);
			if (unmounted.current) return;
			setStarted(download);
			await monitorDownload(download, toast, {
				onState: (state) => {
					if (!unmounted.current) setJobState({ ...state });
				},
				isCancelled: () => unmounted.current,
			});
			if (!unmounted.current) setPhase("done");
		} catch (error) {
			const { title, message } = errorMessage(error);
			await toast.failure(title, message);
			if (!unmounted.current) setPhase("edit");
		}
	}

	function reset() {
		setPhase("edit");
		setStarted(undefined);
		setJobState(undefined);
		setUrl("");
	}

	async function openConfig() {
		try {
			await open(loadDomainConfig(settings.domainConfigDir).path);
		} catch (error) {
			await showToast({
				style: Toast.Style.Failure,
				title: "Could not open domain config",
				message: String(error),
			});
		}
	}

	const firstFile =
		jobState && isSuccess(jobState.status)
			? jobState.files[0]?.path
			: undefined;

	const actions = (
		<ActionPanel>
			{phase === "edit" && (
				<Action.SubmitForm
					title="Start Download"
					icon={Icon.Download}
					onSubmit={submit}
				/>
			)}
			{phase === "running" && started && (
				<Action
					title="Cancel Download"
					icon={Icon.XMarkCircle}
					style="destructive"
					onAction={() => void cancelJob(started.job)}
				/>
			)}
			{phase === "done" && firstFile && (
				<Action
					title="Show in File Manager"
					icon={Icon.Folder}
					onAction={() => void showInFileBrowser(firstFile)}
				/>
			)}
			{phase === "done" && firstFile && (
				<Action.Open title="Open File" target={firstFile} />
			)}
			{phase === "done" && (
				<Action title="New Download" icon={Icon.Download} onAction={reset} />
			)}
			<Action
				title="Open Download Folder"
				icon={Icon.Folder}
				shortcut={{ modifiers: ["ctrl"], key: "o" }}
				onAction={() => void open(settings.downloadDir)}
			/>
			<Action
				title="Edit Domain Rules"
				icon={Icon.Pencil}
				shortcut={{ modifiers: ["ctrl"], key: "d" }}
				onAction={() => void openConfig()}
			/>
			<Action
				title="Open Extension Preferences"
				icon={Icon.Cog}
				shortcut={{ modifiers: ["ctrl"], key: "," }}
				onAction={() => void openExtensionPreferences()}
			/>
		</ActionPanel>
	);

	return (
		<Form
			navigationTitle="New Download"
			isLoading={phase === "running"}
			actions={actions}
		>
			{phase !== "edit" && (
				<Form.Description title="Status" text={statusText || "Starting…"} />
			)}
			<Form.TextField
				id="url"
				title="URL"
				placeholder="https://…"
				autoFocus
				value={url}
				error={urlError}
				onChange={(value) => {
					setUrl(value);
					setUrlError(undefined);
				}}
			/>
			<Form.Dropdown
				id="kind"
				title="Download"
				value={kind}
				onChange={(value) => setKind(value as DownloadKind)}
			>
				{KIND_ITEMS.map((item) => (
					<Form.Dropdown.Item
						key={item.value}
						value={item.value}
						title={item.title}
						icon={item.icon}
					/>
				))}
			</Form.Dropdown>

			{isVideo && (
				<Form.Dropdown
					id="quality"
					title="Quality"
					value={quality}
					onChange={setQuality}
				>
					<Form.Dropdown.Item
						value={DEFAULT}
						title={`Default – ${qualityLabel(defaults.quality)}`}
					/>
					{QUALITIES.map((q) => (
						<Form.Dropdown.Item
							key={q}
							value={q}
							title={q === "best" ? "Best available" : `Up to ${q}p`}
						/>
					))}
				</Form.Dropdown>
			)}
			{isVideo && (
				<Form.Dropdown
					id="container"
					title="Container"
					value={container}
					onChange={setContainer}
				>
					<Form.Dropdown.Item
						value={DEFAULT}
						title={`Default – ${defaults.container.toUpperCase()}`}
					/>
					{VIDEO_CONTAINERS.map((c) => (
						<Form.Dropdown.Item key={c} value={c} title={c.toUpperCase()} />
					))}
				</Form.Dropdown>
			)}
			{isVideo && (
				<Form.Dropdown
					id="compat"
					title="Editing compatibility"
					value={compat}
					onChange={setCompat}
					info="Video editors drop frames on MKV timestamps, AV1/VP9 and variable frame rate. Re-encoding fixes all of these at the cost of time."
				>
					<Form.Dropdown.Item
						value={DEFAULT}
						title={`Default – ${COMPAT_TITLES[defaults.compat]}`}
					/>
					{(Object.keys(COMPAT_TITLES) as CompatMode[]).map((mode) => (
						<Form.Dropdown.Item
							key={mode}
							value={mode}
							title={COMPAT_TITLES[mode]}
						/>
					))}
				</Form.Dropdown>
			)}
			{isAudio && (
				<Form.Dropdown
					id="audioFormat"
					title="Audio format"
					value={audioFormat}
					onChange={setAudioFormat}
				>
					<Form.Dropdown.Item
						value={DEFAULT}
						title={`Default – ${defaults.audioFormat.toUpperCase()}`}
					/>
					{AUDIO_FORMATS.map((f) => (
						<Form.Dropdown.Item
							key={f}
							value={f}
							title={f === "vorbis" ? "OGG (Vorbis)" : f.toUpperCase()}
						/>
					))}
				</Form.Dropdown>
			)}
			<Form.Checkbox
				id="playlist"
				title="Playlist"
				label="Download the whole playlist"
				value={playlist}
				onChange={setPlaylist}
			/>

			<Form.Separator />
			{customizable && (
				<Form.TextField
					id="selector"
					title="yt-dlp format"
					placeholder={
						isVideo
							? (rule?.settings.selector ?? settings.videoSelector)
							: "ba/b"
					}
					info="yt-dlp format selector (-f), e.g. bv*[height<=1080]+ba/b"
					value={selector}
					onChange={setSelector}
				/>
			)}
			{customizable && (
				<Form.TextField
					id="ffmpeg"
					title="ffmpeg arguments"
					placeholder="-c:v libx265 -crf 22"
					info={
						isVideo
							? "Applied while merging/remuxing, or appended to the re-encode arguments in re-encode mode."
							: "Applied while extracting audio."
					}
					value={ffmpegArgs}
					onChange={setFfmpegArgs}
				/>
			)}
			<Form.TextField
				id="extraArgs"
				title="Extra yt-dlp arguments"
				placeholder="--cookies-from-browser firefox"
				value={extraArgs}
				onChange={setExtraArgs}
			/>
			<Form.Description title="Will use" text={preview} />
		</Form>
	);
}
