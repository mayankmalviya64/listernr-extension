# Listenr — Read any page aloud

A Chrome extension that reads the readable text of any web page aloud with synced highlighting and keyboard controls.

## Features

- **Read pages aloud** — Extracts article-style content and reads it with Web Speech API
- **Synced highlighting** — Current block highlights as it's being read; current word highlights word-by-word
- **Voice & speed control** — Choose from system and online voices (Google), adjust playback speed (0.5x–4x)
- **Keyboard shortcuts** — Control playback without opening the popup
- **Click-to-read** — Click any word to jump to that point and start reading
- **Smart extraction** — Skips navigation, sidebars, ads; works on articles, docs, blogs, and more

## Keyboard Shortcuts

- **Alt+Shift+Up** — Increase speed
- **Alt+Shift+Down** — Decrease speed
- **Alt+Shift+Right** — Jump forward one block
- **Alt+Shift+Left** — Jump backward one block
- **Alt+Shift+?** — Play / Pause (customizable at `chrome://extensions/shortcuts`)

## How it works

1. Open any article, blog, or document
2. Click the Listenr icon in the toolbar
3. Select a voice and speed
4. Hit play — or click any word to start reading from there
5. Use keyboard shortcuts for hands-free control

## Architecture

- **manifest.json** — Extension config (v3, MV3 format)
- **background.js** — Service worker; coordinates popup, content script, and speech
- **content.js** — Extracts readable text blocks, handles highlighting and click-to-read
- **popup.html/js** — UI for voice/speed control and playback controls
- **offscreen.html/js** — Web Speech API document; keeps speech alive when popup closes

## Design

See the design prototypes:
- **Listenr Prototype.dc.html** — Full interaction mockup
- **ListenrPopup.dc.html** — Popup UI design

Screenshots in `/screenshots/` show the extension in action.

## Version

0.2.0

## Installation

1. Clone or download this repo
2. Go to `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select the `extension/` folder
5. Pin the extension to your toolbar

---

Made with ♪ for readers and learners.
Love, Mayank ✨
