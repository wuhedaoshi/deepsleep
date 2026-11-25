package com.deepsleep.app;

import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.Arrays;

/** Private, bounded-chunk ZIP snapshots. A partial archive is never eligible for restore. */
final class PrivateBackups {
    private static final int CHUNK_BYTES = 512 * 1024;
    private final File directory;
    private File partial;
    private FileOutputStream stream;

    PrivateBackups(File files) {
        directory = new File(files, "backups");
    }

    private File[] snapshots() {
        File[] files = directory.listFiles((dir, name) -> name.matches("auto-[0-9]+\\.zip"));
        if (files == null) return new File[0];
        Arrays.sort(files, (left, right) -> right.getName().compareTo(left.getName()));
        return files;
    }

    synchronized String list() {
        StringBuilder result = new StringBuilder();
        File[] files = snapshots();
        for (int i = 0; i < Math.min(files.length, 3); i++) {
            File file = files[i];
            result.append(file.getName()).append(':').append(file.length()).append('\n');
        }
        return result.toString();
    }

    synchronized boolean begin() {
        if (stream != null) return false;
        if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) return false;
        try {
            File[] stale = directory.listFiles((dir, name) -> name.startsWith("pending-") && name.endsWith(".tmp"));
            long expired = System.currentTimeMillis() - 86_400_000L;
            if (stale != null) {
                for (File file : stale) {
                    if (file.lastModified() < expired) file.delete();
                }
            }
            partial = File.createTempFile("pending-", ".tmp", directory);
            stream = new FileOutputStream(partial);
            return true;
        } catch (IOException failure) {
            abort();
            return false;
        }
    }

    synchronized boolean append(String encoded) {
        if (stream == null || encoded == null || encoded.length() > ((CHUNK_BYTES + 2) / 3) * 4) return false;
        try {
            byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
            if (bytes.length > CHUNK_BYTES) return false;
            stream.write(bytes);
            return true;
        } catch (IOException | IllegalArgumentException failure) {
            return false;
        }
    }

    synchronized boolean finish() {
        if (stream == null) return false;
        try {
            stream.flush();
            stream.getFD().sync();
            stream.close();
            stream = null;
            File output = new File(directory, "auto-" + System.currentTimeMillis() + ".zip");
            if (partial.length() == 0 || output.exists() || !partial.renameTo(output)) return false;
            partial = null;
            File[] files = snapshots();
            for (int i = 3; i < files.length; i++) files[i].delete();
            return true;
        } catch (IOException failure) {
            return false;
        } finally {
            abort();
        }
    }

    synchronized void abort() {
        try {
            if (stream != null) stream.close();
        } catch (IOException ignored) {
        } finally {
            stream = null;
        }
        if (partial != null) partial.delete();
        partial = null;
    }

    synchronized String read(String name, long offset, int length) {
        if (name == null || !name.matches("auto-[0-9]+\\.zip")
                || offset < 0 || length <= 0 || length > CHUNK_BYTES) return "";
        try (RandomAccessFile file = new RandomAccessFile(new File(directory, name), "r")) {
            if (offset > file.length() - length) return "";
            byte[] bytes = new byte[length];
            file.seek(offset);
            file.readFully(bytes);
            return Base64.encodeToString(bytes, Base64.NO_WRAP);
        } catch (IOException failure) {
            return "";
        }
    }
}
