#!/usr/bin/env bun
// Draws the menu bar icon (a belt with a buckle) as a macOS template PNG: black + alpha,
// 36×36 px for an 18 pt status item. No image tools needed: shapes are rasterized with 8×8
// supersampling and written as a PNG by hand. Run: bun scripts/make-icons.ts
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

type Shape = (x: number, y: number) => boolean;
const roundRect = (x0: number, y0: number, x1: number, y1: number, r: number): Shape => (x, y) => {
	if (x < x0 || x > x1 || y < y0 || y > y1) return false;
	const cx = Math.min(Math.max(x, x0 + r), x1 - r);
	const cy = Math.min(Math.max(y, y0 + r), y1 - r);
	return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const circle = (cx: number, cy: number, r: number): Shape => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const minus = (a: Shape, ...b: Shape[]): Shape => (x, y) => a(x, y) && !b.some((s) => s(x, y));
const union = (...s: Shape[]): Shape => (x, y) => s.some((f) => f(x, y));

function render(size: number, shape: Shape, scale: number) {
	const ss = 8;
	const px = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			let hit = 0;
			for (let sy = 0; sy < ss; sy++)
				for (let sx = 0; sx < ss; sx++) if (shape((x + (sx + 0.5) / ss) / scale, (y + (sy + 0.5) / ss) / scale)) hit++;
			px[(y * size + x) * 4 + 3] = Math.round((255 * hit) / (ss * ss));
		}
	return px;
}

function png(size: number, rgba: Uint8Array) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (b: Uint8Array) => {
		let c = 0xffffffff;
		for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Uint8Array) => {
		const out = new Uint8Array(12 + data.length);
		const dv = new DataView(out.buffer);
		dv.setUint32(0, data.length);
		out.set(new TextEncoder().encode(type), 4);
		out.set(data, 8);
		dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
		return out;
	};
	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, size);
	dv.setUint32(4, size);
	ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
	const raw = new Uint8Array(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
	const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
	return Buffer.concat(parts);
}

// Drawn on an 18×18 grid (points).
const buckle = minus(roundRect(5.5, 3.5, 12.5, 14.5, 2), roundRect(7.3, 5.3, 10.7, 12.7, 0.8));
const prong = roundRect(8.4, 7.9, 12.5, 10.1, 0.6);
const band = minus(union(roundRect(0.5, 6.5, 6, 11.5, 1.6), roundRect(12, 6.5, 17.5, 11.5, 1.6)), circle(14.2, 9, 0.85), circle(16.2, 9, 0.85));
const belt = union(band, buckle, prong);

mkdirSync("assets", { recursive: true });
for (const [name, size] of [["tray-icon.png", 18], ["tray-icon@2x.png", 36]] as const) {
	writeFileSync(`assets/${name}`, png(size, render(size, belt, size / 18)));
	console.log(`assets/${name}`);
}
