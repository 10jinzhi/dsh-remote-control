package dshremote;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 极简 JSON（解析 + 序列化）。
 *
 * 为什么不用 org.json：手机端核心（B2 客户端 / 邮箱 / 链路）刻意**不碰任何
 * Android API**，这样才能在开发机上用普通 JVM 跑真实端到端测试。
 * 手写 200 行比引入 Gson/Moshi 更符合本项目「零第三方依赖」的口径。
 *
 * 映射：object → {@code LinkedHashMap<String,Object>}，array → {@code ArrayList<Object>}，
 * number → {@code Double}（整数用 {@code Long}），bool → {@code Boolean}，null → {@code null}。
 */
public final class Json {

    private final String src;
    private int pos;

    private Json(String src) {
        this.src = src;
    }

    public static Object parse(String text) {
        Json p = new Json(text);
        p.skipWhitespace();
        Object value = p.readValue();
        p.skipWhitespace();
        if (p.pos < p.src.length()) throw new IllegalArgumentException("JSON 尾部有多余字符（位置 " + p.pos + "）");
        return value;
    }

    /** 解析成对象；不是对象就抛错。 */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text) {
        Object value = parse(text);
        if (!(value instanceof Map)) throw new IllegalArgumentException("不是 JSON 对象");
        return (Map<String, Object>) value;
    }

    public static String stringify(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value);
        return sb.toString();
    }

    // ---------------------------------------------------------------- 读

    private Object readValue() {
        if (pos >= src.length()) throw new IllegalArgumentException("JSON 意外结束");
        char c = src.charAt(pos);
        switch (c) {
            case '{': return readObject();
            case '[': return readArray();
            case '"': return readString();
            case 't': expect("true"); return Boolean.TRUE;
            case 'f': expect("false"); return Boolean.FALSE;
            case 'n': expect("null"); return null;
            default: return readNumber();
        }
    }

    private Map<String, Object> readObject() {
        Map<String, Object> map = new LinkedHashMap<>();
        pos++; // {
        skipWhitespace();
        if (pos < src.length() && src.charAt(pos) == '}') { pos++; return map; }
        while (true) {
            skipWhitespace();
            String key = readString();
            skipWhitespace();
            if (src.charAt(pos) != ':') throw new IllegalArgumentException("JSON 缺冒号（位置 " + pos + "）");
            pos++;
            skipWhitespace();
            map.put(key, readValue());
            skipWhitespace();
            char c = src.charAt(pos);
            if (c == ',') { pos++; continue; }
            if (c == '}') { pos++; return map; }
            throw new IllegalArgumentException("JSON 对象格式错（位置 " + pos + "）");
        }
    }

    private List<Object> readArray() {
        List<Object> list = new ArrayList<>();
        pos++; // [
        skipWhitespace();
        if (pos < src.length() && src.charAt(pos) == ']') { pos++; return list; }
        while (true) {
            skipWhitespace();
            list.add(readValue());
            skipWhitespace();
            char c = src.charAt(pos);
            if (c == ',') { pos++; continue; }
            if (c == ']') { pos++; return list; }
            throw new IllegalArgumentException("JSON 数组格式错（位置 " + pos + "）");
        }
    }

    private String readString() {
        if (src.charAt(pos) != '"') throw new IllegalArgumentException("JSON 期望字符串（位置 " + pos + "）");
        pos++;
        StringBuilder sb = new StringBuilder();
        while (true) {
            char c = src.charAt(pos++);
            if (c == '"') return sb.toString();
            if (c != '\\') { sb.append(c); continue; }
            char esc = src.charAt(pos++);
            switch (esc) {
                case '"': sb.append('"'); break;
                case '\\': sb.append('\\'); break;
                case '/': sb.append('/'); break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'n': sb.append('\n'); break;
                case 'r': sb.append('\r'); break;
                case 't': sb.append('\t'); break;
                case 'u':
                    sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16));
                    pos += 4;
                    break;
                default: throw new IllegalArgumentException("未知转义 \\" + esc);
            }
        }
    }

    private Object readNumber() {
        int start = pos;
        while (pos < src.length() && "+-0123456789.eE".indexOf(src.charAt(pos)) >= 0) pos++;
        String text = src.substring(start, pos);
        if (text.isEmpty()) throw new IllegalArgumentException("JSON 数值非法（位置 " + start + "）");
        if (text.indexOf('.') < 0 && text.indexOf('e') < 0 && text.indexOf('E') < 0) {
            try {
                return Long.parseLong(text);
            } catch (NumberFormatException ignored) {
                // 超出 long 就退回 double
            }
        }
        return Double.parseDouble(text);
    }

    private void expect(String literal) {
        if (!src.startsWith(literal, pos)) throw new IllegalArgumentException("JSON 期望 " + literal);
        pos += literal.length();
    }

    private void skipWhitespace() {
        while (pos < src.length()) {
            char c = src.charAt(pos);
            if (c == ' ' || c == '\n' || c == '\r' || c == '\t') pos++;
            else break;
        }
    }

    // ---------------------------------------------------------------- 写

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder sb, Object value) {
        if (value == null) { sb.append("null"); return; }
        if (value instanceof String) { writeString(sb, (String) value); return; }
        if (value instanceof Boolean) { sb.append(value.toString()); return; }
        if (value instanceof Double || value instanceof Float) {
            double d = ((Number) value).doubleValue();
            if (d == Math.rint(d) && !Double.isInfinite(d)) sb.append((long) d);
            else sb.append(d);
            return;
        }
        if (value instanceof Number) { sb.append(value.toString()); return; }
        if (value instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) value).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeString(sb, e.getKey());
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
            return;
        }
        if (value instanceof Iterable) {
            sb.append('[');
            boolean first = true;
            for (Object item : (Iterable<Object>) value) {
                if (!first) sb.append(',');
                first = false;
                write(sb, item);
            }
            sb.append(']');
            return;
        }
        writeString(sb, value.toString());
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    // ---------------------------------------------------------------- 取值助手

    public static String str(Map<String, Object> map, String key, String fallback) {
        Object v = map == null ? null : map.get(key);
        return v instanceof String ? (String) v : fallback;
    }

    public static long num(Map<String, Object> map, String key, long fallback) {
        Object v = map == null ? null : map.get(key);
        return v instanceof Number ? ((Number) v).longValue() : fallback;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> obj(Map<String, Object> map, String key) {
        Object v = map == null ? null : map.get(key);
        return v instanceof Map ? (Map<String, Object>) v : null;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> arr(Map<String, Object> map, String key) {
        Object v = map == null ? null : map.get(key);
        return v instanceof List ? (List<Object>) v : new ArrayList<>();
    }
}
