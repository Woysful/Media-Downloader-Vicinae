// Common types and interfaces for Media Downloader extension

export interface CommandArguments {
	arguments: {
		query?: string;
		url?: string;
	};
}

// Preferences type for type safety
export interface Preferences {
	downloadDirectory?: string;
	defaultVideoFormat: string;
	defaultAudioFormat: string;
	customDomainConfig?: string;
	openFileManagerAfterDownload: boolean;
}

// Parsed domain settings
export interface DomainConfig {
	[key: string]: {
		"yt-dlp"?: string;
		"format"?: string;
		"ffmpeg"?: string;
	};
}