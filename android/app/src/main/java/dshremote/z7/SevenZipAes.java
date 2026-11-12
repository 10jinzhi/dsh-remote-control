package dshremote.z7;

import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 7z 的 AES-256 加解密（7zAES，方法 ID {@code 06 F1 07 01}）。
 *
 * ## 格式（本机用真实 7z.exe 产物反推 + 解密验证过）
 *
 * 属性字节：
 * <pre>
 *   props[0]: bit0-5 = numCyclesPower（默认 19 ⇒ 2^19 轮）；bit6 = ivSize ≥ 16；bit7 = saltSize ≥ 16
 *   props[1]: 高 4 位 = saltSize 的低位；低 4 位 = ivSize 的低位
 *   props[2..]: salt 然后 IV
 * </pre>
 * 7-Zip 默认写 saltSize=0、ivSize=16，于是属性正好 18 字节 —— 与实测一致。
 *
 * ## 密钥派生（关键，容易写错）
 *
 * 不是「每轮再哈希上一次摘要」，而是**同一个 SHA-256 上下文里顺序喂入**
 * `salt || password(UTF-16LE) || LE64(round)` 共 2^numCyclesPower 次，
 * 最后取摘要前 32 字节：
 *
 * <pre>
 *   h = SHA256()
 *   for round in 0 .. (1&lt;&lt;19)-1:  h.update(salt); h.update(pw); h.update(le64(round))
 *   key = h.digest()[0..32]
 * </pre>
 *
 * 依据：py7zr 的 `calculate_key()` 与 7-Zip 的 C 实现都是这个形状；
 * 本机实测用它解开了 `7z.exe a -p` 打出的真实归档（解出原文 `{"x":2}`）。
 *
 * ## 数据
 *
 * AES-256-CBC，IV 来自属性；密文按 16 字节对齐填充（填充内容无意义，
 * 因为解出来的长度由 7z 头里的 unpackSize 决定）。
 */
public final class SevenZipAes {

    public static final int DEFAULT_CYCLES_POWER = 19;
    public static final int IV_SIZE = 16;

    private SevenZipAes() {}

    /** 从密码派生 AES-256 密钥。salt 可为空。 */
    public static byte[] deriveKey(byte[] salt, char[] password, int cyclesPower) {
        int rounds = 1 << cyclesPower;
        byte[] pw = utf16le(password);
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            byte[] counter = new byte[8];
            for (int round = 0; round < rounds; round++) {
                // 小端 64 位计数器（round 从 0 开始）
                long v = round;
                for (int i = 0; i < 8; i++) {
                    counter[i] = (byte) (v & 0xFF);
                    v >>>= 8;
                }
                if (salt != null && salt.length > 0) sha.update(salt);
                sha.update(pw);
                sha.update(counter);
            }
            byte[] digest = sha.digest();
            return Arrays.copyOf(digest, 32);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("JVM 缺少 SHA-256", e);
        } finally {
            Arrays.fill(pw, (byte) 0);
        }
    }

    /** 加密并补齐到 16 字节整数倍。 */
    public static byte[] encrypt(byte[] key, byte[] iv, byte[] plain) {
        try {
            int padded = ((plain.length + 15) / 16) * 16;
            byte[] buf = Arrays.copyOf(plain, padded);
            Cipher cipher = Cipher.getInstance("AES/CBC/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
            return cipher.doFinal(buf);
        } catch (Exception e) {
            throw new IllegalStateException("7z AES 加密失败：" + e.getMessage(), e);
        }
    }

    /** 解密；只取实际需要的 {@code length} 字节（忽略填充）。 */
    public static byte[] decrypt(byte[] key, byte[] iv, byte[] cipherText, int length) {
        try {
            Cipher cipher = Cipher.getInstance("AES/CBC/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
            byte[] plain = cipher.doFinal(cipherText);
            if (plain.length < length) {
                throw new IllegalStateException(
                        "密文比声明的长度短（decrypted=" + plain.length + " need=" + length + "）");
            }
            return Arrays.copyOf(plain, length);
        } catch (Exception e) {
            throw new IllegalStateException("7z AES 解密失败：" + e.getMessage(), e);
        }
    }

    /**
     * 组 18 字节的 7zAES 属性（salt=0、iv=16、cycles=19）。
     *
     * ⚠️ 两字节的编码很容易写错：解码公式是
     * `size = (对应标志位 ? 1 : 0) + nibble`，
     * 所以 **ivSize=16 必须写成 nibble=15 + bit6=1**（即第二字节 0x0F）。
     * 早先写成 nibble=0，7z 会把 ivSize 读成 1 ⇒ 属性长度对不上 ⇒
     * 7z.exe 报 `Unsupported Method`（已用真实 7z.exe 验证过这个坑）。
     */
    public static byte[] buildProps(byte[] iv, int cyclesPower) {
        if (iv.length != IV_SIZE) throw new IllegalArgumentException("IV 必须 16 字节");
        int saltSize = 0;
        int ivSize = iv.length;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int first = cyclesPower & 0x3F;
        if (saltSize >= 16) first |= 0x80;
        if (ivSize >= 16) first |= 0x40;
        int second = ((saltSize >= 16 ? 15 : saltSize) << 4) | (ivSize >= 16 ? 15 : ivSize);
        out.write(first);
        out.write(second);
        out.write(iv, 0, iv.length);
        return out.toByteArray();
    }

    /** 解析属性里的 (saltSize, ivSize, cyclesPower, salt, iv)。 */
    public static Props parseProps(byte[] props) {
        if (props == null || props.length < 1) throw new IllegalStateException("7zAES 属性为空");
        int first = props[0] & 0xFF;
        Props p = new Props();
        p.cyclesPower = first & 0x3F;
        if ((first & 0xC0) == 0) {
            p.saltSize = 0;
            p.ivSize = 0;
            return p;
        }
        int second = props[1] & 0xFF;
        p.saltSize = ((first >> 7) & 1) + (second >> 4);
        p.ivSize = ((first >> 6) & 1) + (second & 0x0F);
        int offset = 2;
        p.salt = Arrays.copyOfRange(props, offset, offset + p.saltSize);
        offset += p.saltSize;
        p.iv = Arrays.copyOfRange(props, offset, offset + p.ivSize);
        return p;
    }

    public static final class Props {
        public int cyclesPower;
        public int saltSize;
        public int ivSize;
        public byte[] salt = new byte[0];
        public byte[] iv = new byte[0];
    }

    static byte[] utf16le(char[] password) {
        byte[] out = new byte[password.length * 2];
        for (int i = 0; i < password.length; i++) {
            out[i * 2] = (byte) (password[i] & 0xFF);
            out[i * 2 + 1] = (byte) ((password[i] >> 8) & 0xFF);
        }
        return out;
    }
}
