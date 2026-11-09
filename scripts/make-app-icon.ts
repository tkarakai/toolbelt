#!/usr/bin/env bun
// Draws Toolbelt's app icon — a leather belt with a brass buckle on a graphite macOS squircle —
// into icon.iconset/ (all ten sizes), rasterized with supersampling, no image tools needed.
// Run: bun scripts/make-app-icon.ts
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

type RGBA = [number, number, number, number]; // 0..1, straight alpha
const hex = (h: string, a = 1): RGBA => {
	const n = parseInt(h.slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};
const lerp = (a: RGBA, b: RGBA, t: number): RGBA => a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, t))) as RGBA;
const over = (top: RGBA, under: RGBA): RGBA => {
	const a = top[3] + under[3] * (1 - top[3]);
	if (a === 0) return [0, 0, 0, 0];
	return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a) as RGBA;
};

// Geometry on a 1024 grid (Apple's icon grid: the squircle spans 100…924).
const C = 512, R = 412;
const inSquircle = (x: number, y: number) => Math.abs((x - C) / R) ** 5 + Math.abs((y - C) / R) ** 5 <= 1;
const roundRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number) => {
	if (x < x0 || x > x1 || y < y0 || y > y1) return false;
	const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
	return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const circle = (x: number, y: number, cx: number, cy: number, r: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

const BAND = { x0: 92, x1: 932, y0: 438, y1: 586 };
const BUCKLE = { x0: 330, x1: 556, y0: 318, y1: 706, r: 64, w: 50 };

function color(x: number, y: number): RGBA {
	if (!inSquircle(x, y)) return [0, 0, 0, 0];
	const t = (y - (C - R)) / (2 * R);
	// Graphite background, lighter at the top, with a soft top sheen.
	let c = lerp(hex("#46464f"), hex("#141417"), t);
	if (y < 300) c = over(hex("#ffffff", 0.05 * (1 - y / 300)), c);
	// The belt's shadow on the background.
	if (y > BAND.y1 && y < BAND.y1 + 40) c = over(hex("#000000", 0.35 * (1 - (y - BAND.y1) / 40)), c);

	const inBand = roundRect(x, y, BAND.x0, BAND.y0, BAND.x1, BAND.y1, 30);
	if (inBand) {
		const bt = (y - BAND.y0) / (BAND.y1 - BAND.y0);
		let band = lerp(hex("#c9824a"), hex("#7c4523"), bt);
		if (bt < 0.08) band = lerp(hex("#e0a06a"), band, bt / 0.08); // top edge catches the light
		// Stitching, a dashed line near each edge.
		for (const sy of [BAND.y0 + 22, BAND.y1 - 22]) if (Math.abs(y - sy) < 4 && ((x - BAND.x0) % 34) < 20) band = hex("#f1d3a6", 1);
		// Holes on the free end.
		for (const hx of [690, 762, 834]) {
			if (circle(x, y, hx, C, 19)) band = y < C ? hex("#2a160a") : lerp(hex("#2a160a"), hex("#5a3218"), (y - C) / 19);
		}
		c = over(band, c);
	}

	// Buckle frame: a rounded rectangle ring, polished brass.
	const outer = roundRect(x, y, BUCKLE.x0, BUCKLE.y0, BUCKLE.x1, BUCKLE.y1, BUCKLE.r);
	const inner = roundRect(x, y, BUCKLE.x0 + BUCKLE.w, BUCKLE.y0 + BUCKLE.w, BUCKLE.x1 - BUCKLE.w, BUCKLE.y1 - BUCKLE.w, BUCKLE.r - BUCKLE.w + 8);
	const brass = (bt: number) => (bt < 0.5 ? lerp(hex("#fbe7a1"), hex("#e0b04a"), bt * 2) : lerp(hex("#e0b04a"), hex("#a8771f"), (bt - 0.5) * 2));
	if (outer && !inner) {
		c = over(hex("#000000", 0.25), c); // a hint of shadow under the metal
		c = over(brass((y - BUCKLE.y0) / (BUCKLE.y1 - BUCKLE.y0)), c);
	}
	// The prong, from the frame's left bar across the band.
	if (roundRect(x, y, BUCKLE.x0 + 20, C - 17, 640, C + 17, 17)) c = over(brass((y - (C - 17)) / 34), c);
	return c;
}

function render(size: number) {
	const ss = size >= 512 ? 3 : size >= 128 ? 4 : 8;
	const scale = 1024 / size;
	const px = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let sy = 0; sy < ss; sy++)
				for (let sx = 0; sx < ss; sx++) {
					const c = color((x + (sx + 0.5) / ss) * scale, (y + (sy + 0.5) / ss) * scale);
					r += c[0] * c[3];
					g += c[1] * c[3];
					b += c[2] * c[3];
					a += c[3];
				}
			const i = (y * size + x) * 4;
			const n = ss * ss;
			px[i + 3] = Math.round((a / n) * 255);
			if (a > 0) {
				px[i] = Math.round((r / a) * 255);
				px[i + 1] = Math.round((g / a) * 255);
				px[i + 2] = Math.round((b / a) * 255);
			}
		}
	return px;
}

function png(size: number, rgba: Uint8Array) {
	const table = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (b: Uint8Array) => {
		let c = 0xffffffff;
		for (const v of b) c = table[(c ^ v) & 0xff] ^ (c >>> 8);
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
	new DataView(ihdr.buffer).setUint32(0, size);
	new DataView(ihdr.buffer).setUint32(4, size);
	ihdr.set([8, 6, 0, 0, 0], 8);
	const raw = new Uint8Array(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
	return Buffer.concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

mkdirSync("icon.iconset", { recursive: true });
const cache = new Map<number, Buffer>();
for (const base of [16, 32, 128, 256, 512])
	for (const mult of [1, 2]) {
		const size = base * mult;
		if (!cache.has(size)) cache.set(size, png(size, render(size)));
		const name = `icon_${base}x${base}${mult === 2 ? "@2x" : ""}.png`;
		writeFileSync(`icon.iconset/${name}`, cache.get(size)!);
		console.log(`icon.iconset/${name} (${size}px)`);
	}
