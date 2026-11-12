/**
 * 7z 头部结构分析器（仅用于开发期核对，不参与运行时）。
 *
 * 目的：把「7z.exe 真实产出的字节」打印出来，让 Java 侧的实现有**事实**可对，
 * 而不是照文档猜 coder 顺序、AES 属性位、是否写 SubStreamsInfo 这些细节。
 *
 * 用法：node tools/inspect7z.mjs <file.7z>
 */
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const buf = readFileSync(process.argv[2]);
const out = [];
const log = (s) => out.push(s);

function u64(off) {
	let v = 0n;
	for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(buf[off + i]);
	return Number(v);
}

log(`文件大小 ${buf.length}`);

const SIG = Buffer.from('377abcaf271c', 'hex');
if (!buf.subarray(0, 6).equals(SIG)) throw new Error('不是 7z');
log(`签名 ok，版本 ${buf[6]}.${buf[7]}`);
log(`StartHeaderCRC ${buf.readUInt32LE(8).toString(16)}（实际 ${crc32(buf.subarray(12, 32)).toString(16)}）`);
const nextOff = u64(12);
const nextSize = u64(20);
const nextCrc = buf.readUInt32LE(28);
log(`NextHeader offset=${nextOff} size=${nextSize} crc=${nextCrc.toString(16)}`);
const next = buf.subarray(32 + nextOff, 32 + nextOff + nextSize);
log(`NextHeader 实际 crc=${crc32(next).toString(16)}`);
log(`NextHeader 前 96 字节: ${next.subarray(0, Math.min(96, next.length)).toString('hex')}`);

// 简易遍历：只打印 ID 流与关键数值，够核对结构即可
let p = 0;
const readByte = () => next[p++];
const readU64 = () => {
	const first = next[p];
	let mask = 0x80;
	let value = 0;
	for (let i = 0; i < 8; i += 1) {
		if ((first & mask) === 0) {
			value |= (first & (mask - 1)) << (8 * i);
			p += 1;
			return value >>> 0;
		}
		value |= next[p + 1 + i] << (8 * i);
		mask >>= 1;
	}
	p += 9;
	return value;
};

function dumpStreams(prefix) {
	// 已经在 StreamsInfo 内部
	for (;;) {
		const id = readByte();
		if (id === 0x00) { log(`${prefix}kEnd`); return; }
		if (id === 0x06) {
			const packPos = readU64();
			const n = readU64();
			log(`${prefix}kPackInfo packPos=${packPos} numPackStreams=${n}`);
			for (;;) {
				const sid = readByte();
				if (sid === 0x00) break;
				if (sid === 0x09) {
					const sizes = [];
					for (let i = 0; i < n; i += 1) sizes.push(readU64());
					log(`${prefix}  kSize ${JSON.stringify(sizes)}`);
				} else if (sid === 0x0a) {
					const all = readByte();
					log(`${prefix}  kCRC allAreDefined=${all}`);
					if (all === 1) { for (let i = 0; i < n; i += 1) { log(`${prefix}   crc=${next.readUInt32LE(p).toString(16)}`); p += 4; } }
					else { const bits = Math.ceil(n / 8); const defined = next.subarray(p, p + bits); p += bits; log(`${prefix}   bits=${defined.toString('hex')}`); }
				} else { log(`${prefix}  ?未知 pack 属性 ${sid}`); return; }
			}
		} else if (id === 0x07) {
			log(`${prefix}kUnPackInfo`);
			const folderId = readByte();
			if (folderId !== 0x0b) { log(`${prefix} 期望 kFolder(0x0b) 得到 ${folderId}`); return; }
			const numFolders = readU64();
			const external = readByte();
			log(`${prefix}  kFolder numFolders=${numFolders} external=${external}`);
			for (let f = 0; f < numFolders; f += 1) {
				const numCoders = readU64();
				log(`${prefix}   folder#${f} numCoders=${numCoders}`);
				let totalOut = 0;
				let totalIn = 0;
				for (let c = 0; c < numCoders; c += 1) {
					const flags = readByte();
					const idSize = flags & 0x0f;
					const isComplex = (flags & 0x10) !== 0;
					const hasAttrs = (flags & 0x20) !== 0;
					const methodId = next.subarray(p, p + idSize); p += idSize;
					let inS = 1; let outS = 1;
					if (isComplex) { inS = readU64(); outS = readU64(); }
					totalIn += inS; totalOut += outS;
					let props = '';
					if (hasAttrs) {
						const size = readU64();
						props = next.subarray(p, p + size).toString('hex'); p += size;
					}
					log(`${prefix}    coder#${c} id=${methodId.toString('hex')} in=${inS} out=${outS} props=${props}`);
				}
				const bindPairs = totalOut - 1;
				for (let b = 0; b < bindPairs; b += 1) {
					const inIndex = readU64(); const outIndex = readU64();
					log(`${prefix}    bindPair{in:${inIndex}, out:${outIndex}}`);
				}
				const packedStreams = totalIn - bindPairs;
				if (packedStreams > 1) {
					const idx = [];
					for (let i = 0; i < packedStreams; i += 1) idx.push(readU64());
					log(`${prefix}    packedStreamIndices ${JSON.stringify(idx)}`);
				}
			}
			for (;;) {
				const sid = readByte();
				if (sid === 0x00) break;
				if (sid === 0x0c) {
					const sizes = [];
					for (let f = 0; f < 1; f += 1) { /* 单文件夹单出口 */ sizes.push(readU64()); }
					log(`${prefix}  kCodersUnPackSize ${JSON.stringify(sizes)}`);
				} else { log(`${prefix}  ?未知 unpack 属性 ${sid}`); return; }
			}
		} else if (id === 0x08) {
			log(`${prefix}kSubStreamsInfo`);
			for (;;) {
				const sid = readByte();
				if (sid === 0x00) break;
				log(`${prefix}  sub 属性 ${sid}`);
				if (sid === 0x0d) { log(`${prefix}   numUnPackStream=${readU64()}`); }
				else if (sid === 0x09) { log(`${prefix}   size=${readU64()}`); }
				else return;
			}
		} else {
			log(`${prefix}?未知流属性 ${id.toString(16)}`);
			return;
		}
	}
}

const head = readByte();
log(`kHeader=${head.toString(16)}`);
// 可能先有 kArchiveProperties / kAdditionalStreams
let id = readByte();
if (id === 0x02) { log('kArchiveProperties'); while ((id = readByte()) !== 0) { const size = readU64(); p += size; } id = readByte(); }
if (id === 0x03) { log('kAdditionalStreams'); id = readByte(); }
if (id === 0x04) {
	log('kMainStreamsInfo');
	dumpStreams('  ');
} else {
	log(`没有 kMainStreamsInfo，直接 ${id.toString(16)}`);
}
const filesId = readByte();
if (filesId === 0x05) {
	const n = readU64();
	log(`kFilesInfo numFiles=${n}`);
	for (;;) {
		const pid = readByte();
		if (pid === 0x00) break;
		const size = readU64();
		const data = next.subarray(p, p + size);
		if (pid === 0x11) {
			const external = data[0];
			const nameBytes = data.subarray(1);
			const name = Buffer.from(nameBytes).toString('utf16le').replace(/\0.*$/, '');
			log(`  kName external=${external} name="${name}"（${size} 字节）`);
		} else {
			log(`  属性 ${pid.toString(16)} size=${size} data=${data.subarray(0, Math.min(24, size)).toString('hex')}`);
		}
		p += size;
	}
	log('kFilesInfo kEnd');
} else {
	log(`没有 kFilesInfo，得到 ${filesId.toString(16)}`);
}

console.log(out.join('\n'));
