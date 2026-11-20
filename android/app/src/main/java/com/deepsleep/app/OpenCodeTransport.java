package com.deepsleep.app;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import javax.net.ssl.HttpsURLConnection;

/** Fixed OpenCode transport for Android WebViews, since OpenCode does not answer CORS preflights. */
final class OpenCodeTransport {
    static final String PATH = "api/opencode/chat";
    static final String NONCE = UUID.randomUUID().toString();
    private static final String ENDPOINT = "https://opencode.ai/inference/openai/v1/chat/completions";
    private static final int MAX_BODY_BYTES = 16 * 1024 * 1024;

    private OpenCodeTransport() {}

    static void serve(String head, InputStream input, OutputStream output, int port) throws IOException {
        String[] lines = head.split("\r\n");
        Map<String, String> headers = new HashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int separator = lines[i].indexOf(':');
            if (separator > 0) {
                headers.put(lines[i].substring(0, separator).toLowerCase(Locale.ROOT),
                        lines[i].substring(separator + 1).trim());
            }
        }
        String host = "127.0.0.1:" + port;
        String supplied = headers.getOrDefault("x-deepsleep-opencode", "");
        if (!lines[0].equals("POST /" + PATH + " HTTP/1.1")
                || !host.equals(headers.get("host"))
                || !("http://" + host).equals(headers.get("origin"))
                || !MessageDigest.isEqual(NONCE.getBytes(StandardCharsets.UTF_8), supplied.getBytes(StandardCharsets.UTF_8))) {
            respond(output, 403, "application/json");
            return;
        }
        int length;
        try {
            length = Integer.parseInt(headers.getOrDefault("content-length", ""));
        } catch (NumberFormatException invalid) {
            respond(output, 411, "application/json");
            return;
        }
        if (length <= 0 || length > MAX_BODY_BYTES || headers.containsKey("transfer-encoding")) {
            respond(output, 413, "application/json");
            return;
        }
        String authorization = headers.getOrDefault("authorization", "");
        if (!authorization.matches("Bearer [!-~]+")) {
            respond(output, 401, "application/json");
            return;
        }

        HttpsURLConnection upstream = (HttpsURLConnection) new URL(ENDPOINT).openConnection();
        upstream.setInstanceFollowRedirects(false);
        upstream.setConnectTimeout(20_000);
        upstream.setReadTimeout(65_000);
        upstream.setRequestMethod("POST");
        upstream.setRequestProperty("Content-Type", "application/json");
        upstream.setRequestProperty("Accept", "text/event-stream");
        upstream.setRequestProperty("Authorization", authorization);
        upstream.setDoOutput(true);
        upstream.setFixedLengthStreamingMode(length);
        try {
            byte[] buffer = new byte[8192];
            try (OutputStream body = upstream.getOutputStream()) {
                int remaining = length;
                while (remaining > 0) {
                    int read = input.read(buffer, 0, Math.min(remaining, buffer.length));
                    if (read < 0) throw new IOException("Incomplete request body");
                    body.write(buffer, 0, read);
                    remaining -= read;
                }
            }
            int status = upstream.getResponseCode();
            if (status >= 300 && status < 400) {
                respond(output, 502, "application/json");
                return;
            }
            String type = upstream.getContentType();
            boolean sse = type != null && type.startsWith("text/event-stream");
            respond(output, status, sse ? "text/event-stream" : "application/json");
            try (InputStream body = status >= 400 ? upstream.getErrorStream() : upstream.getInputStream()) {
                if (body == null) return;
                int read;
                while ((read = body.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    output.flush();
                }
            }
        } finally {
            upstream.disconnect();
        }
    }

    private static void respond(OutputStream output, int status, String type) throws IOException {
        String header = "HTTP/1.1 " + status + " Response\r\nContent-Type: " + type
                + "\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n";
        output.write(header.getBytes(StandardCharsets.US_ASCII));
        output.flush();
    }
}
