import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(outDir, { recursive: true });

const NAVY = [28, 75, 150, 255];
const WHITE = [255, 255, 255, 255];

function crc(buf) {
  if (typeof crc32 === 'function') return crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, crcBuf]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function setPixel(pixels, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  pixels[i] = color[0];
  pixels[i + 1] = color[1];
  pixels[i + 2] = color[2];
  pixels[i + 3] = color[3];
}

function inRoundRect(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || y < y0 || x >= x1 || y >= y1) return false;
  const cx0 = x0 + radius;
  const cy0 = y0 + radius;
  const cx1 = x1 - radius - 1;
  const cy1 = y1 - radius - 1;
  if (x < cx0 && y < cy0) return (x - cx0) ** 2 + (y - cy0) ** 2 <= radius ** 2;
  if (x > cx1 && y < cy0) return (x - cx1) ** 2 + (y - cy0) ** 2 <= radius ** 2;
  if (x < cx0 && y > cy1) return (x - cx0) ** 2 + (y - cy1) ** 2 <= radius ** 2;
  if (x > cx1 && y > cy1) return (x - cx1) ** 2 + (y - cy1) ** 2 <= radius ** 2;
  return true;
}

function fillRoundRect(pixels, size, x0, y0, x1, y1, radius, color) {
  const minX = Math.max(0, Math.floor(x0));
  const minY = Math.max(0, Math.floor(y0));
  const maxX = Math.min(size, Math.ceil(x1));
  const maxY = Math.min(size, Math.ceil(y1));
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      if (inRoundRect(x, y, x0, y0, x1, y1, radius)) setPixel(pixels, size, x, y, color);
    }
  }
}

function fill(pixels, color) {
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = color[0];
    pixels[i + 1] = color[1];
    pixels[i + 2] = color[2];
    pixels[i + 3] = color[3];
  }
}

function drawIcon(size, { pad = 0 } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  fill(pixels, NAVY);
  const inset = Math.round(size * pad);
  const box = size - inset * 2;
  const x0 = inset;
  const y0 = inset;
  const x1 = inset + box;
  const y1 = inset + box;
  const radius = Math.max(8, Math.round(box * 0.18));
  const stroke = Math.max(2, Math.round(box * 0.055));
  fillRoundRect(pixels, size, x0, y0, x1, y1, radius, WHITE);
  fillRoundRect(
    pixels,
    size,
    x0 + stroke,
    y0 + stroke,
    x1 - stroke,
    y1 - stroke,
    Math.max(4, radius - stroke),
    NAVY
  );

  const inner = box - stroke * 2;
  const originX = x0 + stroke;
  const originY = y0 + stroke;
  const barW = inner * (4.2 / 29.2);
  const gapStart = inner * (7 / 29.2);
  const bars = [
    { x: gapStart, y: inner * (17 / 29.2), h: inner * (8 / 29.2) },
    { x: inner * (13.9 / 29.2), y: inner * (9 / 29.2), h: inner * (16 / 29.2) },
    { x: inner * (20.8 / 29.2), y: inner * (12.5 / 29.2), h: inner * (12.5 / 29.2) },
  ];
  const barRadius = Math.max(2, barW * 0.22);
  for (const bar of bars) {
    fillRoundRect(
      pixels,
      size,
      originX + bar.x,
      originY + bar.y,
      originX + bar.x + barW,
      originY + bar.y + bar.h,
      barRadius,
      WHITE
    );
  }
  return pixels;
}

function writeIcon(name, size, options) {
  const file = join(outDir, name);
  writeFileSync(file, encodePng(size, drawIcon(size, options)));
  console.log(`wrote ${file}`);
}

writeIcon('icon-192.png', 192);
writeIcon('icon-512.png', 512);
writeIcon('icon-192-maskable.png', 192, { pad: 0.12 });
writeIcon('icon-512-maskable.png', 512, { pad: 0.12 });
writeIcon('apple-touch-icon.png', 180);
