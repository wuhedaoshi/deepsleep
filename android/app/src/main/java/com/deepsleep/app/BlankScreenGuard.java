package com.deepsleep.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
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
 * 白屏诊断与自动恢复。
 *
 * 现场（Honor / MagicOS 8 实测）：DOM 完全正常——`rootChildren: 1`、`bodyText: 70`、
 * 前景背景色都对——但屏幕上整片白。这类问题改 CSS、改 WebView 生命周期都不解决问题，
 * 只能「量出来再修」。
 *
 * 判定用两条证据，必须同时成立：
 *   1. 页面有内容：evaluateJavascript 取 innerText 长度 > 20
 *   2. 屏幕确实白：PixelCopy 抓三块真实像素，平均亮度都 ≥ 248
 *
 * 再加一条判别器回答「到底是没画，还是没内容」：
 *   把 WebView 自己 draw 到 Bitmap（与屏幕表面无关），看它有没有内容。
 *   - draw 有内容 + 屏幕全白 → 合成/表面问题（切软件层最可能奏效）
 *   - draw 也没内容          → 渲染问题（切层没用，需要考虑重建或救援页）
 *
 * 恢复阶梯（每步都复测，全部落盘，跨重启不回到起点）：
 *   1. 当前实例切 LAYER_TYPE_NONE
 *   2. 当前实例切 LAYER_TYPE_SOFTWARE（成功则持久化，下次启动直接用它）
 *   3. 重建界面（带 stage 记忆，避免无限重建）
 */
final class BlankScreenGuard {

    interface Host {
        /** 需要重建 Activity（新建 WebView）时调用 */
        void onNeedRebuild();

        /** 写一行日志——必须进日志文件，否则等于没记 */
        void log(String line);
    }

    private static final String PREFS = "deepsleep.blank";
    private static final String KEY_MODE = "mode";
    private static final String KEY_STAGE = "stage";
    private static final String KEY_VERIFIED_AT = "verifiedAt";

    /** 采样点（相对高度） */
    private static final float[] SAMPLE_RATIOS = {0.25f, 0.5f, 0.75f};
    private static final int SAMPLE_SIZE = 48;
    /** 平均亮度阈值：≥ 这个值算「白」 */
    private static final int WHITE_LEVEL = 248;
    /** 页面至少这么多字才算有内容 */
    private static final int MIN_TEXT_LENGTH = 20;
    /** 每次运行最多恢复几次 */
    private static final int MAX_RECOVERIES = 3;
    /** 诊断窗口：从页面就绪起这么久内没恢复成功就不再折腾 */
    private static final long WINDOW_MS = 30_000;

    private final Activity activity;
    private final WebView web;
    private final Host host;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private final long startedAt = System.currentTimeMillis();
    private int recoveries = 0;

    BlankScreenGuard(Activity activity, WebView web, Host host) {
        this.activity = activity;
        this.web = web;
        this.host = host;
    }

    /** 上次运行验证过软件层可用：这次直接用它，免得再白一次 */
    static void applyPersistedMode(WebView web, Context context) {
        if (web == null || context == null) {
            return;
        }
        String mode = prefs(context).getString(KEY_MODE, "");
        if ("software".equals(mode)) {
            web.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    void verify(final String reason) {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                check(reason, false);
            }
        }, 1200);
    }

    private void check(final String reason, final boolean afterFix) {
        if (!busy.compareAndSet(false, true)) {
            return;
        }
        if (System.currentTimeMillis() - startedAt > WINDOW_MS) {
            host.log("guard(" + reason + "): 已超出诊断窗口，停止自动恢复");
            busy.set(false);
            return;
        }
        askTextLength(new TextCallback() {
            @Override
            public void onText(final int textLength) {
                if (textLength < MIN_TEXT_LENGTH) {
                    busy.set(false);
                    if (afterFix) {
                        return;
                    }
                    host.log("checked(" + reason + "): 页面文本 " + textLength + " 字，未就绪，跳过");
                    return;
                }
                sampleScreen(new SampleCallback() {
                    @Override
                    public void onSample(boolean screenWhite, boolean captureFailed) {
                        if (captureFailed) {
                            // 抓不到就当作「不是白屏」：宁可漏报，也不要误改绘制路径
                            busy.set(false);
                            host.log("capture-unavailable(" + reason
                                    + "): PixelCopy 失败，不累计白屏次数");
                            return;
                        }
                        if (!screenWhite) {
                            busy.set(false);
                            markHealthy(reason);
                            return;
                        }
                        // 屏幕白：用「视图自绘」判断是没画出来还是没内容
                        boolean viewHasContent = drawViewToBitmap();
                        host.log("white(" + reason + "): 文本 " + textLength + " 字"
                                + "，屏幕全白，视图自绘"
                                + (viewHasContent ? "有内容 → 判为合成/表面问题" : "也无内容 → 判为渲染问题"));
                        busy.set(false);
                        if (afterFix) {
                            recover(reason, viewHasContent);
                        } else {
                            confirmThenRecover(reason, viewHasContent);
                        }
                    }
                });
            }
        });
    }

    /** 一次全白可能是巧合：隔 500ms 再采一次仍白才动手 */
    private void confirmThenRecover(final String reason, final boolean viewHasContent) {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!busy.compareAndSet(false, true)) {
                    return;
                }
                sampleScreen(new SampleCallback() {
                    @Override
                    public void onSample(boolean screenWhite, boolean captureFailed) {
                        busy.set(false);
                        if (captureFailed) {
                            host.log("capture-unavailable(" + reason + "): 复采失败，判为瞬态");
                            return;
                        }
                        if (screenWhite) {
                            recover(reason, viewHasContent);
                        } else {
                            host.log("skip(" + reason + "): 首次全白、复采正常，判为瞬态");
                        }
                    }
                });
            }
        }, 500);
    }

    private void recover(String reason, boolean viewHasContent) {
        if (recoveries >= MAX_RECOVERIES) {
            host.log("give-up(" + reason + "): 已恢复 " + recoveries + " 次仍白");
            return;
        }
        int stage = prefs(activity).getInt(KEY_STAGE, 0);
        stage += 1;
        recoveries += 1;
        prefs(activity).edit().putInt(KEY_STAGE, stage).apply();
        host.log("recover(" + reason + "): step " + stage
                + (viewHasContent ? "（合成问题）" : "（渲染问题）"));

        switch (stage) {
            case 1:
                web.setLayerType(View.LAYER_TYPE_NONE, null);
                web.invalidate();
                break;
            case 2:
                web.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
                web.invalidate();
                break;
            default:
                // 已经切过软件层还是白：重建一次界面，stage 记在盘上，不会无限重建
                host.onNeedRebuild();
                return;
        }
        final int reportStage = stage;
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                check("after-step" + reportStage, true);
            }
        }, 700);
    }

    /** 屏幕恢复正常：若在用软件层，把它记成「已验证」，下次启动直接启用 */
    private void markHealthy(String reason) {
        SharedPreferences prefs = prefs(activity);
        int stage = prefs.getInt(KEY_STAGE, 0);
        if (stage >= 2) {
            prefs.edit()
                    .putString(KEY_MODE, "software")
                    .putLong(KEY_VERIFIED_AT, System.currentTimeMillis())
                    .putInt(KEY_STAGE, 0)
                    .apply();
            host.log("ok(" + reason + "): 软件层生效，已持久化为默认模式");
        } else if (stage == 1) {
            prefs.edit().putInt(KEY_STAGE, 0).apply();
            host.log("ok(" + reason + "): 免层后恢复正常");
        } else if (recoveries > 0) {
            host.log("ok(" + reason + "): 恢复后复测通过");
        }
        recoveries = 0;
    }

    // ---- 证据采集 ---------------------------------------------------------------

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

    /** 抓三块窗口真实像素；captureFailed 表示抓不到（与「不白」区分开） */
    private void sampleScreen(final SampleCallback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            callback.onSample(false, true);
            return;
        }
        final int total = SAMPLE_RATIOS.length;
        final int[] remaining = {total};
        final int[] whiteCount = {0};
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
                                } else if (isMostlyWhite(shot)) {
                                    whiteCount[0] += 1;
                                }
                                shot.recycle();
                                remaining[0] -= 1;
                                if (remaining[0] == 0) {
                                    callback.onSample(whiteCount[0] == total, failed[0]);
                                }
                            }
                        }, handler);
            } catch (Exception error) {
                shot.recycle();
                failed[0] = true;
                remaining[0] -= 1;
                if (remaining[0] == 0) {
                    callback.onSample(false, true);
                }
            }
        }
    }

    /**
     * 不走屏幕表面，直接把视图画进 Bitmap：内容在不在，这里最诚实。
     * 返回 true 表示「视图本身画得出内容」——那白屏就是合成问题。
     */
    private boolean drawViewToBitmap() {
        int width = web.getWidth();
        int height = web.getHeight();
        if (width <= 0 || height <= 0) {
            return false;
        }
        // 采样时不需要全尺寸：按比例缩到长边 240，够判断有没有内容
        float scale = Math.min(1f, 240f / Math.max(width, height));
        int w = Math.max(1, Math.round(width * scale));
        int h = Math.max(1, Math.round(height * scale));
        Bitmap bitmap = null;
        try {
            bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.scale(scale, scale);
            web.draw(canvas);
            return hasNonWhite(bitmap);
        } catch (Throwable error) {
            host.log("draw-probe 失败: " + error);
            return false;
        } finally {
            if (bitmap != null) {
                bitmap.recycle();
            }
        }
    }

    private static boolean hasNonWhite(Bitmap bitmap) {
        int nonWhite = 0;
        int sampled = 0;
        for (int y = 0; y < bitmap.getHeight(); y += 2) {
            for (int x = 0; x < bitmap.getWidth(); x += 2) {
                int color = bitmap.getPixel(x, y);
                int level = (Color.red(color) + Color.green(color) + Color.blue(color)) / 3;
                sampled += 1;
                if (level < 240) {
                    nonWhite += 1;
                }
            }
        }
        // 有 1% 以上像素不是白的，就认为「画得出内容」
        return sampled > 0 && nonWhite * 100 / sampled >= 1;
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
        void onSample(boolean screenWhite, boolean captureFailed);
    }
}
