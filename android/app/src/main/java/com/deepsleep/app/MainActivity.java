package com.deepsleep.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.util.Log;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.os.Message;
import android.webkit.JavascriptInterface;
import android.os.StrictMode;
import android.database.Cursor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileWriter;
import android.util.Base64;
import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 用本地 HTTP 服务把 assets 里的前端喂给 WebView。
 *
 * 为什么不用 file://：WebView 的 file:// 源算 "null"，请求 api.deepseek.com 会被 CORS 拦，
 * 而且 localStorage/IndexedDB 在 file:// 下行为不一致。起一个 127.0.0.1 的回环服务，
 * 前端就有一个正常的 http 源，行为跟浏览器里一致。
 */
public class MainActivity extends Activity {
    private static final String TAG = "deepsleep";
    // 端口只在 app/build.gradle.kts 的 flavor 里定义一处：稳定线 8731、试验线 8732。
    // 端口就是 WebView 的 origin，换端口等于换存储命名空间（见 flavor 上的注释）。
    private static final int PORT = BuildConfig.PORT;
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_CAMERA = 1002;
    private static final int REQ_SAVE_ARCHIVE = 1003;
    private File cameraOutput;
    private PermissionRequest pendingAudioRequest;
    private static final int REQ_RECORD_AUDIO = 2001;
    private ValueCallback<Uri[]> filePathCallback;
    private WebView web;
    /** 强引用 JS 桥对象：只被行内表达式引用的话，GC 之后桥就失效了（见 addJavascriptInterface 处的注释）。 */
    private Object nativeBridge;
    /** 白屏诊断与自动恢复 */
    private BlankScreenGuard blankGuard;
    /** 渲染进程重建次数：只在本进程内累计，页面正常加载后归零（不能持久化，否则装一次就永久用完） */
    private static int rendererRebuilds = 0;
    /** 一次性诊断快照（白屏定案用） */
    private DiagnosticSnapshot snapshot;

    /** 诊断快照专用：以 [snap] 前缀落盘，便于导出后整段抓取 */
    void logSnapshot(String line) {
        appendLogLine(new java.util.Date().toInstant().toString() + " " + line);
    }

    /** 原生侧自己的日志（本地服务、生命周期等），与守卫的 [blank] 区分开 */
    void logNative(String line) {
        appendLogLine(new java.util.Date().toInstant().toString() + " INFO [native] " + line);
    }

    /**
     * 供 BlankScreenGuard 等辅助类写日志。
     *
     * 之前这里只打 Log.i、不进日志文件，结果白屏守卫的判断在导出日志里完全看不到，
     * 排查等于盲飞——所以必须同时落盘。
     */
    void logFromGuard(String line) {
        android.util.Log.i(TAG, line);
        appendLogLine(new java.util.Date().toInstant().toString() + " INFO [blank] " + line);
    }

    // ---- 运行日志：前端把已脱敏的行交过来，这里顺序写到外部私有目录（用户能翻到） ----
    private static final String LOG_FILE = "deepsleep.log";
    /** 单文件上限；超了滚成 .1，只留一份历史，别把用户空间吃掉 */
    private static final long LOG_MAX_BYTES = 2L * 1024 * 1024;
    private final Object logLock = new Object();

    private File logDir() {
        File base = getExternalFilesDir("logs");
        if (base == null) {
            // 外部存储不可用时退回内部目录：用户翻不到，但日志不丢
            base = new File(getFilesDir(), "logs");
        }
        if (!base.exists() && !base.mkdirs()) {
            return null;
        }
        return base;
    }

    /** 读取日志文件尾部（最多 maxChars 个字符）；文件不存在返回空串 */
    private String readLogTailInternal(int maxChars) {
        File dir = logDir();
        if (dir == null) {
            return "";
        }
        File file = new File(dir, LOG_FILE);
        if (!file.exists()) {
            return "";
        }
        int limit = maxChars <= 0 ? 4000 : maxChars;
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(file, "r")) {
            long length = raf.length();
            int take = (int) Math.min(length, limit);
            byte[] buffer = new byte[take];
            raf.seek(length - take);
            raf.readFully(buffer);
            // 从中间切会劈开多字节字符，导致首行乱码：退到第一个换行之后
            int offset = 0;
            while (offset < take - 1 && !(buffer[offset] == '\n')) {
                offset += 1;
            }
            if (offset >= take - 1) {
                offset = 0;
            }
            return new String(buffer, offset, take - offset,
                    java.nio.charset.StandardCharsets.UTF_8);
        } catch (IOException error) {
            Log.w(TAG, "readLogTail failed: " + error.getMessage());
            return "";
        }
    }

    /** 追加一行；任何 IO 异常都吞掉——日志本身不该影响主流程 */
    private void appendLogLine(String line) {
        File dir = logDir();
        if (dir == null || line == null) {
            return;
        }
        synchronized (logLock) {
            File file = new File(dir, LOG_FILE);
            try {
                if (file.length() > LOG_MAX_BYTES) {
                    File rotated = new File(dir, LOG_FILE + ".1");
                    if (rotated.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        rotated.delete();
                    }
                    //noinspection ResultOfMethodCallIgnored
                    file.renameTo(rotated);
                }
                FileWriter writer = new FileWriter(file, true);
                try {
                    writer.write(line);
                    writer.write('\n');
                } finally {
                    writer.close();
                }
            } catch (Exception error) {
                Log.w(TAG, "appendLog failed: " + error.getMessage());
            }
        }
    }

    // ---- 归档保存：前端把导出的 ZIP 分块交过来，这里通过 SAF 打开的输出流顺序写盘 ----
    // 为什么需要它：WebView 里 `URL.createObjectURL(blob)` + `a.click()` 什么都不会发生
    // （没有 DownloadListener），导出的包必须由原生侧落盘，另一个 App / 官方网页版才拿得到。
    private static final int ARCHIVE_IDLE = 0;
    /** SAF 界面已拉起，等用户选位置。 */
    private static final int ARCHIVE_PICKING = 1;
    /** 输出流已打开，可以收块。 */
    private static final int ARCHIVE_OPEN = 2;
    private static final int ARCHIVE_FAILED = 3;
    /** 队列最多压 8 块（每块 ≤ 512 KiB 原文，约 4 MiB）：满了让 JS 退一步重试，不阻塞 JS 线程。 */
    private static final int ARCHIVE_QUEUE_CHUNKS = 8;
    /** finish/abort 等写线程收尾的上限；队列很浅，正常几十毫秒就结束。 */
    private static final long ARCHIVE_STOP_MS = 20000L;

    private final Object archiveLock = new Object();
    private final BlockingQueue<String> archiveQueue = new ArrayBlockingQueue<>(ARCHIVE_QUEUE_CHUNKS);
    private volatile int archiveState = ARCHIVE_IDLE;
    /** 失败原因，直接回给 JS 拼错误信息；空串表示还没有失败。 */
    private volatile String archiveError = "";
    /** 置位后写线程把队列里剩下的写完就收尾退出。 */
    private volatile boolean archiveStopping;
    /** 写线程已 flush + close，finish 才能给出落点。 */
    private volatile boolean archiveFlushed;
    private String archiveName = "";
    private Uri archiveUri;
    private OutputStream archiveOut;
    private Thread archiveWriter;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appendLogLine(new java.util.Date().toInstant().toString() + " INFO [native] onCreate");
        startServer();
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        // 不额外加硬件层：LAYER_TYPE_HARDWARE 只是多套一层离屏缓冲，不是「让它画出来」的开关，
        // 反而可能是白屏的诱因之一。BlankScreenGuard 目前只采样写日志，不做自动恢复。
        // 保持默认绘制路径；不根据历史结论强制软件层（会让正常机器的滚动变慢）
        web.setLayerType(View.LAYER_TYPE_NONE, null);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        web.setWebViewClient(new WebViewClient() {
            /**
             * 渲染进程被系统回收（导入大归档时最容易触发）后，这个 WebView 已经废了：
             * 不处理的话用户看到的是一张白页，而数据其实已经写进 IndexedDB。
             * 返回 true 表示自己接管：销毁旧实例并重建 Activity。
             */
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        appendLogLine(new java.util.Date().toInstant().toString()
                + " ERROR [native] renderer 被杀 didCrash=" + detail.didCrash());
                if (snapshot != null) {
                    snapshot.noteRendererGone(detail.didCrash());
                }
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                    return false;
                }
                // 把这个已经失效的 WebView 从视图树摘掉再销毁，然后重建 Activity：
                // onCreate 会重新建 WebView 并连本地服务，IndexedDB 里的数据不受影响。
                if (view != null) {
                    ViewGroup parent = (ViewGroup) view.getParent();
                    if (parent != null) {
                        parent.removeView(view);
                    }
                    view.destroy();
                }
                // 渲染进程反复死的时候不能无限重建：一个进程内最多重建 2 次
                int rebuilds = rendererRebuilds;
                if (rebuilds >= 2) {
                    logNative("renderer 连续被杀 " + rebuilds + " 次，停止重建");
                    return false;
                }
                rendererRebuilds = rebuilds + 1;
                recreate();
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(view, String.valueOf(request.getUrl()));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(view, url);
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                appendLogLine(new java.util.Date().toInstant().toString()
                        + " INFO [native] onPageCommitVisible " + url);
                if (snapshot != null) {
                    snapshot.noteCommitVisible();
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 与 JS 的 [boot] 打点对照：能判断白屏是「页面没加载出来」还是「加载了但脚本挂了」
                appendLogLine(new java.util.Date().toInstant().toString()
                        + " INFO [native] onPageFinished " + url);
                if (blankGuard != null) {
                    blankGuard.probe("page-finished");
                }
                if (snapshot != null) {
                // 页面正常加载过就说明渲染进程是健康的，计数归零
                rendererRebuilds = 0;
                    snapshot.notePageFinished(url);
                    for (long delay : new long[]{500L, 2000L, 5000L}) {
                        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                if (snapshot != null) {
                                    snapshot.capture("after-load");
                                }
                            }
                        }, delay);
                    }
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                appendLogLine(new java.util.Date().toInstant().toString()
                        + " ERROR [native] onReceivedError " + error.getErrorCode()
                        + " " + error.getDescription() + " " + request.getUrl());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            /**
             * 把 JS 的 console 输出转进 logcat。APK 里没有 chrome://inspect，
             * 「导出失败：xxx」这种报错如果只在 WebView 控制台里，`adb logcat` 一无所获。
             */
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.i("deepsleep", message.messageLevel() + ": " + message.message()
                        + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        boolean mic = false;
                        for (String r : request.getResources()) {
                            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) mic = true;
                        }
                        if (!mic) {
                            request.deny();
                            return;
                        }
                        // 页面已经请求麦克风，但 Android 运行时权限可能还没批；
                        // 先补一次系统授权，拿到结果后再把 WebView 的请求批准掉。
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                                && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                                != PackageManager.PERMISSION_GRANTED) {
                            pendingAudioRequest = request;
                            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
                            return;
                        }
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    }
                });
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                         Message resultMsg) {
                // 页面里的 target=_blank / window.open 默认没有容器，会把用户丢到浏览器里，
                // 回来时又没有返回栈。这里直接在当前 WebView 打开，返回键可以退回对话。
                WebView.HitTestResult result = view.getHitTestResult();
                String data = result == null ? null : result.getExtra();
                if (data != null && (data.startsWith("http://") || data.startsWith("https://"))) {
                    Intent intent = new Intent(MainActivity.this, BrowserActivity.class);
                    intent.putExtra("url", data);
                    startActivity(intent);
                    return true;
                }
                // blob: / data: 这类地址只在本进程的渲染器里有效，交给新窗口也打不开——之前
                // 返回 false 会让 WebView 建出一个空白窗口（黑屏），返回键再把页面历史弹掉，
                // 用户就回到「新对话」了。这里不提供窗口（不调用 sendToTarget），静默丢弃。
                Log.i(TAG, "onCreateWindow dropped: " + data);
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // 没有这个回调，页面里的 <input type=file> 点了不会有任何反应。
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    // 用 ACTION_OPEN_DOCUMENT 而不是 params.createIntent()（后者是 GET_CONTENT），
                    // 前者会打开系统文件管理器的分类界面（图片/视频/音频/文档…），并支持多选。
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    // accept 可能有两种形态：真正的 MIME（相册传 image/*）和扩展名列表
                    // （文件传 .pdf,.docx,…）。两者都要能映射成 MIME，否则
                    // `setType("*/*")` 会让相册退化成「全部文件」，用户能点进 HEIC/AVIF
                    // 这类本机解不了的格式——表现就是「选完图什么都没发生」。
                    String[] accept = params.getAcceptTypes();
                    java.util.LinkedHashSet<String> mimes = new java.util.LinkedHashSet<>();
                    if (accept != null) {
                        for (String candidate : accept) {
                            if (candidate == null || candidate.isEmpty()) {
                                continue;
                            }
                            if (candidate.contains("/")) {
                                mimes.add(candidate);
                                continue;
                            }
                            String ext = candidate.startsWith(".") ? candidate.substring(1) : candidate;
                            String mapped = android.webkit.MimeTypeMap.getSingleton()
                                    .getMimeTypeFromExtension(ext.toLowerCase(java.util.Locale.ROOT));
                            if (mapped != null) {
                                mimes.add(mapped);
                            }
                        }
                    }
                    if (mimes.isEmpty()) {
                        intent.setType("*/*");
                    } else if (mimes.size() == 1) {
                        intent.setType(mimes.iterator().next());
                    } else {
                        // 多个具体类型：EXTRA_MIME_TYPES 配合 */* 才是正确的多类型过滤
                        intent.setType("*/*");
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                    }
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    appendLogLine(new java.util.Date().toInstant().toString() + " INFO [chooser] ask"
                            + " accept=" + java.util.Arrays.toString(accept)
                            + " mimes=" + mimes
                            + " mode=" + params.getMode());
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    appendLogLine(new java.util.Date().toInstant().toString() + " ERROR [chooser] launch failed: " + e);
                    filePathCallback = null;
                    return false;
                }
            }
        });
        // 必须用字段强引用这个对象：`addJavascriptInterface` 传一个行内匿名对象时，
        // GC 之后 JS 侧的调用会报 “Java bridge method can't be invoked on a non-injected object”
        // ——导入 364 MB 归档之后内存压力一大就复现，导出正好撞上。
        nativeBridge = new Object() {
            @JavascriptInterface
            public boolean hasNativePicker() {
                return true;
            }

            @JavascriptInterface
            public void takePhoto() {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        openCamera();
                    }
                });
            }

            /**
             * 导出的 ZIP 分块落地。
             *
             * 这些方法在 WebView 的 JavaBridge 线程上同步返回：除了拉起 SAF 界面必须回主线程，
             * 其余只碰内存里的队列，真正的写盘在 archiveWriter 上，不占主线程。
             */
            @JavascriptInterface
            public boolean beginArchiveSave(String name) {
                boolean accepted = startArchiveSave(name);
                // 桥上的每一步都留痕：APK 里没有 chrome://inspect，导出出问题只能看 logcat。
                Log.i(TAG, "beginArchiveSave(" + name + ") -> " + accepted + " state=" + archiveState);
                return accepted;
            }

            @JavascriptInterface
            public boolean isArchiveSaveReady() {
                return archiveState == ARCHIVE_OPEN;
            }

            /** 失败原因；空串表示还没失败（用户正在选位置时也是空串）。 */
            @JavascriptInterface
            public String getArchiveSaveError() {
                return archiveError;
            }

            @JavascriptInterface
            public boolean writeArchiveChunk(String base64) {
                boolean accepted = enqueueArchiveChunk(base64);
                if (!accepted) {
                    Log.w(TAG, "writeArchiveChunk rejected state=" + archiveState + " err=" + archiveError);
                }
                return accepted;
            }

            @JavascriptInterface
            public String finishArchiveSave() {
                String path = completeArchiveSave();
                Log.i(TAG, "finishArchiveSave -> \"" + path + "\" err=" + archiveError);
                return path;
            }

            @JavascriptInterface
            public void abortArchiveSave() {
                if (archiveState != ARCHIVE_IDLE) {
                    settleArchiveSave("aborted");
                }
            }

            /**
             * 前端运行日志落盘：写到 Android/data/<包名>/files/logs/deepsleep.log。
             *
             * 为什么 logcat 不够：群里反馈问题的人不会 adb，能让他们用文件管理器翻到
             * 这个目录把文件发过来才是最现实的路径；logcat 只保留最近几分钟。
             * 只接收前端已经脱敏过的行（不含对话正文与 Key）。
             */
            @JavascriptInterface
            public void appendLog(String line) {
                appendLogLine(line);
            }

            /**
             * 原生日志的最后 N 行（默认 4000 字符）。导出的日志要同时包含
             * 前端事件与原生 onCreate/onPageFinished，否则只有一半证据。
             */

            /**
             * 写系统剪贴板。
             *
             * WebView 里 `navigator.clipboard.writeText` 经常直接抛 NotAllowedError
             * （缺 clipboard-write 授权、调用链也不一定是用户手势），用户会看到「复制失败」。
             * 走原生最稳。
             */
            @JavascriptInterface
            public boolean copyToClipboard(String text) {
                if (text == null) {
                    return false;
                }
                try {
                    // 先确认拿得到剪贴板服务，拿不到就别谎报成功
                    android.content.ClipboardManager probe =
                            (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (probe == null) {
                        return false;
                    }
                    final String value = text;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            android.content.ClipboardManager manager =
                                    (android.content.ClipboardManager)
                                            getSystemService(CLIPBOARD_SERVICE);
                            if (manager != null) {
                                manager.setPrimaryClip(
                                        android.content.ClipData.newPlainText("deepsleep", value));
                            }
                        }
                    });
                    return true;
                } catch (Throwable error) {
                    Log.w(TAG, "copyToClipboard failed: " + error.getMessage());
                    return false;
                }
            }

            /** 原生日志的最后 N 个字符：导出的日志要同时含前端事件与原生生命周期 */
            @JavascriptInterface
            public String readLogTail(int maxChars) {
                return readLogTailInternal(maxChars);
            }

            /** 日志文件绝对路径，界面上展示给用户，方便自己去找 */
            @JavascriptInterface
            public String getLogPath() {
                File dir = logDir();
                return dir == null ? "" : new File(dir, LOG_FILE).getAbsolutePath();
            }
        };
        web.addJavascriptInterface(nativeBridge, "__deepsleepNative");
        // 守卫只做观测：不切绘制路径、不 recreate。上一版会自动恢复，
        // 在浅色主题（本来就是白底）上被误判成白屏，导致 recreate 无限循环。
        blankGuard = new BlankScreenGuard(this, web, new BlankScreenGuard.Host() {
            @Override
            public void log(String line) {
                logFromGuard(line);
            }
        });
        setContentView(web);
        blankGuard.attachDrawListener();
        snapshot = new DiagnosticSnapshot(this, web, new DiagnosticSnapshot.Sink() {
            @Override
            public void write(String block) {
                for (String line : block.split("\n")) {
                    if (!line.isEmpty()) {
                        logSnapshot(line);
                    }
                }
            }
        });
        snapshot.attachListeners();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1);
        }
        web.loadUrl("http://127.0.0.1:" + PORT + "/index.html");
        appendLogLine(new java.util.Date().toInstant().toString() + " INFO [native] loadUrl " + PORT);
    }

    /**
     * 唤起系统相机并把原图写进应用缓存。
     *
     * WebView 的 <input capture> 在多数国产 ROM 上不会拉起相机，所以相机走原生 Intent；
     * Android 7 之后 FileUriExposure 会拦下 file:// 的 EXTRA_OUTPUT，这里只为这一次
     * 调用临时放开（应用私有缓存目录，不接受外部输入）。
     */
    /** 本地资源站内跳转；外部链接也留在当前 WebView，保证返回键能退回对话。 */
    private boolean handleUrl(WebView view, String url) {
        if (url == null) {
            return false;
        }
        if (url.startsWith("http://127.0.0.1:" + PORT)) {
            return false;
        }
        if (url.startsWith("http://") || url.startsWith("https://")) {
            // 单独开一个浏览 Activity：对话页保持原状，返回时不会重新加载 SPA。
            Intent intent = new Intent(this, BrowserActivity.class);
            intent.putExtra("url", url);
            startActivity(intent);
            return true;
        }
        return false;
    }

    private void openCamera() {
        try {
            cameraOutput = new File(getCacheDir(), "photo_" + System.currentTimeMillis() + ".jpg");
            StrictMode.VmPolicy.Builder builder = new StrictMode.VmPolicy.Builder();
            StrictMode.setVmPolicy(builder.build());
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, Uri.fromFile(cameraOutput));
            startActivityForResult(intent, REQ_CAMERA);
        } catch (Exception error) {
            cameraOutput = null;
        }
    }

    private void deliverPhoto(File file) {
        try {
            byte[] bytes = new byte[(int) file.length()];
            FileInputStream input = new FileInputStream(file);
            input.read(bytes);
            input.close();
            String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
            final String script = "window.__deepsleepPhoto && window.__deepsleepPhoto('" + base64 + "','"
                    + file.getName() + "')";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    web.evaluateJavascript(script, null);
                }
            });
        } catch (Exception ignored) {
        } finally {
            if (file.exists()) file.delete();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_RECORD_AUDIO) {
            return;
        }
        PermissionRequest pending = pendingAudioRequest;
        pendingAudioRequest = null;
        if (pending == null) {
            return;
        }
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            pending.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pending.deny();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SAVE_ARCHIVE) {
            openArchiveTarget(resultCode, data);
            return;
        }
        if (requestCode == REQ_CAMERA) {
            if (resultCode == RESULT_OK && cameraOutput != null && cameraOutput.length() > 0) {
                deliverPhoto(cameraOutput);
            }
            cameraOutput = null;
            return;
        }
        if (requestCode == REQ_FILE_CHOOSER) {
            Uri[] uris = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            appendLogLine(new java.util.Date().toInstant().toString() + " INFO [chooser] result"
                    + " code=" + resultCode
                    + " uris=" + (uris == null ? "null" : String.valueOf(uris.length)));
            // 把读取权限持久化：导入几百 MB 的归档要跑好几分钟，中途 Activity 重建后
            // content:// 的临时授权就没了，用户得重新选一次文件才能续传。
            // 云盘/部分文件管理器不支持持久授权，失败也不影响本次导入。
            if (uris != null) {
                for (Uri uri : uris) {
                    try {
                        getContentResolver().takePersistableUriPermission(
                                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    } catch (SecurityException | IllegalArgumentException ignored) {
                        // 该 Uri 不支持持久授权，忽略。
                    }
                }
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(uris);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /**
     * 生命周期留痕 + 回前台时重新挂载 WebView。
     * 注意：早期版本在回前台时做过「隐藏→显示」重挂，那是闪屏的直接来源且对白屏无效，已删除；
     * 现在回前台只 invalidate。
     */
    @Override
    protected void onPause() {
        appendLogLine(new java.util.Date().toInstant().toString() + " INFO [native] onPause"
                + " hasFocus=" + hasWindowFocus() + " webViewShown=" + (web != null && web.isShown()));
        if (snapshot != null) {
            snapshot.capture("pause");
        }
        if (web != null) {
        }
        super.onPause();
    }

    @Override
    protected void onStop() {
        appendLogLine(new java.util.Date().toInstant().toString() + " INFO [native] onStop");
        super.onStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        appendLogLine(new java.util.Date().toInstant().toString() + " INFO [native] onResume");
        if (web == null) {
            return;
        }
        web.resumeTimers();
        if (blankGuard != null) {
            blankGuard.probe("resume");
        if (snapshot != null) {
            snapshot.capture("resume");
        }
        }
        web.invalidate();
        // 不再做「隐藏→显示」的重挂：那是闪屏的直接来源，而且对白屏没起作用。
        web.invalidate();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        appendLogLine(new java.util.Date().toInstant().toString()
                + " INFO [native] onConfigurationChanged ori=" + newConfig.orientation
                + " uiMode=" + newConfig.uiMode + " w=" + newConfig.screenWidthDp
                + " h=" + newConfig.screenHeightDp + " density=" + newConfig.densityDpi);
        super.onConfigurationChanged(newConfig);
    }

    @Override
    protected void onDestroy() {
        // 记录销毁原因：recreate 循环的现场全靠这行区分
        appendLogLine(new java.util.Date().toInstant().toString()
                + " INFO [native] onDestroy isFinishing=" + isFinishing());
        Uri partial = null;
        synchronized (archiveLock) {
            if (archiveState != ARCHIVE_IDLE) {
                // 流是绑在这个 Activity 上的：重建之后没人会把剩下的块补进来，
                // 继续写只会留下一个坏 ZIP，所以直接置失败态。
                archiveState = ARCHIVE_FAILED;
                if (archiveError.isEmpty()) {
                    archiveError = "activity destroyed";
                }
                archiveQueue.clear();
                partial = archiveUri;
                archiveUri = null;
            }
        }
        // 主线程不等写线程（也不替它关流）：置位叫它自己收尾，这里只删半成品文件。
        archiveStopping = true;
        archiveWriter = null;
        deleteArchiveDocument(partial);
        // 先取消守卫的延迟采样：否则回调会落在已销毁的 WebView 上（泄漏 + busy 卡死）
        if (snapshot != null) {
            snapshot.dispose();
            snapshot = null;
        }
        if (blankGuard != null) {
            blankGuard.dispose();
            blankGuard = null;
        }
        // WebView 必须显式销毁：否则它的渲染线程与 Context 会跟着泄漏，
        // 多次重建后容易表现为「页面在、画面空」。
        if (web != null) {
            ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) {
                parent.removeView(web);
            }
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    // ---- 归档保存的实现 ----------------------------------------------------------

    /** 拉起 SAF 建文档；同一时刻只允许一个保存任务。 */
    private boolean startArchiveSave(String name) {
        if (archiveState == ARCHIVE_FAILED) {
            // 上一次失败可能留下半成品文档（页面被刷掉时没人来得及 abort），先清掉再开新的。
            settleArchiveSave("previous save did not finish");
        }
        synchronized (archiveLock) {
            // FAILED 与 IDLE 都表示「没有在跑的保存」：失败原因留给 JS 读，下一次 begin 会清掉。
            if (archiveState == ARCHIVE_PICKING || archiveState == ARCHIVE_OPEN) {
                return false;
            }
            Thread previous = archiveWriter;
            if (previous != null && previous.isAlive()) {
                // 上一次还没收尾：两条线程抢同一个队列会把数据写串。
                return false;
            }
            archiveState = ARCHIVE_PICKING;
            archiveError = "";
            archiveName = archiveFileName(name);
            archiveFlushed = false;
            archiveStopping = false;
            archiveOut = null;
            archiveUri = null;
            archiveQueue.clear();
        }
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                openArchiveChooser();
            }
        });
        return true;
    }

    /** 保存对话框的 MIME：日志是纯文本，归档才是 zip */
    private static String mimeFor(String name) {
        String lower = name == null ? "" : name.toLowerCase();
        if (lower.endsWith(".txt") || lower.endsWith(".log")) {
            return "text/plain";
        }
        if (lower.endsWith(".zip")) {
            return "application/zip";
        }
        return "application/octet-stream";
    }

    private void openArchiveChooser() {
        try {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mimeFor(archiveName));
            intent.putExtra(Intent.EXTRA_TITLE, archiveName);
            startActivityForResult(intent, REQ_SAVE_ARCHIVE);
        } catch (Exception error) {
            // 没有文件管理器、或被 ROM 拦掉：JS 靠 getArchiveSaveError 拿到原因再 abort。
            settleArchiveSave("cannot open the file chooser: " + describe(error));
        }
    }

    /** SAF 回调：输出流必须在这里打开（写权限绑在这次 result 上），之后交给写线程。 */
    private void openArchiveTarget(int resultCode, Intent data) {
        Log.i(TAG, "openArchiveTarget resultCode=" + resultCode + " data=" + data);
        Uri target = data == null ? null : data.getData();
        if (resultCode != RESULT_OK || target == null) {
            settleArchiveSave("cancelled");
            return;
        }
        if (archiveState != ARCHIVE_PICKING) {
            // 选位置期间 Activity 重建或被 abort 了，这次结果作废；刚建的空文档删掉。
            archiveUri = target;
            settleArchiveSave("cancelled before the stream opened");
            return;
        }
        try {
            OutputStream out = getContentResolver().openOutputStream(target, "w");
            if (out == null) {
                throw new IOException("openOutputStream returned null");
            }
            archiveUri = target;
            archiveOut = out;
            archiveState = ARCHIVE_OPEN;
            startArchiveWriter();
        } catch (Exception error) {
            archiveUri = target;
            settleArchiveSave("cannot open the target file: " + describe(error));
        }
    }

    /** 只入队不落盘：JavaBridge 线程上不碰磁盘；队列满就返回 false 让 JS 退一步重试。 */
    private boolean enqueueArchiveChunk(String base64) {
        if (base64 == null || base64.isEmpty()) {
            return archiveState == ARCHIVE_OPEN;
        }
        if (archiveState != ARCHIVE_OPEN) {
            return false;
        }
        return archiveQueue.offer(base64);
    }

    /** flush + close 之后返回落点；任何一步没成返回空串（原因在 archiveError 里）。 */
    private String completeArchiveSave() {
        if (archiveState == ARCHIVE_PICKING) {
            settleArchiveSave("finish called before the file location was chosen");
            return "";
        }
        if (archiveState != ARCHIVE_OPEN) {
            return "";
        }
        stopArchiveWriter();
        if (!archiveFlushed || archiveState != ARCHIVE_OPEN) {
            return "";
        }
        Uri saved = archiveUri;
        synchronized (archiveLock) {
            archiveState = ARCHIVE_IDLE;
            archiveError = "";
            archiveUri = null;
            archiveOut = null;
        }
        return archivePathOf(saved);
    }

    /** 置失败态并记原因；已经失败过就保留第一次的原因（第一次最接近现场）。 */
    private void markArchiveFailed(String reason) {
        synchronized (archiveLock) {
            if (archiveState == ARCHIVE_IDLE) {
                return;
            }
            archiveState = ARCHIVE_FAILED;
            if (archiveError.isEmpty()) {
                archiveError = reason == null || reason.isEmpty() ? "save failed" : reason;
            }
        }
    }

    /** 收尾：清队列、等写线程退出、关流、删半成品——失败时不在 Downloads 里留坏文件。 */
    private void settleArchiveSave(String reason) {
        Log.w(TAG, "settleArchiveSave(" + reason + ") state=" + archiveState);
        if (archiveState == ARCHIVE_IDLE && archiveUri == null && archiveOut == null) {
            return;
        }
        markArchiveFailed(reason);
        archiveQueue.clear();
        stopArchiveWriter();
        discardArchiveOutput();
    }

    /** 叫写线程把剩余块写完再退出（队列已清空时立刻退出），并等它真的结束。 */
    private void stopArchiveWriter() {
        archiveStopping = true;
        Thread writer = archiveWriter;
        archiveWriter = null;
        if (writer == null) {
            return;
        }
        try {
            writer.join(ARCHIVE_STOP_MS);
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        }
    }

    private void startArchiveWriter() {
        final OutputStream out = archiveOut;
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    // 队列空就等一会儿；archiveStopping 置位后把剩下的块写完再收尾。
                    while (!archiveStopping || !archiveQueue.isEmpty()) {
                        String chunk = archiveQueue.poll(100, TimeUnit.MILLISECONDS);
                        if (chunk == null) {
                            continue;
                        }
                        out.write(Base64.decode(chunk, Base64.DEFAULT));
                    }
                    out.flush();
                    out.close();
                    archiveFlushed = true;
                } catch (InterruptedException stopped) {
                    Thread.currentThread().interrupt();
                    closeArchiveStream(out);
                    markArchiveFailed("writer interrupted");
                } catch (IOException | IllegalArgumentException failure) {
                    // 磁盘满 / provider 收回授权 / base64 坏了：流已不可信，收尾留给调用方。
                    closeArchiveStream(out);
                    markArchiveFailed(describe(failure));
                }
            }
        });
        thread.setDaemon(true);
        thread.setName("archive-writer");
        archiveWriter = thread;
        thread.start();
    }

    private void discardArchiveOutput() {
        OutputStream out = archiveOut;
        archiveOut = null;
        if (out != null) {
            closeArchiveStream(out);
        }
        Uri uri = archiveUri;
        archiveUri = null;
        deleteArchiveDocument(uri);
    }

    private void deleteArchiveDocument(Uri uri) {
        if (uri == null) {
            return;
        }
        try {
            // 半截 ZIP 没有用处：删掉比留一个坏文件好；provider 不支持删除就算了。
            DocumentsContract.deleteDocument(getContentResolver(), uri);
        } catch (Exception ignored) {
        }
    }

    private static void closeArchiveStream(OutputStream out) {
        try {
            out.close();
        } catch (IOException ignored) {
            // 写线程已经关过，或者 provider 出错后不再接受 close
        }
    }

    private static String describe(Exception failure) {
        String name = failure.getClass().getSimpleName();
        String message = failure.getMessage();
        return message == null || message.isEmpty() ? name : name + ": " + message;
    }

    /** SAF 的 EXTRA_TITLE 只是个建议名：抹掉路径分隔符，并保证带上 .zip。 */
    private static String archiveFileName(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (clean.isEmpty()) {
            clean = "deepsleep-history.zip";
        }
        // 只有没扩展名时才补 .zip：日志导出传的是 .txt，之前被强改成 .txt.zip，
        // 内容仍是纯文本，用户双击打不开（报「压缩包损坏」）。
        int dot = clean.lastIndexOf('.');
        return dot > 0 && dot < clean.length() - 1 ? clean : clean + ".zip";
    }

    /**
     * 给 JS 一个能看的落点。
     *
     * `primary:` 形态的 documentId 就是真实路径；但 Downloads provider 给的是**数字行号**
     * （实测选了「下载」之后拿到 `document/3`），直接回显会变成「已保存到 3」，对用户没有意义。
     * 所以数字 id 时再去问 provider 要显示名与相对目录（API 29+），拼出 /storage/emulated/0/…
     * 拼不出来就退回 uri，至少比一个裸数字强。
     */
    private String archivePathOf(Uri uri) {
        if (uri == null) {
            return "";
        }
        try {
            String id = DocumentsContract.getDocumentId(uri);
            if (id != null && id.startsWith("primary:")) {
                return "/storage/emulated/0/" + id.substring("primary:".length());
            }
            String name = queryColumn(uri, OpenableColumns.DISPLAY_NAME);
            String relative = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? queryColumn(uri, MediaStore.MediaColumns.RELATIVE_PATH)
                    : null;
            if (name != null && !name.isEmpty()) {
                if (relative != null && !relative.isEmpty()) {
                    return "/storage/emulated/0/" + relative + name;
                }
                if (isDownloadsAuthority(uri)) {
                    return "/storage/emulated/0/Download/" + name;
                }
                return name;
            }
        } catch (Exception ignored) {
            // 不是 DocumentsProvider 的 uri：没有 documentId 可读。
        }
        return uri.toString();
    }

    private static boolean isDownloadsAuthority(Uri uri) {
        String authority = uri.getAuthority();
        return authority != null && authority.startsWith("com.android.providers.downloads");
    }

    /** 读一列字符串；provider 不认这一列时返回 null。 */
    private String queryColumn(Uri uri, String column) {
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri, new String[]{column}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(column);
                if (index >= 0 && !cursor.isNull(index)) {
                    return cursor.getString(index);
                }
            }
        } catch (Exception ignored) {
            // 该 provider 不支持这一列。
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /** 本地 HTTP 服务是进程级的：Activity 重建（旋转/配置变化/recreate）不应再起一份 */
    private static volatile boolean serverStarted = false;

    private void startServer() {
        synchronized (MainActivity.class) {
            if (serverStarted) {
                logNative("本地服务已在运行，跳过重复启动");
                return;
            }
            serverStarted = true;
        }
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try (ServerSocket server = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"))) {
                    while (!Thread.currentThread().isInterrupted()) {
                        final Socket socket = server.accept();
                        new Thread(new Runnable() {
                            @Override
                            public void run() {
                                handle(socket);
                            }
                        }).start();
                    }
                } catch (IOException error) {
                    // 端口被占（上一次进程没退干净）时不再静默：留一行给诊断，
                    // 并且复位标志——否则这次失败会让以后每次重建都跳过启动，等于没有服务
                    synchronized (MainActivity.class) {
                        serverStarted = false;
                    }
                    logNative("本地服务启动失败：" + error.getMessage());
                }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    private static String mime(String path) {
        Map<String, String> m = new HashMap<>();
        m.put("html", "text/html; charset=utf-8");
        m.put("js", "application/javascript; charset=utf-8");
        m.put("mjs", "application/javascript; charset=utf-8");
        m.put("css", "text/css; charset=utf-8");
        m.put("json", "application/json; charset=utf-8");
        m.put("webmanifest", "application/manifest+json; charset=utf-8");
        m.put("svg", "image/svg+xml");
        m.put("png", "image/png");
        m.put("jpg", "image/jpeg");
        m.put("jpeg", "image/jpeg");
        m.put("webp", "image/webp");
        m.put("ico", "image/x-icon");
        m.put("woff", "font/woff");
        m.put("woff2", "font/woff2");
        m.put("ttf", "font/ttf");
        m.put("map", "application/json");
        int dot = path.lastIndexOf('.');
        String ext = dot < 0 ? "" : path.substring(dot + 1).toLowerCase();
        return m.getOrDefault(ext, "application/octet-stream");
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            InputStream in = s.getInputStream();
            StringBuilder head = new StringBuilder();
            int c;
            while ((c = in.read()) != -1) {
                head.append((char) c);
                int n = head.length();
                if (n >= 4 && head.charAt(n - 4) == '\r' && head.charAt(n - 3) == '\n'
                        && head.charAt(n - 2) == '\r' && head.charAt(n - 1) == '\n') break;
                if (n > 8192) break;
            }
            String first = head.toString().split("\r\n", 2)[0];
            String[] parts = first.split(" ");
            String path = parts.length > 1 ? parts[1] : "/";
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
            if (path.equals("/") || path.isEmpty()) path = "/index.html";
            if (path.startsWith("/")) path = path.substring(1);

            OutputStream out = s.getOutputStream();
            InputStream asset;
            try {
                asset = getAssets().open("web/" + path);
            } catch (IOException missing) {
                byte[] body = "404".getBytes("UTF-8");
                out.write(("HTTP/1.1 404 Not Found\r\nContent-Length: " + body.length
                        + "\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
                out.write(body);
                out.flush();
                return;
            }
            byte[] buf = new byte[8192];
            java.io.ByteArrayOutputStream data = new java.io.ByteArrayOutputStream();
            int r;
            while ((r = asset.read(buf)) > 0) data.write(buf, 0, r);
            asset.close();
            byte[] body = data.toByteArray();
            String header = "HTTP/1.1 200 OK\r\nContent-Type: " + mime(path) + "\r\nContent-Length: "
                    + body.length + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
            out.write(header.getBytes("UTF-8"));
            out.write(body);
            out.flush();
        } catch (IOException ignored) {
        }
    }
}




