package dshremote.z7;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 7z 实现的命令行自测（开发机上手动跑，**不进 APK**）。
 *
 *   java dshremote.z7.Z7Test pack      <out.7z> <文本> <密码>
 *   java dshremote.z7.Z7Test unpack    <in.7z>  <密码>
 *   java dshremote.z7.Z7Test roundtrip <文本> <密码>
 *
 * 与真实 `7z.exe` 的双向验证（手动，四个方向都要过）：
 *
 * ```
 *   # ① Java 打包 → 7z.exe 验证 + 解出
 *   java -cp tools/out/classes-app dshremote.z7.Z7Test pack /tmp/a.7z '{"hello":"世界"}' pw
 *   "C:/Program Files/7-Zip/7z.exe" t /tmp/a.7z -ppw
 *   "C:/Program Files/7-Zip/7z.exe" e -so /tmp/a.7z -ppw
 *
 *   # ②③ 7z.exe 普通归档 / 加密头 → Java 解
 *   "C:/Program Files/7-Zip/7z.exe" a -t7z /tmp/b.7z hello.txt -ppw
 *   "C:/Program Files/7-Zip/7z.exe" a -t7z -mhe=on /tmp/c.7z hello.txt -ppw
 *   java -cp tools/out/classes-app dshremote.z7.Z7Test unpack /tmp/b.7z pw
 *   java -cp tools/out/classes-app dshremote.z7.Z7Test unpack /tmp/c.7z pw
 * ```
 *
 * 日常回归由 `node tools/e2e-app.mjs` 覆盖（走线上同一条打包/解包路径）。
 */
public final class Z7Test {

    private Z7Test() {}

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("用法：pack <out.7z> <文本> <密码> | unpack <in.7z> <密码> | roundtrip <文本> <密码>");
            System.exit(2);
        }
        String mode = args[0];
        if ("pack".equals(mode)) {
            byte[] payload = args[2].getBytes(StandardCharsets.UTF_8);
            long started = System.nanoTime();
            byte[] archive = SevenZipWriter.pack(payload, "m.json", args[3].toCharArray());
            long ms = (System.nanoTime() - started) / 1_000_000;
            Files.write(Path.of(args[1]), archive);
            System.out.println("packed " + payload.length + "B -> " + archive.length + "B in " + ms + "ms");
            System.out.println("OK " + archive.length);
        } else if ("unpack".equals(mode)) {
            byte[] archive = Files.readAllBytes(Path.of(args[1]));
            byte[] payload = SevenZipReader.unpack(archive, args[2].toCharArray());
            System.out.println("unpacked " + archive.length + "B -> " + payload.length + "B");
            System.out.print(new String(payload, StandardCharsets.UTF_8));
        } else if ("roundtrip".equals(mode)) {
            byte[] payload = args[1].getBytes(StandardCharsets.UTF_8);
            long t0 = System.nanoTime();
            byte[] archive = SevenZipWriter.pack(payload, "m.json", args[2].toCharArray());
            long t1 = System.nanoTime();
            byte[] back = SevenZipReader.unpack(archive, args[2].toCharArray());
            long t2 = System.nanoTime();
            boolean same = java.util.Arrays.equals(payload, back);
            System.out.println("payload " + payload.length + "B | archive " + archive.length
                    + "B | pack " + (t1 - t0) / 1_000_000 + "ms | unpack " + (t2 - t1) / 1_000_000 + "ms"
                    + " | 一致=" + same);
            if (!same) System.exit(1);
        } else {
            System.err.println("未知模式 " + mode);
            System.exit(2);
        }
    }
}
