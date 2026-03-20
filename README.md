# TUIDAW

A full-featured TUI Digital Audio Workstation built with [OpenTUI](https://opentui.com) and [miniaudio](https://miniaud.io).

Practice guitar at half speed without pitch shift. Record multi-track audio. Export mixdowns. All from your terminal.

> **Note:** This project is vibecoded -- built entirely through AI-assisted development for personal use on Arch Linux. It works on my machine, but there are no guarantees of support for other platforms or distributions. Contributions and bug reports welcome.

## Features

- **Braille waveform display** -- 2x4 dot grid rendering, real-time level meters
- **Native audio engine** -- miniaudio C library via Bun FFI, zero-latency parameter changes
- **WSOLA time-stretch** -- pitch-preserving speed control (0.25x - 2.0x)
- **Multi-track recording** -- simultaneous capture with per-track input device selection
- **Metronome click** -- sample-accurate, configurable volume and pan
- **Loop regions** -- sample-accurate looping
- **Beat-based timeline** -- navigate by beats/bars, auto BPM detection on import
- **WAV import** -- 16/24/32-bit, stereo downmix, automatic 48kHz resampling
- **Project save/open** -- `.tuidaw` project files
- **Export mixdown** -- WAV export with WSOLA stretch, click track, per-track volume/pan
- **Mouse controls** -- scroll, volume, pan via mouse wheel

## Requirements

- [Bun](https://bun.sh) (JavaScript runtime)
- Linux (x86_64 or aarch64) or macOS (x86_64 or aarch64)
- A terminal with Unicode support (Ghostty, Kitty, Alacritty, WezTerm, etc.)
- **ffmpeg** -- for export mixdown
- **zenity** -- for file dialogs (Linux only)

### Arch Linux

```bash
sudo pacman -S bun ffmpeg zenity
```

### Ubuntu / Debian

```bash
curl -fsSL https://bun.sh/install | bash
sudo apt install ffmpeg zenity
```

### macOS

```bash
brew install oven-sh/bun/bun ffmpeg
```

## Quick Start

```bash
git clone https://github.com/crossatko/tuidaw.git
cd tuidaw
./setup.sh
bun run start
```

The setup script will:

1. Check for required system dependencies
2. Download the Zig 0.14.0 toolchain (used to compile the native audio library)
3. Install JS dependencies (`bun install`)
4. Build the native audio library (`libtuidaw_audio.so`)

### Pre-built binary (x86_64 Linux)

If you're on x86_64 Linux, the repo ships a pre-built `native/libtuidaw_audio.so`. You can skip the native build:

```bash
git clone https://github.com/crossatko/tuidaw.git
cd tuidaw
bun install
bun run start
```

### Rebuilding the native library

If you modify `native/tuidaw_audio.c` or need to build for your platform:

```bash
./setup.sh        # downloads Zig if needed, then builds
# or, if Zig is already set up:
cd native && ./build.sh
```

## Keyboard Shortcuts

Press **F1** in-app for the full reference. Key shortcuts:

| Key              | Action                                      |
| ---------------- | ------------------------------------------- |
| `Space`          | Play / Stop (record if tracks armed)        |
| `A`              | Add track                                   |
| `D`              | Delete track (two-step: clear, then delete) |
| `R`              | Arm/disarm track for recording              |
| `M`              | Mute/unmute track                           |
| `S`              | Solo/unsolo track                           |
| `C`              | Toggle metronome click                      |
| `+` / `-`        | Adjust BPM (changes speed via WSOLA)        |
| `<` / `>`        | Pan left / right                            |
| `V`              | Cycle volume (25/50/75/100%)                |
| `Up` / `Down`    | Select track                                |
| `Left` / `Right` | Scroll timeline (Shift: by bar)             |
| `[` / `]`        | Scrub playhead by 1 bar                     |
| `Home` / `0`     | Jump to beginning                           |
| `End`            | Jump to end                                 |
| `F1`             | Help overlay                                |
| `F2`             | Select input device                         |
| `F3`             | Select output device                        |
| `F5`             | Save project                                |
| `F6`             | Open project                                |
| `I`              | Import WAV                                  |
| `E`              | Export mixdown                              |
| `Q`              | Quit                                        |

## Mouse Controls

| Area              | Action       | Effect                    |
| ----------------- | ------------ | ------------------------- |
| Main waveform     | Scroll wheel | Scroll timeline by beats  |
| Main timeline     | Click        | Set playhead position     |
| Sidebar track     | Scroll wheel | Adjust volume             |
| Sidebar pan zone  | Scroll wheel | Adjust pan                |
| Sidebar click row | Scroll wheel | Adjust click volume / pan |

## Architecture

- **`index.ts`** -- main entry, transport logic, keyboard/mouse handling
- **`src/ui.ts`** -- OpenTUI rendering (top bar, sidebar, waveforms, overlays)
- **`src/audio-engine.ts`** -- Bun FFI bridge to native library, WAV I/O, BPM detection, export
- **`src/braille.ts`** -- braille waveform renderer
- **`src/state.ts`** -- state management
- **`src/types.ts`** -- type definitions and constants
- **`native/tuidaw_audio.c`** -- C audio engine wrapping miniaudio (32 exported functions)
- **`native/miniaudio.h`** -- [miniaudio](https://miniaud.io) single-header library (Public Domain / MIT-0)

## License

MIT License. See [LICENSE](LICENSE).

miniaudio is dual-licensed under Public Domain (Unlicense) and MIT No Attribution.
