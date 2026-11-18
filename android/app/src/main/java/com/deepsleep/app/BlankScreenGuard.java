package com.deepsleep.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.PixelCopy;
import android.view.View;
import android.webkit.WebView;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 白屏自愈。
 *
 * 背景：有用户反馈「界面整片白」，但页面自己的日志显示 DOM 完全正常
 * （#root 有子节点、尺寸正确、正文 60 字）。也就是说，问题在 Android 侧的绘制/合成，
 * 而不是网页本身——而这类问题没法靠改 CSS 或调 WebView 生命周期稳定绕过。
 *
 * 所以这里换成「量出来再修」：把屏幕上真实的像素抓下来（PixelCopy），
 * 同时问页面「你现在有多少字」。两个条件同时成立才认定为白屏：
 *   页面有内容（innerText 长度 > 20） && 屏幕几乎全白（三个采样区平均亮度都接近 255）
 *
 * 认定之后按代价从低到高尝试恢复，每一步都重新采样确认：
 *   1. LAYER_TYPE_NONE  + 重绘      —— 代价最低，不改绘制路径
 *   2. LAYER_TYPE_SOFTWARE + 重绘   —— 绕开 GPU 合成，代价是滚动/动画变慢
 *   3. 重建 WebView（由 Activity 负责）—— 会丢 JS 内存状态
 *
 * 每轮最多修 3 次、整个进程最多 3 次，避免陷入无限重建。
 */
final class BlankScreenGuard {

    interface Host {
        /** 需要重建 WebView 时调用（由 Activity 决定怎么重建） */
        void onNeedRebuild();
    }

    private static final String TAG_TASK = "blank-guard";

    /** 屏幕采样点（相对高度的比例） */
    private static final float[] SAMPLE_RATIOS = {0.25f, 0.5f, 0.75f};
    /** 采样边长（像素） */
    private static final int SAMPLE_SIZE = 48;
    /** 判定「白」的阈值：平均亮度 */
    private static final int WHITE_LEVEL = 248;
    /** 页面至少这么多字才算「有内容」，少于这个不判白（可能在欢迎页之前的空白态） */
    private static final int MIN_TEXT_LENGTH = 20;
    /** 整个进程最多恢复几次 */
    private static final int MAX_RECOVERIES = 3;

    private final Activity activity;
    private final WebView web;
    private final Host host;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final AtomicBoolean running = new AtomicBoolean(false);

    /** 当前阶段：0 = 原始，1 = NONE，2 = SOFTWARE，3 = 已要求重建 */
    private int stage = 0;
    private int recoveries = 0;
    /** 上一次恢复后是否已经通过复测 */
    private boolean verified = false;

    BlankScreenGuard(Activity activity, WebView web, Host host) {
        this.activity = activity;
        this.web = web;
        this.host = host;
    }

    void log(String line) {
        MainActivity.logFromGuard(line);
    }

    /** 页面加载完 / 回到前台时调用；内部有延迟与去重 */
    void verify(final String reason) {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                measureAndMaybeFix(reason);
            }
        }, 1200);
    }

    /** 恢复后复测：只测一次，不递归 */
    void verifyAfterFix(final String reason) {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                measureAfterFix(reason);
            }
        }, 600);
    }

    private void measureAndMaybeFix(final String reason) {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        askTextLength(new TextCallback() {
            @Override
            public void onText(int length) {
                if (length < MIN_TEXT_LENGTH) {
                    // 页面真的没内容（加载中/空态），不是白屏问题
                    log("skip(" + reason + "): 页面文本 " + length + " 字，判定未就绪");
                    running.set(false);
                    return;
                }
                sampleScreen(new SampleCallback() {
                    @Override
                    public void onSample(boolean white) {
                        running.set(false);
                        if (!white) {
                            if (recoveries > 0 && !verified) {
                                verified = true;
                                log("ok(" + reason + "): 恢复生效，当前 stage=" + stage);
                            } else {
                                // 没白也要留痕：否则「没白」与「守卫没跑」区分不开
                                log("checked(" + reason + "): 文本 " + length + " 字，采样非白");
                            }
                            return;
                        }
                        confirmThenRecover(reason, length);
                    }
                });
            }
        });
    }

    private void measureAfterFix(final String reason) {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        askTextLength(new TextCallback() {
            @Override
            public void onText(int length) {
                if (length < MIN_TEXT_LENGTH) {
                    running.set(false);
                    return;
                }
                sampleScreen(new SampleCallback() {
                    @Override
                    public void onSample(boolean white) {
                        running.set(false);
                        if (white) {
                            log("still-white(" + reason + "): stage=" + stage + " 未生效");
                            confirmThenRecover(reason, length);
                        } else {
                            verified = true;
                            log("ok(" + reason + "): 已恢复，stage=" + stage
                                    + "（软件层代价：滚动/动画较慢）");
                        }
                    }
                });
            }
        });
    }

    /** 一次全白可能是巧合（比如正开着白色面板），隔半秒再采一次才动手 */
    private void confirmThenRecover(final String reason, final int textLength) {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!running.compareAndSet(false, true)) {
                    return;
                }
                sampleScreen(new SampleCallback() {
                    @Override
                    public void onSample(boolean white) {
                        running.set(false);
                        if (white) {
                            recover(reason, textLength);
                        } else {
                            log("skip(" + reason + "): 第一次全白、复采正常，判为瞬态");
                        }
                    }
                });
            }
        }, 500);
    }

    private void recover(final String reason, final int textLength) {
        if (recoveries >= MAX_RECOVERIES || stage >= 3) {
            log("give-up(" + reason + "): 已恢复 " + recoveries + " 次仍白，停止以免死循环");
            return;
        }
        stage += 1;
        recoveries += 1;
        log("white(" + reason + "): 文本 " + textLength + " 字但屏幕全白 → 恢复 step " + stage);

        switch (stage) {
            case 1:
                web.setLayerType(View.LAYER_TYPE_NONE, null);
                web.invalidate();
                verifyAfterFix("after-none");
                break;
            case 2:
                web.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
                web.invalidate();
                verifyAfterFix("after-software");
                break;
            default:
                host.onNeedRebuild();
                break;
        }
    }

    private void askTextLength(final TextCallback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) {
            callback.onText(0);
            return;
        }
        web.evaluateJavascript(
                "(function(){try{var b=document.body;return b?(b.innerText||'').trim().length:0}"
                        + "catch(e){return 0}})()",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        int length = 0;
                        try {
                            length = Integer.parseInt(value.replaceAll("[^0-9]", ""));
                        } catch (NumberFormatException ignored) {
                            // 页面还没就绪或返回 null
                        }
                        callback.onText(length);
                    }
                });
    }

    /** 抓三块屏幕像素，判断是否几乎纯白 */
    private void sampleScreen(final SampleCallback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            callback.onSample(false);
            return;
        }
        final int[] remaining = {SAMPLE_RATIOS.length};
        final boolean[] allWhite = {true};
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
                                    // 抓不到就当作「不是白屏」：宁可漏报，也不要误改绘制路径
                                    allWhite[0] = false;
                                } else if (!isMostlyWhite(shot)) {
                                    allWhite[0] = false;
                                }
                                shot.recycle();
                                remaining[0] -= 1;
                                if (remaining[0] == 0) {
                                    callback.onSample(allWhite[0]);
                                }
                            }
                        }, handler);
            } catch (Exception error) {
                shot.recycle();
                remaining[0] -= 1;
                allWhite[0] = false;
                log("pixelcopy 失败: " + error);
                if (remaining[0] == 0) {
                    callback.onSample(false);
                }
            }
        }
    }

    private static boolean isMostlyWhite(Bitmap bitmap) {
        long sum = 0;
        int count = 0;
        for (int y = 0; y < bitmap.getHeight(); y += 2) {
            for (int x = 0; x < bitmap.getWidth(); x += 2) {
                int color = bitmap.getPixel(x, y);
                sum += (Color.red(color) + Color.green(color) + Color.blue(color)) / 3;
                count += 1;
            }
        }
        return count > 0 && sum / count >= WHITE_LEVEL;
    }

    private interface TextCallback {
        void onText(int length);
    }

    private interface SampleCallback {
        void onSample(boolean white);
    }
}
