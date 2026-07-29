#!/usr/bin/env bun
/**
 * Draw PartyBooth's launch icon set, from code, with no dependencies.
 *
 * ## Why this exists
 *
 * `create-expo-app` leaves four generic placeholder PNGs in `apps/mobile/assets`,
 * and App Store Connect rejects a build whose icon is the template. Real icon
 * artwork is a design job that is not happening in the eight days before the
 * party, so this is the honest middle: a **deliberate** mark — solid brand
 * accent, one white camera glyph — that is unmistakably ours, renders cleanly
 * from 1024 px down to 48, and can be replaced by an artist later without a
 * single code change.
 *
 * It is checked in as a script rather than run once and forgotten so that
 * "regenerate the icons" is a command rather than an archaeology exercise:
 *
 * ```bash
 * bun run icons          # rewrites apps/mobile/assets/*.png
 * ```
 *
 * ## Why no `sharp`, no `canvas`, no SVG rasteriser
 *
 * The repo-wide constraint is that everything builds and tests **offline**, and
 * every one of those is a native module or a network fetch away. PNG is a
 * genuinely small format — signature, `IHDR`, one deflated `IDAT`, `IEND` — and
 * Node ships `zlib`. What is below is about sixty lines of encoder and a
 * signed-distance rasteriser; that is a smaller liability than a native
 * image dependency added in launch week.
 *
 * ## The two things that are requirements rather than taste
 *
 * - **The iOS marketing icon has no alpha channel.** App Store Connect refuses a
 *   1024×1024 with transparency, and the rejection arrives *after* upload. So
 *   `icon.png` is written as colour type 2 (RGB) with the accent composited in,
 *   not as RGBA-over-nothing.
 * - **The Android adaptive foreground must live inside the safe zone.** The
 *   launcher masks the outer ~1/3 to whatever shape the OEM likes, so the glyph
 *   is drawn at 62 % of the canvas with the rest empty. `adaptiveIcon.
 *   backgroundColor` in `app.config.ts` supplies the same accent, which is why
 *   the lens and flash are punched *through* the glyph rather than filled dark:
 *   the hole shows the background on every surface, whatever it happens to be.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "apps", "mobile", "assets");

/* -------------------------------------------------------------------------- */
/* Palette — the same tokens as apps/mobile/src/theme                          */
/* -------------------------------------------------------------------------- */

const ACCENT = [0xff, 0x2e, 0x88];
const GLYPH = [0xff, 0xf4, 0xf9];

/* -------------------------------------------------------------------------- */
/* PNG                                                                        */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * Encode raw samples as a PNG.
 *
 * `channels` is 3 (RGB) or 4 (RGBA) and picks the colour type. Filter byte 0
 * ("none") on every scanline: these are flat-colour images, so the adaptive
 * filters would cost CPU to save nothing, and a filter bug is invisible until
 * something else tries to decode the file.
 */
function encodePng(width, height, channels, samples) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(samples.buffer, samples.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type: RGBA or RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Shapes, in a 0–1 square                                                    */
/* -------------------------------------------------------------------------- */

/** Distance from `(x, y)` to a rounded rectangle. Negative inside. */
function roundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance from `(x, y)` to a circle. Negative inside. */
function circle(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) - radius;
}

/**
 * Is this point part of the camera glyph?
 *
 * Body plus viewfinder bump, with the lens and the flash punched **out** so the
 * background shows through them. That is what lets one glyph sit on the solid
 * accent (iOS), on the adaptive background (Android) and on the dark splash
 * without three different drawings.
 *
 * Coordinates are a 0–1 square with the glyph occupying the middle; the caller
 * scales it, so the safe-zone rule is one multiplication rather than a second
 * set of numbers.
 */
function insideGlyph(x, y) {
  const body = roundedRect(x, y, 0.5, 0.545, 0.375, 0.27, 0.085);
  const bump = roundedRect(x, y, 0.355, 0.29, 0.115, 0.06, 0.045);
  const lens = circle(x, y, 0.5, 0.55, 0.155);
  const flash = circle(x, y, 0.755, 0.375, 0.038);

  const solid = Math.min(body, bump);
  // Subtraction is a max against the negated hole — the standard CSG trick, and
  // the reason the holes have the same antialiased edge as the outline.
  return Math.max(solid, -lens, -flash) < 0;
}

/* -------------------------------------------------------------------------- */
/* Rasterising                                                                */
/* -------------------------------------------------------------------------- */

const SUPERSAMPLE = 4;

/**
 * Coverage of the glyph per pixel, 0–255.
 *
 * Supersampled 4×4 and box-filtered rather than evaluated analytically: the
 * shapes are a union of a subtraction, so an exact coverage integral is real
 * work, and 16 samples per pixel of a 1024² image is a few hundred milliseconds
 * once.
 *
 * `scale` shrinks the glyph about the centre — 1 fills the tile, 0.62 keeps it
 * inside Android's adaptive-icon safe zone.
 */
function rasterise(size, scale) {
  const alpha = new Uint8Array(size * size);
  const step = 1 / (size * SUPERSAMPLE);
  const half = step / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const u = (px * SUPERSAMPLE + sx) * step + half;
          const v = (py * SUPERSAMPLE + sy) * step + half;
          // Map the tile back onto the glyph's own 0–1 space.
          const gx = (u - 0.5) / scale + 0.5;
          const gy = (v - 0.5) / scale + 0.5;
          if (insideGlyph(gx, gy)) hits += 1;
        }
      }
      alpha[py * size + px] = Math.round((hits / (SUPERSAMPLE * SUPERSAMPLE)) * 255);
    }
  }
  return alpha;
}

/** Glyph over a solid background, flattened to RGB. No alpha channel at all. */
function opaqueIcon(size, scale, background) {
  const alpha = rasterise(size, scale);
  const out = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i += 1) {
    const a = alpha[i] / 255;
    for (let c = 0; c < 3; c += 1) {
      out[i * 3 + c] = Math.round(background[c] * (1 - a) + GLYPH[c] * a);
    }
  }
  return encodePng(size, size, 3, out);
}

/** Glyph on nothing, as RGBA. Whatever is behind it shows through the holes. */
function transparentIcon(size, scale) {
  const alpha = rasterise(size, scale);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4 + 0] = GLYPH[0];
    out[i * 4 + 1] = GLYPH[1];
    out[i * 4 + 2] = GLYPH[2];
    out[i * 4 + 3] = alpha[i];
  }
  return encodePng(size, size, 4, out);
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

const outputs = [
  {
    file: "icon.png",
    // 1024², **no alpha** — App Store Connect rejects a transparent marketing
    // icon, and it rejects it after the upload rather than before.
    build: () => opaqueIcon(1024, 0.78, ACCENT),
    note: "iOS marketing icon (1024², opaque)",
  },
  {
    file: "adaptive-icon.png",
    // 0.62 keeps every pixel inside the circle an OEM launcher may mask to.
    build: () => transparentIcon(1024, 0.62),
    note: "Android adaptive foreground (safe-zone scaled)",
  },
  {
    file: "splash-icon.png",
    build: () => transparentIcon(1024, 0.7),
    note: "splash mark",
  },
  {
    file: "favicon.png",
    build: () => opaqueIcon(48, 0.8, ACCENT),
    note: "web favicon",
  },
];

mkdirSync(assets, { recursive: true });
for (const output of outputs) {
  const png = output.build();
  writeFileSync(join(assets, output.file), png);
  process.stdout.write(
    `  ${output.file.padEnd(20)} ${String(png.length).padStart(7)} B  ${output.note}\n`,
  );
}
process.stdout.write(`\nWrote ${outputs.length} icons to apps/mobile/assets.\n`);
