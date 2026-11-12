package dshremote.z7;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

import SevenZip.Compression.LZMA.Decoder;

/**
 * 读一个标准 7z 归档（单文件、LZMA、可选 AES-256）。
 *
 * 支持两种头部形态：
 *   · 明文头（`0x01 kHeader`）—— 本方案自己写的、以及 `7z a` 的默认产物；
 *   · 加密头（`0x17 kEncodedHeader`）—— 用户用 `-mhe=on` 打的归档。
 *     这一种是「头本身也是一条加密+压缩流」，先解头、再解数据。
 *
 * 只实现本协议用得到的子集：一个文件夹、最多两个 coder（AES / LZMA）、
 * 单文件。超出范围时抛明确错误，不静默返回半截数据。
 */
public final class SevenZipReader {

    private static final int METHOD_AES = 0x06F10701;
    private static final int METHOD_LZMA = 0x030101;

    private final byte[] data;
    private int pos;

    private SevenZipReader(byte[] data) {
        this.data = data;
    }

    /** 解开归档，返回里面第一个文件的内容。 */
    public static byte[] unpack(byte[] archive, char[] password) {
        return new SevenZipReader(archive).run(password);
    }

    private byte[] run(char[] password) {
        checkSignature();
        long nextOffset = readLE64(12);
        long nextSize = readLE64(20);
        int nextStart = (int) (32 + nextOffset);
        if (nextStart + nextSize > data.length) throw new IllegalStateException("7z 头部越界");
        byte[] nextHeader = slice(nextStart, (int) nextSize);

        Streams streams;
        byte[] header = nextHeader;
        if ((header[0] & 0xFF) == 0x17) {
            // kEncodedHeader：先解析「头这条流」，解出来的才是真正 header
            streams = parseStreamsInfo(header, 1);
            byte[] plainHeader = decodeFolder(streams, 0, password);
            header = plainHeader;
        }
        if ((header[0] & 0xFF) != 0x01) {
            throw new IllegalStateException("不是 7z 头（首字节 " + Integer.toHexString(header[0] & 0xFF) + "）");
        }
        streams = parseMainHeader(header, 1);
        return decodeFolder(streams, 0, password);
    }

    // ------------------------------------------------------------ 结构

    private static final class Coder {
        int methodId;
        byte[] props;
    }

    private static final class Folder {
        final List<Coder> coders = new ArrayList<>();
        /** 每个 out stream 的大小（按 coder 顺序，与 7z.exe 产物一致）。 */
        long[] unpackSizes;
    }

    private static final class Streams {
        long packPos;
        long[] packSizes = new long[0];
        final List<Folder> folders = new ArrayList<>();
        long[] subSizes = new long[0];
    }

    /** 解析 `kHeader` 之后的主体，返回主线流信息。 */
    private Streams parseMainHeader(byte[] header, int start) {
        Frame f = new Frame(header);
        f.pos = start;
        int id = f.readByte();
        if (id == 0x02) { // kArchiveProperties
            while ((id = f.readByte()) != 0) {
                long size = f.readUInt64();
                f.pos += (int) size;
            }
            id = f.readByte();
        }
        if (id == 0x03) { // kAdditionalStreamsInfo
            parseStreamsInfoAt(f);
            id = f.readByte();
        }
        Streams streams;
        if (id == 0x04) {
            streams = parseStreamsInfoAt(f);
        } else {
            throw new IllegalStateException("7z 头里没有主线流信息（id=" + id + "）");
        }
        return streams;
    }

    private Streams parseStreamsInfo(byte[] header, int start) {
        Frame f = new Frame(header);
        f.pos = start;
        return parseStreamsInfoAt(f);
    }

    private Streams parseStreamsInfoAt(Frame f) {
        Streams s = new Streams();
        s.folders.clear();
        for (;;) {
            int id = f.readByte();
            switch (id) {
                case 0x00:
                    return s;
                case 0x06: { // kPackInfo
                    s.packPos = f.readUInt64();
                    int numPack = (int) f.readUInt64();
                    s.packSizes = new long[numPack];
                    for (;;) {
                        int sid = f.readByte();
                        if (sid == 0x00) break;
                        if (sid == 0x09) {
                            for (int i = 0; i < numPack; i++) s.packSizes[i] = f.readUInt64();
                        } else if (sid == 0x0A) {
                            skipDigests(f, numPack);
                        } else {
                            throw new IllegalStateException("未知 PackInfo 属性 " + sid);
                        }
                    }
                    break;
                }
                case 0x07: { // kUnPackInfo
                    int fid = f.readByte();
                    if (fid != 0x0B) throw new IllegalStateException("期望 kFolder，得到 " + fid);
                    int numFolders = (int) f.readUInt64();
                    int external = f.readByte();
                    if (external != 0) throw new IllegalStateException("不支持外置文件夹表");
                    for (int i = 0; i < numFolders; i++) {
                        Folder folder = new Folder();
                        int numCoders = (int) f.readUInt64();
                        int totalOut = 0;
                        int totalIn = 0;
                        for (int c = 0; c < numCoders; c++) {
                            int flags = f.readByte();
                            int idSize = flags & 0x0F;
                            boolean complex = (flags & 0x10) != 0;
                            boolean hasProps = (flags & 0x20) != 0;
                            int methodId = 0;
                            for (int b = 0; b < idSize; b++) methodId = (methodId << 8) | f.readByte();
                            // 方法 ID 最长 4 字节（7zAES = 06 F1 07 01），**不能**截断成 24 位。
                            int inStreams = 1;
                            int outStreams = 1;
                            if (complex) {
                                inStreams = (int) f.readUInt64();
                                outStreams = (int) f.readUInt64();
                            }
                            Coder coder = new Coder();
                            coder.methodId = methodId;
                            if (hasProps) {
                                int size = (int) f.readUInt64();
                                coder.props = f.readBytes(size);
                            }
                            totalIn += inStreams;
                            totalOut += outStreams;
                            folder.coders.add(coder);
                        }
                        int bindPairs = totalOut - 1;
                        for (int b = 0; b < bindPairs; b++) {
                            f.readUInt64();
                            f.readUInt64();
                        }
                        int numPacked = totalIn - bindPairs;
                        if (numPacked > 1) {
                            for (int k = 0; k < numPacked; k++) f.readUInt64();
                        }
                        folder.unpackSizes = new long[totalOut];
                        s.folders.add(folder);
                    }
                    for (;;) {
                        int sid = f.readByte();
                        if (sid == 0x00) break;
                        if (sid == 0x0C) { // kCodersUnPackSize
                            // 每个 out stream 一个（`7z a` 实测如此）：
                            // [AES 输出长度, LZMA 输出长度]
                            for (Folder folder : s.folders) {
                                for (int i = 0; i < folder.unpackSizes.length; i++) {
                                    folder.unpackSizes[i] = f.readUInt64();
                                }
                            }
                        } else if (sid == 0x0A) {
                            skipDigests(f, s.folders.size());
                        } else {
                            throw new IllegalStateException("未知 UnPackInfo 属性 " + sid);
                        }
                    }
                    break;
                }
                case 0x08: { // kSubStreamsInfo
                    for (;;) {
                        int sid = f.readByte();
                        if (sid == 0x00) break;
                        if (sid == 0x0D) {
                            int folders = (int) f.readUInt64();
                            long[] counts = new long[folders];
                            for (int i = 0; i < folders; i++) counts[i] = f.readUInt64();
                            f.pos += 0; // 计数只用于推导，这里不需要
                        } else if (sid == 0x09) {
                            // 大小表：非 solid 单文件形态下不会出现，跳过长度未知 —— 直接报错更安全
                            throw new IllegalStateException("不支持含多子流的 solid 归档");
                        } else if (sid == 0x0A) {
                            skipDigests(f, 1);
                        } else {
                            throw new IllegalStateException("未知 SubStreamsInfo 属性 " + sid);
                        }
                    }
                    break;
                }
                default:
                    throw new IllegalStateException("未知 StreamsInfo 属性 " + id);
            }
        }
    }

    /** kCRC 后面的一串摘要：先一个 AllAreDefined 字节，再按位图/全量读。 */
    private void skipDigests(Frame f, int count) {
        int allDefined = f.readByte();
        if (allDefined == 1) {
            f.pos += 4 * count;
            return;
        }
        int bytes = (count + 7) / 8;
        byte[] bits = f.readBytes(bytes);
        for (int i = 0; i < count; i++) {
            boolean defined = (bits[i / 8] & (1 << (i % 8))) != 0;
            if (defined) f.pos += 4;
        }
    }

    // ------------------------------------------------------------ 解码

    private byte[] decodeFolder(Streams streams, int folderIndex, char[] password) {
        if (streams.folders.isEmpty()) throw new IllegalStateException("7z 里没有数据流");
        Folder folder = streams.folders.get(folderIndex);
        if (streams.packSizes.length < 1) throw new IllegalStateException("7z 里没有 pack 流");
        int packStart = (int) (32 + streams.packPos);
        byte[] current = slice(packStart, (int) streams.packSizes[0]);

        for (int i = 0; i < folder.coders.size(); i++) {
            Coder coder = folder.coders.get(i);
            long outSize = folder.unpackSizes.length > i ? folder.unpackSizes[i] : -1;
            if (coder.methodId == METHOD_AES) {
                if (password == null) throw new IllegalStateException("归档已加密，但没提供密码");
                SevenZipAes.Props p = SevenZipAes.parseProps(coder.props);
                byte[] key = SevenZipAes.deriveKey(p.salt, password, p.cyclesPower);
                // 按头里声明的长度截断：AES 密文后面补齐的填充字节在这里被丢掉。
                current = SevenZipAes.decrypt(key, p.iv, current, (int) outSize);
            } else if (coder.methodId == METHOD_LZMA) {
                if (outSize < 0) throw new IllegalStateException("LZMA 输出长度未知");
                current = lzmaDecode(coder.props, current, (int) outSize);
            } else {
                throw new IllegalStateException(
                        "不支持的 7z 编码方法 0x" + Integer.toHexString(coder.methodId));
            }
        }
        return current;
    }

    private byte[] lzmaDecode(byte[] props, byte[] compressed, int outSize) {
        try {
            Decoder decoder = new Decoder();
            if (!decoder.SetDecoderProperties(props)) {
                throw new IllegalStateException("LZMA 属性非法");
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(outSize, 64));
            decoder.Code(new ByteArrayInputStream(compressed), out, (long) outSize);
            byte[] result = out.toByteArray();
            if (result.length != outSize) {
                throw new IllegalStateException("LZMA 解出长度不符（" + result.length + " != " + outSize + "）");
            }
            return result;
        } catch (Exception e) {
            throw new IllegalStateException("LZMA 解压失败：" + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------------ 基础读取

    private void checkSignature() {
        if (data.length < 32) throw new IllegalStateException("不是 7z 归档（太短）");
        int[] magic = { 0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C };
        for (int i = 0; i < magic.length; i++) {
            if ((data[i] & 0xFF) != magic[i]) throw new IllegalStateException("不是 7z 归档（签名不符）");
        }
    }

    private long readLE64(int offset) {
        long v = 0;
        for (int i = 7; i >= 0; i--) {
            v = (v << 8) | (data[offset + i] & 0xFFL);
        }
        return v;
    }

    private byte[] slice(int start, int length) {
        if (start < 0 || length < 0 || start + length > data.length) {
            throw new IllegalStateException("7z 数据越界（start=" + start + " len=" + length + "）");
        }
        byte[] out = new byte[length];
        System.arraycopy(data, start, out, 0, length);
        return out;
    }

    /** 在一段 byte[] 上的游标读取器。 */
    private static final class Frame {
        final byte[] buf;
        int pos;

        Frame(byte[] buf) {
            this.buf = buf;
        }

        int readByte() {
            if (pos >= buf.length) throw new IllegalStateException("7z 头部意外结束");
            return buf[pos++] & 0xFF;
        }

        byte[] readBytes(int n) {
            byte[] out = new byte[n];
            System.arraycopy(buf, pos, out, 0, n);
            pos += n;
            return out;
        }

        /** 7z 的变长 UINT64（首字节高位连续 1 的个数表示后续字节数）。 */
        long readUInt64() {
            int first = readByte();
            long mask = 0x80;
            long value = 0;
            for (int i = 0; i < 8; i++) {
                if ((first & mask) == 0) {
                    value |= ((long) (first & (mask - 1))) << (8 * i);
                    return value;
                }
                value |= ((long) readByte()) << (8 * i);
                mask >>= 1;
            }
            return value;
        }
    }
}
