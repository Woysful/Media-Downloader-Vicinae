# Media Downloader [Vicinae extension]

A [yt-dlp](https://github.com/yt-dlp/yt-dlp) based downloader for [Vicinae](https://github.com/vicinaehq/vicinae): video and audio from YouTube and hundreds of other sites, with per-site settings.

![](https://github.com/user-attachments/assets/260c6e74-7897-4577-9c46-68c82630c23d)

> Originally a port of a plugin made for [Flow Launcher](https://github.com/woysful/media-downloader-FlowLauncher).

## Features

- Quick commands that take a URL plus optional keys, and a **New Download** form with every option
- Progress in Vicinae's status bar: percent, speed, ETA, playlist position and post-processing stage
- Downloads keep running when you close Vicinae or start another command
- Single video by default; whole playlists only with `-p`, saved into their own folder
- Editing compatibility mode against dropped frames in video editors
- Per-domain settings file
- yt-dlp is downloaded automatically when it is not installed, and kept up to date

## Requirements

- **ffmpeg** (and ffprobe, which ships with it): `sudo pacman -S ffmpeg`, `sudo apt install ffmpeg`, `brew install ffmpeg`, ...
- **yt-dlp** is optional. If it is not on your `PATH`, the extension downloads the official build into its own data folder and runs `yt-dlp -U` at most once a day. A system yt-dlp is never touched; keep it updated yourself (old versions are the main cause of failed downloads).

## Installation

Download [`media-downloader.tar.gz`](https://github.com/Woysful/Media-Downloader-Vicinae/releases/latest/download/media-downloader.tar.gz), extract it and put the `media-downloader` folder into the extensions folder.

Or build it yourself:

```bash
git clone https://github.com/Woysful/Media-Downloader-Vicinae.git
cd ./Media-Downloader-Vicinae
npm install
npm run build
```

> The extension is built to `~/.local/share/vicinae/extensions/media-downloader/`

## Commands

| Command | What it does |
|:--|:--|
| `Video` | Downloads a video using your settings (keys > domain rule > preferences) |
| `Audio` | Downloads audio and converts it to the chosen format |
| `Video Best` | Best quality, original codecs and container, no remux |
| `Audio Best` | Best audio, converted to WAV |
| `New Download` | Form with all options. Shows which domain rule and settings will be used, live status and a cancel action |
| `Cancel Download` | Stops every running download of this extension (only its own yt-dlp/ffmpeg processes) and removes partial files |
| `Configure Domains` | Opens `domain-config.txt`, creating it with documentation first |

## Keys

Type keys after the URL (or before it). Values with spaces must be quoted, with `'single'` or `"double"` quotes.

| Key | Long form | Description | Example |
|:--|:--|:--|:--|
| `-f` | `--format` | Video container, or audio format for `Audio` | `-f mkv`, `-f mp3` |
| `-q` | `--quality` | Maximum video height | `-q 1080` |
| `-yt` | `--yt-dlp` | yt-dlp format selector | `-yt 'bv*[vcodec^=avc1]+ba/b'` |
| `-ff` | `--ffmpeg` | ffmpeg arguments for merging/remuxing (audio: extraction; `-e`: appended to the encoder arguments) | `-ff '-c:a aac'` |
| `-a` | `--args` | Any extra yt-dlp arguments | `-a '--limit-rate 5M'` |
| `-p` | `--playlist` | Download the whole playlist | `-p` |
| `-e` | `--edit` | Re-encode for video editors (H.264/AAC MP4, constant frame rate) | `-e` |

`Video Best` and `Audio Best` accept `-p` and `-a`.

> **Example:** `https://youtube.com/watch?v=... -q 1080 -f mp4 -ff '-c:a aac'`

### Playlists

Without `-p` only one video is downloaded, even from a link like `watch?v=...&list=...`. For a link that points to a playlist only, the first item is downloaded and the status tells you to add `-p`.

With `-p` the files go into a folder named after the playlist: `Playlist Title/001 - Video Title.mp4`. Both templates can be changed in the preferences.

### Video editors and dropped frames

Downloaded videos often stutter or drop frames in editors (DaVinci Resolve, Premiere, Kdenlive, ...). The usual reasons are AV1/VP9 streams, MKV's millisecond timestamps and a variable frame rate in the source. The **Editing Compatibility** preference controls this:

- **Prefer H.264/AAC** (default): picks H.264/AAC streams when the site offers them at the same resolution. No re-encoding, so it is fast, but it cannot fix a variable frame rate.
- **Always re-encode**: converts the result to H.264/AAC MP4 with a constant frame rate (VFR averages are snapped to 23.976/24/25/29.97/30/50/59.94/60). Slow, but the file behaves like camera footage. The encoder settings are in the **Re-encode Arguments** preference (`-c:v libx264 -preset medium -crf 18 ...` by default).
- **Keep original streams**: whatever the site serves.

`-e` turns on re-encoding for a single download; `compat="reencode"` in the domain config turns it on for a site.

## Preferences

| Preference | Notes |
|:--|:--|
| Download Directory | Empty means your XDG download folder (usually `~/Downloads`) |
| Video Container, Video Quality, yt-dlp Video Format | Defaults for `Video` |
| Editing Compatibility, Re-encode Arguments | See above |
| Audio Format, Audio Quality | Defaults for `Audio` |
| Embed metadata / thumbnail | Thumbnails are embedded only into containers that support cover art |
| Cookies From Browser | For age-restricted, private and members-only videos |
| Extra yt-dlp Arguments | Added to every download |
| File Name Template, Playlist File Name Template | yt-dlp output templates |
| Domain Config Directory | Empty means `~/.config/media-downloader/` |
| yt-dlp / ffmpeg Executable | Custom binaries. Empty means `PATH`, then the downloaded copy |
| Update the downloaded yt-dlp daily | Only affects the copy downloaded by the extension |
| Desktop notification, Show the file in the file manager | What happens when a download finishes |

## Domain configuration

The file is created automatically on first use, in `~/.config/media-downloader/domain-config.txt` or in the **Domain Config Directory**. Run **Configure Domains** to open it.

**Priority order:** keys typed after the URL → domain config → preferences → built-in defaults.

```
# domain1, domain2: key="value" key='value' ...
youtube.com, youtu.be: quality="1080" format="mp4"
music.youtube.com: audio-format="mp3"
instagram.com: compat="reencode"
twitter.com, x.com: format="mp4"
vimeo.com: yt-dlp="bv*+ba/b" args="--cookies-from-browser firefox"
```

| Key | Meaning |
|:--|:--|
| `yt-dlp` | Format selector for video |
| `format` | Video container |
| `quality` | Maximum video height |
| `ffmpeg` | ffmpeg arguments for merging/remuxing video |
| `compat` | `original`, `prefer` or `reencode` |
| `audio-format` | Format for the `Audio` command |
| `audio-ffmpeg` | ffmpeg arguments for audio extraction |
| `args` | Extra yt-dlp arguments |

A domain also matches its subdomains, and the most specific rule wins, so `music.youtube.com` overrides `youtube.com`. Unknown keys and invalid values are reported in the Vicinae extension log and ignored. See [`domain-config-example.txt`](domain-config-example.txt) for more examples.

## Troubleshooting

- **HTTP Error 403, "Sign in to confirm", age-restricted videos:** update yt-dlp, or set **Cookies From Browser**.
- **"Requested format is not available":** your `-yt` selector or the domain rule's `yt-dlp` value matches nothing on that site. Try without it.
- **Container errors after changing `-f`:** remuxing only changes the container, so codecs must be supported by it (for example, VP9 in AVI is not). Use MP4/MKV, or `-e`.
- **Logs:** each download keeps its yt-dlp output for 3 days in the extension support folder, usually `~/.local/share/vicinae/support/media-downloader/jobs/<id>/output.log`.

## Development

```bash
npm install
npm run dev        # vici develop
npm test           # parser, plan and runner tests
npm run typecheck
```

Downloads are run by `assets/runner.js`, a small standalone Node script started in its own process group. It runs yt-dlp (and the optional ffmpeg re-encode) and writes `state.json`, which the commands read to show progress.
