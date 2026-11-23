import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  VisionFetcher,
  selectStoryboardLayout,
  computeTileDimensions,
  extractLocalGifPaths,
  buildAnimatedStoryboardHint
} from '../src/media/vision-fetcher.js';

const execFileAsync = promisify(execFile);

function resolveTestFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  try {
    const cfgPath = path.resolve(import.meta.dirname, '..', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg?.vision?.ffmpegPath && fs.existsSync(cfg.vision.ffmpegPath)) {
        return cfg.vision.ffmpegPath;
      }
    }
  } catch {
    // ignore local config lookup failure
  }
  return 'ffmpeg';
}

function readPngDimensions(buf) {
  // PNG IHDR chunk width (bytes 16..19) & height (bytes 20..23) big-endian
  assert.equal(buf[0], 0x89);
  assert.equal(buf[1], 0x50);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  };
}

test('selectStoryboardLayout & computeTileDimensions choose adaptive grids cleanly', () => {
  assert.equal(selectStoryboardLayout(1), null);
  assert.deepEqual(selectStoryboardLayout(2), {
    cols: 2,
    rows: 1,
    layout: '2x1',
    indices: [0, 1],
    sampledFrames: 2
  });
  assert.deepEqual(selectStoryboardLayout(3), {
    cols: 3,
    rows: 1,
    layout: '3x1',
    indices: [0, 1, 2],
    sampledFrames: 3
  });
  assert.deepEqual(selectStoryboardLayout(5), {
    cols: 2,
    rows: 2,
    layout: '2x2',
    indices: [0, 1, 3, 4],
    sampledFrames: 4
  });
  assert.deepEqual(selectStoryboardLayout(30), {
    cols: 3,
    rows: 2,
    layout: '3x2',
    indices: [0, 6, 12, 17, 23, 29],
    sampledFrames: 6
  });
  assert.equal(selectStoryboardLayout(30, { maxFrames: 4 }).layout, '2x2');

  const portrait = computeTileDimensions(360, 640, 3, { maxTileSide: 320 });
  assert.deepEqual(portrait, { width: 180, height: 320 });
  const tiny = computeTileDimensions(64, 64, 3, { maxTileSide: 320 });
  assert.deepEqual(tiny, { width: 128, height: 128 });
});

test('extractLocalGifPaths finds existing quoted/bare GIF files and ignores non-GIF or missing paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-localgif-'));
  try {
    const spacedDir = path.join(dir, 'my gifs');
    fs.mkdirSync(spacedDir, { recursive: true });
    const gif1 = path.join(spacedDir, 'heart anim.gif');
    const gif2 = path.join(dir, 'wink.gif');
    const png1 = path.join(dir, 'static.png');
    fs.writeFileSync(gif1, Buffer.from('GIF89a123456'));
    fs.writeFileSync(gif2, Buffer.from('GIF89a654321'));
    fs.writeFileSync(png1, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]));

    const text = `"${gif1}" 这张也送给你，还有 ${gif2} 以及 ${png1} 和 C:\\does-not-exist\\nope.gif`;
    const found = extractLocalGifPaths(text);
    assert.deepEqual(found, [path.normalize(gif1), path.normalize(gif2)]);

    const hint = buildAnimatedStoryboardHint([
      {
        isLocalGifPreview: true,
        animation: { isAnimated: true, frameCount: 30, durationSec: 3.0, sampledFrames: 6, cols: 3, rows: 2, layout: '3x2' }
      }
    ]);
    assert.match(hint, /动图时序分镜说明/);
    assert.match(hint, /3×2/);
    assert.match(hint, /1→6/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VisionFetcher turns multi-frame GIF into distinct-frame 3x2 PNG storyboard while keeping original GIF bytes', async (t) => {
  const ffmpeg = resolveTestFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-gifsheet-'));
  try {
    // Generate a 6-frame animated GIF where each frame has a distinct solid color
    const animGif = path.join(dir, 'six-colors.gif');
    const staticGif = path.join(dir, 'one-frame.gif');
    try {
      await execFileAsync(
        ffmpeg,
        [
          '-y', '-v', 'error',
          '-f', 'lavfi', '-i', 'color=c=red:s=120x120:d=0.4:r=5',
          '-f', 'lavfi', '-i', 'color=c=green:s=120x120:d=0.4:r=5',
          '-f', 'lavfi', '-i', 'color=c=blue:s=120x120:d=0.4:r=5',
          '-f', 'lavfi', '-i', 'color=c=yellow:s=120x120:d=0.4:r=5',
          '-f', 'lavfi', '-i', 'color=c=magenta:s=120x120:d=0.4:r=5',
          '-f', 'lavfi', '-i', 'color=c=cyan:s=120x120:d=0.4:r=5',
          '-filter_complex', '[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=6:v=1:a=0',
          animGif
        ],
        { timeout: 15000, windowsHide: true }
      );
      await execFileAsync(
        ffmpeg,
        ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=120x120:d=0.1:r=10', '-frames:v', '1', staticGif],
        { timeout: 10000, windowsHide: true }
      );
    } catch {
      t.skip('FFmpeg unavailable in test environment');
      return;
    }

    const configStore = {
      get: () => ({
        vision: {
          enabled: true,
          maxImagesPerTurn: 4,
          maxImageBytes: 8 * 1024 * 1024,
          ffmpegPath: ffmpeg,
          gifStoryboardEnabled: true,
          gifMaxFrames: 6,
          gifTileMaxSide: 200
        }
      })
    };
    const fetcher = new VisionFetcher(configStore, dir);

    // 1. Animated 6-frame GIF -> 3x2 storyboard PNG, original buffer stays GIF
    const animRes = await fetcher.fetchImageBuffer({ file: animGif });
    assert.equal(animRes.originalMimeType, 'image/gif');
    assert.equal(animRes.mimeType, 'image/png');
    assert.equal(animRes.buffer.subarray(0, 4).toString('ascii'), 'GIF8');
    assert.ok(animRes.animation?.isAnimated);
    assert.equal(animRes.animation.frameCount, 12);
    assert.equal(animRes.animation.layout, '3x2');
    assert.equal(animRes.animation.sampledFrames, 6);

    const pngBuf = Buffer.from(animRes.base64, 'base64');
    const dims = readPngDimensions(pngBuf);
    // Tile is 200x200 (120 * min(200/120, 2) = 200), 3x2 + padding(8*2) + margin(8*2) => 632x424
    assert.equal(dims.width, 632);
    assert.equal(dims.height, 424);

    // Verify top-left tile center (red) differs from bottom-right tile center (cyan) — proves NO frame duplication!
    const sheetPath = path.join(dir, 'sheet.png');
    fs.writeFileSync(sheetPath, pngBuf);
    const { stdout: rawRgb } = await execFileAsync(
      ffmpeg,
      ['-v', 'error', '-i', sheetPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    );
    const pixelAt = (x, y) => {
      const off = (y * dims.width + x) * 3;
      return [rawRgb[off], rawRgb[off + 1], rawRgb[off + 2]];
    };
    const tile1 = pixelAt(110, 110); // frame 1: red
    const tile6 = pixelAt(520, 320); // frame 6: cyan
    assert.ok(tile1[0] > 200 && tile1[1] < 50 && tile1[2] < 50, `Expected tile 1 red, got ${tile1}`);
    assert.ok(tile6[0] < 50 && tile6[1] > 200 && tile6[2] > 200, `Expected tile 6 cyan, got ${tile6}`);

    // 2. Static 1-frame GIF -> single PNG, NOT tiled
    const staticRes = await fetcher.fetchImageBuffer({ file: staticGif });
    assert.equal(staticRes.mimeType, 'image/png');
    assert.equal(staticRes.animation, null);
    const staticDims = readPngDimensions(Buffer.from(staticRes.base64, 'base64'));
    assert.equal(staticDims.width, 120);
    assert.equal(staticDims.height, 120);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
