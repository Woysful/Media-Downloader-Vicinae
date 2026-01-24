# Media Downloader for Vicinae

A yt-dlp based media downloader extension for Vicinae that allows downloading video/audio from various platforms with customizable settings per domain.

Basically a port of a plugin made for [Flow Launcher](https://github.com/woysful/media-downloader-FlowLauncher)

*Heavily vibe coded, expect issues

## Features

- Download Video/Audio with custom yt-dlp / ffmpeg arguments
- Custom download settings for individual domains

## Installation

Download [`media-downloader.tar.gz`](https://github.com/Woysful/Media-Downloader-Vicinae/releases/latest/download/media-downloader.tar.gz), extract and place `media-downloader` folder to extensions folder.

Or you can build it yourself:

```bash
git clone https://github.com/Woysful/Media-Downloader-Vicinae.git
cd ./Media-Downloader-Vicinae
npm install
npm run build
```

The extension will be built to `~/.local/share/vicinae/extensions/media-downloader/`

## Usage

### Commands

- `Video` Downloads video with configurable yt-dlp / ffmpeg parameters and containers.

    If you simply insert a link without specifying custom parameters, there will first be a fallback to your personal settings for that specific domain, and then, if there are no individual settings for that domain, a fallback to the default global settings that you specified in the extension settings. 

- `Audio` Downloads audio with the same configurable parameters as video
- `Video Best` Downloads video in best possible quality no matter what codec/container it uses
- `Audio Best` Downloads audio in best possible quality and autoconverts to WAV
- `Configure Domains` Opens domain configuration file
- `Cancel Download` Cancels any active download

### Parameters

| key  | Description                              | Example                     |
|:-----|:-----------------------------------------|:----------------------------|
|`-f`  | video/audio format                       | -f mp4                      |
|`-q`  | video quality ( based on height )        | -q 1080                     |
|`-yt` | yt-dlp parameters                        | -yt bv+ba/best              |
|`-ff` | ffmpeg postprocessor arguments           | -ff "-c:v libx265 -c:a aac" |

**Example:**

`https://youtube.com/video -f mp4 -q 1080 -yt bv+ba/best -ff "-c:v libx265"`

### Settings

Configure the extension through Vicinae's preferences:

1. **Download Directory** (Default is `~/Downloads`)
2. **Default Video/Audio Format**
3. **Custom Domain Configuration**: Directory containing `domain-config.txt`

### Domain Configuration

**Priority order:** Domain config file → Vicinae preferences → Built-in defaults

**Setup:**
1. Open Vicinae settings for this extension
2. Set **Custom Domain Configuration** to a directory
    
    or leave empty for `~/.config/media-downloader/`

3. Run **"Configure Domains"** command to create/edit the config file

**Config file format** (`domain-config.txt`):
```
# Multiple domains can share settings (comma-separated)
domain1, domain2, ... : yt-dlp="parameters" format="extension" ffmpeg="arguments"

# Examples:
youtube.com, youtu.be: yt-dlp="(bv[vcodec^=av01]/bv[ext=webm]/bv[vcodec^=avc1])+(ba[ext=m4a]/ba)" format="mp4"

instagram.com: ffmpeg="-c:v copy -c:a aac"

twitter.com, x.com: format="mp4"

vimeo.com: yt-dlp="bestvideo+bestaudio/best"
```
## Troubleshooting

**❌ Download failed** - A few reasons that could cause this error:
1. Invalid URL
2. No access to this video
3. Conflict between the stream codec and the container into which they are being placed.
    
    The extension uses remux to change containers at the user's request. That is, the original video streams are not recoded for the new container (this would take a lot of time and resources). To avoid conflicts between stream and container codecs, you should check or study the typical formats of the service from which you are trying to download the media file.

4. Just try again
