package dshremote.z7;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.zip.CRC32;

import SevenZip.Compression.LZMA.Encoder;

/**
 * 写一个**标准 7z 归档**：单文件、LZMA 压缩、AES-256 加密。
 *
 * 产出的字节可以直接用 7-Zip / WinRAR / ZArchiver 打开并输密码 —— 这是本方案
 * 唯一需要的「加密自证」：不是自定义信封，而是真格式。
 *
 * ## 布局
 *
 * <pre>
 *   [0,32)          SignatureHeader
 *   [32, 32+pack)   PackStream = AES-256-CBC(LZMA(payload))
 *   [32+pack, ...)  NextHeader
 * </pre>
 *
 * NextHeader 里两个 coder 的顺序是 **AES 在前、LZMA 在后**，
 * 绑定对 `{in:1, out:0}` 表示「LZMA 的输入吃 AES 的输出」，
 * 未绑定的那个输入（coder0 的输入）就是 pack 流 —— 与本机 7z.exe 产物一致。
 */
public final class SevenZipWriter {

    /**
     * 1 MB 字典：我们的帧是几十 KB 的 JSON，1 MB 足够；
     * 而 LZMA 的 BT4 匹配器内存约为字典的 11 倍，4 MB 字典在手机上要吃 40 MB+，
     * 对「发一句话」这种负载不值得。
     */
    private static final int DICT_SIZE = 1 << 20;

    private static final SecureRandom RANDOM = new SecureRandom();

    private SevenZipWriter() {}

    public static byte[] pack(byte[] payload, String entryName, char[] password) throws IOException {
        // ---- ① LZMA 压缩 ----
        Encoder encoder = new Encoder();
        encoder.SetAlgorithm(1);          // 1 = 常规（bt4）
        encoder.SetDictionarySize(DICT_SIZE);
        encoder.SetNumFastBytes(128);
        encoder.SetMatchFinder(1);        // 1 = BT4
        encoder.SetLcLpPb(3, 0, 2);       // 7-Zip 默认 lc=3 lp=0 pb=2
        encoder.SetEndMarkerMode(false);  // 7z 里靠头部的 unpackSize 定界，不写结束标记

        ByteArrayOutputStream propsOut = new ByteArrayOutputStream();
        encoder.WriteCoderProperties(propsOut);
        byte[] lzmaProps = propsOut.toByteArray();

        ByteArrayOutputStream compressed = new ByteArrayOutputStream();
        encoder.Code(new ByteArrayInputStream(payload), compressed, payload.length, -1, null);
        byte[] lzmaData = compressed.toByteArray();

        // ---- ② AES-256 加密 ----
        byte[] iv = new byte[SevenZipAes.IV_SIZE];
        RANDOM.nextBytes(iv);
        byte[] key = SevenZipAes.deriveKey(new byte[0], password, SevenZipAes.DEFAULT_CYCLES_POWER);
        byte[] aesProps = SevenZipAes.buildProps(iv, SevenZipAes.DEFAULT_CYCLES_POWER);
        byte[] packData = SevenZipAes.encrypt(key, iv, lzmaData);

        // ---- ③ 头部 ----
        byte[] header = buildHeader(
                payload.length, lzmaData.length, packData.length,
                aesProps, lzmaProps, entryName);

        // ---- ④ 拼装 ----
        ByteArrayOutputStream file = new ByteArrayOutputStream();
        file.write(SIGNATURE_MAGIC);
        file.write(0); // major
        file.write(4); // minor
        byte[] startHeader = new byte[20];
        // NextHeaderOffset：头部在 pack 流之后，所以等于 pack 的字节数
        writeLE64(startHeader, 0, packData.length);
        writeLE64(startHeader, 8, header.length);            // NextHeaderSize
        writeUInt32(startHeader, 16, crc32(header));         // NextHeaderCRC
        file.write(le32(crc32(startHeader)));                // StartHeaderCRC（覆盖后 20 字节）
        file.write(startHeader);
        file.write(packData);
        file.write(header);
        return file.toByteArray();
    }

    private static final byte[] SIGNATURE_MAGIC = { 0x37, 0x7A, (byte) 0xBC, (byte) 0xAF, 0x27, 0x1C };

    private static byte[] buildHeader(
            long unpackedSize, long lzmaSize, long packSize,
            byte[] aesProps, byte[] lzmaProps, String entryName) throws IOException {
        ByteArrayOutputStream h = new ByteArrayOutputStream();
        h.write(0x01); // kHeader

        h.write(0x04); // kMainStreamsInfo
        {
            h.write(0x06); // kPackInfo
            writeUInt64(h, 0);      // PackPos
            writeUInt64(h, 1);      // NumPackStreams
            h.write(0x09);          // kSize
            writeUInt64(h, packSize);
            h.write(0x00);          // kEnd

            h.write(0x07); // kUnPackInfo
            h.write(0x0B); // kFolder
            writeUInt64(h, 1);      // NumFolders
            h.write(0x00);          // External = 0
            writeUInt64(h, 2);      // NumCoders
            {
                // coder #0：7zAES
                h.write(0x24);      // idSize=4，有属性
                h.write(new byte[] { 0x06, (byte) 0xF1, 0x07, 0x01 }, 0, 4);
                writeUInt64(h, aesProps.length);
                h.write(aesProps, 0, aesProps.length);
                // coder #1：LZMA
                h.write(0x23);      // idSize=3，有属性
                h.write(new byte[] { 0x03, 0x01, 0x01 }, 0, 3);
                writeUInt64(h, lzmaProps.length);
                h.write(lzmaProps, 0, lzmaProps.length);
            }
            // 绑定对：LZMA 的输入（in#1）吃 AES 的输出（out#0）
            writeUInt64(h, 1);
            writeUInt64(h, 0);
            // pack 流数量 = 总输入 2 - 绑定对 1 = 1，不需要额外索引

            h.write(0x0C); // kCodersUnPackSize
            // 每个 out stream 一个（与 `7z a` 的真实产物逐字节对齐）：
            //   out#0 = AES 的输出 = LZMA 流长度
            //   out#1 = LZMA 的输出 = 原文长度（= 文件夹输出）
            writeUInt64(h, lzmaSize);
            writeUInt64(h, unpackedSize);
            h.write(0x00); // kEnd（UnPackInfo）

            // 不放 kSubStreamsInfo：单文件单流时它是可选的，写上反而容易和
            // 7-Zip 的期望不一致（实测写了一版空 SubStreamsInfo 会被判 Headers Error）。
            h.write(0x00); // kEnd（StreamsInfo）
        }

        h.write(0x05); // kFilesInfo
        writeUInt64(h, 1); // NumFiles
        {
            h.write(0x11); // kName
            byte[] name = utf16le(entryName);
            writeUInt64(h, 1 + name.length + 2);
            h.write(0x00); // External = 0
            h.write(name, 0, name.length);
            h.write(0x00);
            h.write(0x00);
            h.write(0x00); // kEnd（FilesInfo）
        }
        h.write(0x00); // kEnd（Header）
        return h.toByteArray();
    }

    // ---------------------------------------------------------------- 小工具

    /**
     * 7z 的变长 UINT64 编码。
     *
     * 首字节高位的连续 1 表示后面还有几个字节，剩余位放数值低位。
     * 例：0x0C → `0C`；0x1234 → `90 34 12`（高位 10 表示 2 个后续字节）。
     */
    static void writeUInt64(ByteArrayOutputStream out, long value) {
        int firstByte = 0;
        int mask = 0x80;
        int i;
        for (i = 0; i < 8; i++) {
            if (value < (1L << (7 * (i + 1)))) {
                firstByte |= (int) (value >>> (8 * i));
                break;
            }
            firstByte |= mask;
            mask >>>= 1;
        }
        out.write(firstByte);
        for (int j = i - 1; j >= 0; j--) {
            out.write((int) ((value >>> (8 * j)) & 0xFF));
        }
    }

    private static void writeLE64(byte[] target, int offset, long value) {
        for (int i = 0; i < 8; i++) {
            target[offset + i] = (byte) ((value >>> (8 * i)) & 0xFF);
        }
    }

    private static void writeUInt32(byte[] target, int offset, int value) {
        target[offset] = (byte) (value & 0xFF);
        target[offset + 1] = (byte) ((value >>> 8) & 0xFF);
        target[offset + 2] = (byte) ((value >>> 16) & 0xFF);
        target[offset + 3] = (byte) ((value >>> 24) & 0xFF);
    }

    private static byte[] le32(int value) {
        byte[] out = new byte[4];
        writeUInt32(out, 0, value);
        return out;
    }

    static int crc32(byte[] data) {
        CRC32 crc = new CRC32();
        crc.update(data, 0, data.length);
        return (int) crc.getValue();
    }

    static byte[] utf16le(String text) {
        byte[] raw = text.getBytes(java.nio.charset.StandardCharsets.UTF_16LE);
        return raw;
    }
}
