package com.deepsleep.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.PixelCopy;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 白屏**诊断**工具（默认只观测，不动手）。
 *
 * 背景与教训：
 * 1. 第一版用「屏幕是不是白的」当判据 —— 错得离谱：我们的浅色主题本来就是白底，
 *    设置面板整屏白、`bodyText` 274 是正常状态，却被判成白屏并触发恢复，
 *    结果 `recreate()` 无限循环，用户连 API Key 都填不了（实测 10 分钟 48 次 onCreate）。
 * 2. 第二版想用 `WebView#draw()` 到 Bitmap 判断「画没画」—— 也不可靠：
 *    硬件加速下 WebView 画进软件 Canvas 经常是空白，于是被当成「渲染问题」照样恢复。
 *
 * 所以现在：**只采样、只记录，绝不自动改绘制路径、绝不 recreate**。
 * 真要自动恢复，必须满足「有可验证的判据」这一前提，目前没有。
 *
 * 记录内容（前缀 [blank]，会进日志文件）：
 *   probe(...)   —— 一次采样的完整读数：文本量、屏幕非白比例、自绘非白比例
 */
final class BlankScreenGuard {

    interface Host {
        /** 写一行日志——必须进日志文件，否则等于没记 */
        void log(String line);
    }

    /** 采样点（相对高度） */
    private static final float[] SAMPLE_RATIOS = {0.25f, 0.5f, 0.75f};
    private static final int SAMPLE_SIZE = 48;
    /** 非白判定：像素亮度低于这个值算「有内容」 */
    private static final int CONTENT_LEVEL = 240;

    private final Activity activity;
    private final WebView web;
    private final Host host;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final AtomicBoolean busy = new AtomicBoolean(false);

    BlankScreenGuard(Activity activity, WebView web, Host host) {
        this.activity = activity;
        this.web = web;
        this.host = host;
    }

    /**
     * 采样一次并记录。
     *
     * 只读取两类数字：屏幕三块区域的「非白像素比例」与 WebView 自绘的「非白像素比例」。
     * 两者都不足以单独判定白屏，所以这里不做任何结论，只把读数写进日志，
     * 由人工（或以后有可靠判据时）判断。
     */
    /**
     * 取消所有待执行的采样回调。
     *
     * 曾经没有这个方法：probe() 的 1.2 秒延迟回调会在 Activity 销毁后照常触发，
     * 作用在已经 destroy() 的 WebView 上（evaluateJavascript / PixelCopy），
     * 既泄漏旧实例，也让 busy 永远卡在 true。onDestroy 里必须先调用它。
     */
    void dispose() {
        handler.removeCallbacksAndMessages(null);
        busy.set(false);
    }

    void probe(final String reason) {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                measure(reason);
            }
        }, 1200);
    }

    private void measure(final String reason) {
        if (!busy.compareAndSet(false, true)) {
            return;
        }
        askTextLength(new TextCallback() {
            @Override
            public void onText(int textLength) {
                // 不因「文本少」跳过采样：用户反馈过「连 Key 都填不了」，
                // 那种空页文本量本来就低，恰恰是最需要读数的时候。
                sampleScreen(new SampleCallback() {
                    @Override
                    public void onSample(int nonWhitePermille, boolean captureFailed) {
                        int viewPermille = drawProbePermille();
                        busy.set(false);
                        host.log("probe(" + reason + "): 文本 " + textLength + " 字"
                                + "，屏幕非白 " + (captureFailed ? "抓取失败" : nonWhitePermille + "‰")
                                + "，自绘非白 " + viewPermille + "‰");
                    }
                });
            }
        });
    }

    // ---- 证据采集（只读） -------------------------------------------------------

    private void askTextLength(final TextCallback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) {
            callback.onText(0);
            return;
        }
        web.evaluateJavascript(
                "(function(){try{var b=document.body;return b?(b.innerText||'').trim().length:0}"
                        + "catch(e){return 0}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        int length = 0;
                        try {
                            length = Integer.parseInt(value.replaceAll("[^0-9]", ""));
                        } catch (NumberFormatException ignored) {
                            // 页面还没就绪
                        }
                        callback.onText(length);
                    }
                });
    }

    /** 抓三块窗口像素，返回「有内容像素」的千分比 */
    private void sampleScreen(final SampleCallback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            callback.onSample(0, true);
            return;
        }
        final int total = SAMPLE_RATIOS.length;
        final int[] remaining = {total};
        final int[] contentPixels = {0};
        final int[] sampled = {0};
        final boolean[] failed = {false};
        for (final float ratio : SAMPLE_RATIOS) {
            final int[] location = new int[2];
            web.getLocationInWindow(location);
            int x = Math.max(0, location[0] + web.getWidth() / 2 - SAMPLE_SIZE / 2);
            int y = Math.max(0, location[1] + (int) (web.getHeight() * ratio) - SAMPLE_SIZE / 2);
            final Bitmap shot = Bitmap.createBitmap(SAMPLE_SIZE, SAMPLE_SIZE, Bitmap.Config.ARGB_8888);
            try {
                PixelCopy.request(activity.getWindow(),
                        new android.graphics.Rect(x, y, x + SAMPLE_SIZE, y + SAMPLE_SIZE), shot,
                        new PixelCopy.OnPixelCopyFinishedListener() {
                            @Override
                            public void onPixelCopyFinished(int copyResult) {
                                if (copyResult != PixelCopy.SUCCESS) {
                                    failed[0] = true;
                                } else {
                                    int[] counts = countContent(shot);
                                    contentPixels[0] += counts[0];
                                    sampled[0] += counts[1];
                                }
                                shot.recycle();
                                remaining[0] -= 1;
                                if (remaining[0] == 0) {
                                    int permille =
                                            sampled[0] == 0 ? 0 : contentPixels[0] * 1000 / sampled[0];
                                    callback.onSample(permille, failed[0]);
                                }
                            }
                        }, handler);
            } catch (Exception error) {
                shot.recycle();
                failed[0] = true;
                remaining[0] -= 1;
                if (remaining[0] == 0) {
                    callback.onSample(0, true);
                }
            }
        }
    }

    /** 把 WebView 画进 Bitmap，返回「有内容像素」的千分比；失败返回 -1 */
    private int drawProbePermille() {
        int width = web.getWidth();
        int height = web.getHeight();
        if (width <= 0 || height <= 0) {
            return -1;
        }
        float scale = Math.min(1f, 240f / Math.max(width, height));
        int w = Math.max(1, Math.round(width * scale));
        int h = Math.max(1, Math.round(height * scale));
        Bitmap bitmap = null;
        try {
            bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.scale(scale, scale);
            web.draw(canvas);
            int[] counts = countContent(bitmap);
            return counts[1] == 0 ? 0 : counts[0] * 1000 / counts[1];
        } catch (Throwable error) {
            return -1;
        } finally {
            if (bitmap != null) {
                bitmap.recycle();
            }
        }
    }

    /** 返回 [有内容像素数, 采样总数] */
    private static int[] countContent(Bitmap bitmap) {
        int content = 0;
        int sampled = 0;
        for (int y = 0; y < bitmap.getHeight(); y += 2) {
            for (int x = 0; x < bitmap.getWidth(); x += 2) {
                int color = bitmap.getPixel(x, y);
                int level = (Color.red(color) + Color.green(color) + Color.blue(color)) / 3;
                sampled += 1;
                if (level < CONTENT_LEVEL) {
                    content += 1;
                }
            }
        }
        return new int[]{content, sampled};
    }

    private interface TextCallback {
        void onText(int length);
    }

    private interface SampleCallback {
        void onSample(int nonWhitePermille, boolean captureFailed);
    }
}
