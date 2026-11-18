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
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import java.util.ArrayList;
import java.util.List;

/**
 * 白屏一次性诊断快照。
 *
 * 设计原则（见 docs/blank-screen-snapshot.md）：
 * 1. **普通应用无法证明「真的显示在屏幕上」**，只能证明「绘制发生了 / 帧提交了」。
 *    所以快照的任务是把故障区间缩到一类，并**明确写出证据不足**，而不是假装有结论。
 * 2. 采集过程**绝不改变状态**：不 resume、不 invalidate、不切 layer —— 先留原状再探测。
 * 3. 所有 View/WebView 调用在主线程；位图统计与写盘走调用方给的落盘接口。
 */
final class DiagnosticSnapshot {

    interface Sink {
        /** 写一段多行快照到日志文件 */
        void write(String block);
    }

    private static final int MAX_DEPTH = 6;

    private final Activity activity;
    private final WebView web;
    private final Sink sink;
    private final Handler handler = new Handler(Looper.getMainLooper());

    // 绘制计数：只累加，不做任何绘制决策
    private int drawCount = 0;
    private int preDrawCount = 0;
    private long lastDrawAt = 0;
    private boolean listenersAttached = false;

    // WebView 回调状态
    private long pageFinishedAt = 0;
    private long commitVisibleAt = 0;
    private String rendererGone = "";
    private String lastUrl = "";

    DiagnosticSnapshot(Activity activity, WebView web, Sink sink) {
        this.activity = activity;
        this.web = web;
        this.sink = sink;
    }

    void attachListeners() {
        if (listenersAttached || web == null) {
            return;
        }
        try {
            web.getViewTreeObserver().addOnDrawListener(new ViewTreeObserver.OnDrawListener() {
                @Override
                public void onDraw() {
                    drawCount += 1;
                    lastDrawAt = System.currentTimeMillis();
                }
            });
            web.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
                @Override
                public boolean onPreDraw() {
                    preDrawCount += 1;
                    // 必须返回 true，否则会吞掉绘制
                    return true;
                }
            });
            listenersAttached = true;
        } catch (Throwable error) {
            sink.write("[snap] 监听器挂载失败: " + error.getClass().getSimpleName());
        }
    }

    void notePageFinished(String url) {
        pageFinishedAt = System.currentTimeMillis();
        lastUrl = url;
    }

    /** 供 WebViewClient.onPageCommitVisible 调用 */
    void noteCommitVisible() {
        commitVisibleAt = System.currentTimeMillis();
    }

    /** 供 onRenderProcessGone 调用 */
    void noteRendererGone(boolean didCrash) {
        rendererGone = didCrash ? "crashed" : "killed";
    }

    /** 当前是否处于「页面已提交可见」状态 */
    boolean pageCommitted() {
        return commitVisibleAt > 0;
    }

    long pageFinishedAt() {
        return pageFinishedAt;
    }

    /**
     * 采一次快照。
     *
     * @param reason 触发原因（page-finished / resume / pause / auto-blank …）
     */
    void capture(final String reason) {
        if (web == null) {
            return;
        }
        StringBuilder out = new StringBuilder();
        out.append("[snap] ===== 快照（").append(reason).append("） =====\n");

        // ① 视图可见性链
        out.append("[snap] ① 视图链: ");
        List<String> chain = new ArrayList<>();
        View current = web;
        int depth = 0;
        while (current != null && depth < MAX_DEPTH) {
            String item = current.getClass().getSimpleName()
                    + " shown=" + current.isShown()
                    + " vis=" + visibilityName(current.getVisibility())
                    + " alpha=" + current.getAlpha()
                    + " layer=" + layerName(current.getLayerType())
                    + " attached=" + current.isAttachedToWindow()
                    + " size=" + current.getWidth() + "x" + current.getHeight();
            chain.add(item);
            ViewParent parent = current.getParent();
            current = parent instanceof View ? (View) parent : null;
            depth += 1;
        }
        out.append(chain.isEmpty() ? "（无）" : String.join(" → ", chain)).append('\n');

        // ② 窗口与层级
        View decor = activity.getWindow().getDecorView();
        out.append("[snap] ② 窗口: windowVis=").append(activity.getWindow().getDecorView().getWindowVisibility())
                .append(" hasFocus=").append(activity.hasWindowFocus())
                .append(" hwAccel=").append(activity.getWindow().getDecorView().isHardwareAccelerated())
                .append(" decor=").append(decor.getWidth()).append('x').append(decor.getHeight())
                .append(" flags=").append(Integer.toHexString(activity.getWindow().getAttributes().flags))
                .append(" winAlpha=").append(activity.getWindow().getAttributes().alpha)
                .append('\n');

        out.append("[snap] ③ 兄弟视图: ");
        List<String> siblings = new ArrayList<>();
        collectChildren(decor, 0, siblings, 0);
        out.append(siblings.isEmpty() ? "（无）" : String.join(" | ", siblings)).append('\n');

        // ④ 绘制与回调状态
        out.append("[snap] ④ 绘制: drawCount=").append(drawCount)
                .append(" preDrawCount=").append(preDrawCount)
                .append(" lastDrawAgoMs=").append(lastDrawAt == 0 ? -1 : System.currentTimeMillis() - lastDrawAt)
                .append(" pageFinishedAgoMs=").append(pageFinishedAt == 0 ? -1 : System.currentTimeMillis() - pageFinishedAt)
                .append(" commitVisibleAgoMs=").append(commitVisibleAt == 0 ? -1 : System.currentTimeMillis() - commitVisibleAt)
                .append(" renderer=").append(rendererGone.isEmpty() ? "ok" : rendererGone)
                .append(" url=").append(lastUrl)
                .append('\n');

        sink.write(out.toString());

        // ⑤ 像素与页面状态（异步，各自独立写一条）
        measureViewDraw(reason);
        measureScreen(reason);
        measurePage(reason);
    }

    private static String visibilityName(int value) {
        switch (value) {
            case View.VISIBLE:
                return "VISIBLE";
            case View.INVISIBLE:
                return "INVISIBLE";
            case View.GONE:
                return "GONE";
            default:
                return String.valueOf(value);
        }
    }

    private static String layerName(int value) {
        switch (value) {
            case View.LAYER_TYPE_NONE:
                return "NONE";
            case View.LAYER_TYPE_SOFTWARE:
                return "SOFTWARE";
            case View.LAYER_TYPE_HARDWARE:
                return "HARDWARE";
            default:
                return String.valueOf(value);
        }
    }

    private static void collectChildren(View view, int depth, List<String> out, int limit) {
        if (depth > MAX_DEPTH || view == null || out.size() >= 12) {
            return;
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount() && out.size() < 12; i += 1) {
                View child = group.getChildAt(i);
                out.add(child.getClass().getSimpleName()
                        + "#" + i
                        + " " + child.getWidth() + "x" + child.getHeight()
                        + " vis=" + visibilityName(child.getVisibility())
                        + " shown=" + child.isShown());
                collectChildren(child, depth + 1, out, limit);
            }
        }
    }

    /** WebView 自绘到 Bitmap 的非白千分比：证明「视图本身有内容」 */
    private void measureViewDraw(final String reason) {
        int width = web.getWidth();
        int height = web.getHeight();
        if (width <= 0 || height <= 0) {
            sink.write("[snap] ⑤ 自绘: 尺寸为 0，跳过");
            return;
        }
        Bitmap bitmap = null;
        try {
            float scale = Math.min(1f, 240f / Math.max(width, height));
            int w = Math.max(1, Math.round(width * scale));
            int h = Math.max(1, Math.round(height * scale));
            bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.scale(scale, scale);
            web.draw(canvas);
            int permille = nonWhitePermille(bitmap);
            sink.write("[snap] ⑤ 自绘: 非白 " + permille + "‰"
                    + (permille < 5 ? "（视图本身画不出内容）" : "（视图有内容）"));
        } catch (Throwable error) {
            sink.write("[snap] ⑤ 自绘: 失败 " + error.getClass().getSimpleName());
        } finally {
            if (bitmap != null) {
                bitmap.recycle();
            }
        }
    }

    /** 抓窗口真实像素：证明「屏幕上有什么」 */
    private void measureScreen(final String reason) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            sink.write("[snap] ⑥ 屏幕: PixelCopy 需要 Android 8+");
            return;
        }
        int[] location = new int[2];
        web.getLocationInWindow(location);
        final int width = Math.max(1, web.getWidth());
        final int height = Math.max(1, web.getHeight());
        final Bitmap shot = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        try {
            PixelCopy.request(activity.getWindow(),
                    new android.graphics.Rect(location[0], location[1],
                            location[0] + width, location[1] + height), shot,
                    new PixelCopy.OnPixelCopyFinishedListener() {
                        @Override
                        public void onPixelCopyFinished(int copyResult) {
                            if (copyResult != PixelCopy.SUCCESS) {
                                sink.write("[snap] ⑥ 屏幕: 抓取失败 code=" + copyResult + "（不能据此判白）");
                                shot.recycle();
                                return;
                            }
                            int smallHeight = Math.max(1, 64 * shot.getHeight() / Math.max(1, shot.getWidth()));
                            Bitmap small = Bitmap.createScaledBitmap(shot, 64, smallHeight, true);
                            int permille = nonWhitePermille(small);
                            small.recycle();
                            shot.recycle();
                            sink.write("[snap] ⑥ 屏幕: 非白 " + permille + "‰"
                                    + (permille < 5 ? "（屏幕没有内容）" : "（屏幕有内容）"));
                        }
                    }, handler);
        } catch (Exception error) {
            shot.recycle();
            sink.write("[snap] ⑥ 屏幕: 异常 " + error.getClass().getSimpleName());
        }
    }

    /** 页面自身状态：只取结构性信息，不取任何文本内容 */
    private void measurePage(final String reason) {
        final String script = "(function(){try{"
                + "var root=document.getElementById('root');"
                + "var cs=root?getComputedStyle(root):null;"
                + "return JSON.stringify({"
                + "vs:document.visibilityState,"
                + "scrollY:Math.round(window.scrollY||0),"
                + "vw:window.innerWidth,vh:window.innerHeight,"
                + "dvh:(window.CSS&&CSS.supports)?CSS.supports('height','100dvh'):null,"
                + "rootChildren:root?root.childElementCount:-1,"
                + "rootDisplay:cs?cs.display:null,"
                + "rootVisibility:cs?cs.visibility:null,"
                + "rootOpacity:cs?cs.opacity:null,"
                + "rootRect:root?(function(r){return Math.round(r.width)+'x'+Math.round(r.height)})(root.getBoundingClientRect()):null"
                + "})}catch(e){return '" + "{\"err\":\"probe\"}" + "'}})()";
        web.evaluateJavascript(script, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                sink.write("[snap] ⑦ 页面: " + (value == null ? "null" : value.replace("\\", "")));
            }
        });
    }

    private static int nonWhitePermille(Bitmap bitmap) {
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
        return sampled == 0 ? 0 : nonWhite * 1000 / sampled;
    }

}
