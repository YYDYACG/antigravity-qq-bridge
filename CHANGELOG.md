# Changelog

All notable changes to **Antigravity QQ Bridge** are documented in this file.

## [1.0.0] - 2026-11-24

Initial public release of **Antigravity QQ Bridge** (`v1.0.0`) and **Antigravity 2.0 (AGY 2) Sidebar Plugin** (`agyqq-hub v1.2.2`).

### Highlights
- **Cross-Platform One-Click Installer (`scripts/install.mjs`, `install.bat`, `install.ps1`)**:
  - Interactive & non-interactive (`--yes`) setup with `--dry-run`, pre-flight Node/`agy`/FFmpeg checks, non-destructive `config.json` generation, optional GPT-SoVITS v5 & L2 MemeWiki initialization, and automatic Antigravity 2.0 (`AGY 2`) plugin install + `AGYQQ_BRIDGE_DIR` binding + `dist/app.html` build.
- **Persistent Dual-Lane ACP Core (`agy acp --stdio`)**: Zero-cold-start dual workers with separate Owner workspace lane and sandboxed Group lane (`--sandbox` + 4-layer Owner Guard).
- **Adjustable Context Budget & Seamless Compaction**: Configurable per-session token budget (`16K`–`2M`, or `0` unlimited) with live slider, quick presets (`64K` / `128K` / `256K` / `512K` / `1M` / unlimited), `maxPromptChars` control, and background Scheme A memory handoff (`data/session-summaries/`).
- **Full-Scenario Multimodal Vision, Forwards & Bilibili**:
  - Native image & quoted image understanding plus FFmpeg GIF temporal storyboards (`2×1`–`3×2`);
  - 6-hour ambient group message buffer with `[HH:MM]` timestamps and back-reference image/forward carryover;
  - Safe `get_forward_msg` merged-forward expansion (text, numbered images/GIFs, nested depth ≤ 2, Bilibili links);
  - Public read-only Bilibili card & link resolver (cover art, real UP author, full description, stats, pinned & hot comments, SSRF & prompt-injection guard).
- **3-Layer Meme & Living Lorebook System**:
  - L1 SQLite Living Lorebook with SillyTavern World Info JSON import/export (🔵 constant / 🟢 keyword / secondary filter / cooldown / scope isolation);
  - Optional L2 Read-only Meme Encyclopedia (`data/memes.db`, 6,792+ entries from `dsh-memewiki` / `cnmeme.wiki`) with `<1ms` lookup, 0-token incremental sync, one-click promote to L1, and `0–100` playful banter (`串子程度`) slider;
  - L3 on-demand `search_web` fallback with silent `[词条:...]` backfill into L1.
- **OneBot v11 Anti-Ban & Natural Group Rhythm**: Forward-WS & Reverse-WS support, smart debounce merge window, natural chunked replies, active follow-up window, peer-bot anti-ping-pong & nickname avoidance, consecutive `[静默]` auto-exit, and risk backoff.
- **GPT-SoVITS v5 6-Emotion TTS & 5D Sticker Library**: Dual-track instant text + async background voice delivery, SHA-256 audio cache, 13 v5 inference parameters, automatic CUDA prewarm, and SQLite 2-gram + vision-curated sticker warehouse.
- **Antigravity Hub & Antigravity 2.0 Sidebar MCP App (`agyqq-hub v1.2.2`)**: Live WebUI console with token auth, Simulator playground, one-click service launch, and direct sidebar/global-view NapCatQQ QR login launcher (via `app.openLink` bridge with localhost-only non-detached `Start-Process` server fallback).
