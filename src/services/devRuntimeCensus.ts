/**
 * dev-only：运行时普查 —— 给 Web Worker 记台账、给画布做统考。
 *
 * 为什么需要它：`footprint` 只给出 WebContent 的**总量**，回答不了「这 278 MB 归谁」。
 * Web Worker 与主线程同进程、只是不同线程，进程表里看不出分别；画布的背景存储同样
 * 落在 footprint 里却不进 JS 堆。于是「是不是 worker 没终止」「是不是标签卸载后画布
 * 还被留住」这两个问题，在进程读数面前是**同形**的 —— 只有应用内才知道答案。
 *
 * 本模块把两件事变成事实而非推理：
 *  · `workerCensus()` —— 每个 worker 的创建时间与是否被 `terminate()` 过；
 *  · `canvasCensus()` —— 当前 DOM 里画布数量与背景存储像素总量。
 *
 * 求值时机是**关键**：必须早于本 app 创建第一个 worker。pdf.js 的 worker 由
 * `getDocument` 懒创建，而本模块在 `main.tsx` 的首个 import 里求值，早于一切。
 * 生产构建（`import.meta.env.DEV === false`）下整段不执行，零开销。
 */

type WorkerRecord = {
  index: number;
  url: string;
  createdAt: number;
  terminatedAt: number | null;
};

/** 台账（只增不改，供事后复盘）。 */
const records: WorkerRecord[] = [];
/**
 * 仍在世的 worker 实例。
 *
 * 为什么不用 `WeakMap<Worker, number>` 作唯一索引：WeakMap **不可枚举**，而
 * 「强制终结全部」需要能遍历。WeakMap 也帮不上内存——这些 worker 本来就由
 * pdf.js 持有着，探针多留一份强引用不会改变被观察对象。`terminate()` 时同步
 * 摘除，所以本表不会随运行时长增长。
 */
const live: Array<{ instance: Worker; index: number }> = [];
let installed = false;

const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/** 压掉 vite 给 worker 模块加的查询串与 hash，只留文件名 —— 台账要能一眼认人。 */
function shortUrl(raw: string): string {
  const withoutQuery = String(raw).split("?")[0].split("#")[0];
  const parts = withoutQuery.split("/");
  return parts[parts.length - 1] || withoutQuery;
}

if (DEV && typeof window !== "undefined") {
  const NativeWorker = window.Worker as typeof Worker | undefined;
  if (NativeWorker) {
    // 继承而不是包装成普通函数：`instanceof Worker` 必须仍然成立，
    // 某些实现（含 pdf.js 的 fake-worker 判定）会据此选路径。行为完全不变，
    // 只是留一份引用、并在 terminate 时记账。
    class TrackedWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        const index = records.length;
        records.push({
          index,
          url: shortUrl(String(scriptURL)),
          createdAt: Date.now(),
          terminatedAt: null,
        });
        live.push({ instance: this, index });
      }

      terminate(): void {
        const index = live.findIndex((entry) => entry.instance === this);
        if (index >= 0) {
          const record = records[live[index].index];
          // 只记第一次：重复 terminate 是合法调用，不该把时间戳冲掉。
          if (record && record.terminatedAt === null) record.terminatedAt = Date.now();
          live.splice(index, 1);
        }
        super.terminate();
      }
    }

    window.Worker = TrackedWorker as unknown as typeof Worker;
    installed = true;
  }
}

/**
 * worker 台账。
 *
 * `pending` 是核心指标：**「关闭后 pending > 0」= worker 线程还活着**，
 * 它持有那份被 transfer 进去的 PDF 字节与解析产物 —— 那正是「关标签后
 * 仍不归还」最可能的持有者之一，而进程读数无法把它和主线程区分开。
 */
export function workerCensus(): {
  installed: boolean;
  created: number;
  terminated: number;
  pending: number;
  records: Array<{ index: number; url: string; ageMs: number; terminated: boolean }>;
} {
  const now = Date.now();
  return {
    installed,
    created: records.length,
    terminated: records.filter((record) => record.terminatedAt !== null).length,
    pending: live.length,
    records: records.map((record) => ({
      index: record.index,
      url: record.url,
      ageMs: now - record.createdAt,
      terminated: record.terminatedAt !== null,
    })),
  };
}

/**
 * 强制终结全部仍在世的 worker。
 *
 * 用途是 A/B 对照里的**干预臂**：常规关闭路径已经会调 `doc.destroy()`（pdf.js 内部
 * 会 `worker.terminate()`），所以若这一臂的读数与「只关闭」完全一致，就说明 worker
 * 本来就已经走了、它不是残留的持有者。反过来，如果读数显著下降，那就是它。
 *
 * 先复制再遍历：`terminate()` 会从 `live` 里摘除自己，边遍历边改会漏掉后半段。
 */
export function terminateWorkers(): { terminated: number; pendingBefore: number } {
  if (!installed) return { terminated: 0, pendingBefore: 0 };
  const snapshot = live.slice();
  for (const entry of snapshot) entry.instance.terminate();
  return { terminated: snapshot.length, pendingBefore: snapshot.length };
}

/**
 * 画布统考。
 *
 * 为什么它是关键证据：扫描件页面解码后是**位图**，一张 A4 页在 dpr=2 下约 35 MB
 * 背景存储，而它既不在 JS 堆里（所以 JS 侧看起来已经释放），又在 WebContent 的
 * footprint 里。若「关闭标签后 canvas 数量不降」，那 278 MB 就基本落定了 ——
 * 标签卸载了、viewer 不在了，画布不可能还在；反之则说明卸载根本没发生。
 *
 * 两个容器都要数，只看一个会得出错结论：
 *  · `count`   —— DOM 里的画布（viewer 渲染的页，随标签卸载而消失）；
 *  · `scratch` —— `readerCore` 的**暂存画布池**：脱离 DOM、跨标签常驻、**保留
 *                 backing store**（设计如此，用来省掉重复分配）。它是「DOM 画布
 *                 已归零、footprint 却仍留一截」时最容易被忽略的那部分。
 */
export function canvasCensus(): {
  count: number;
  bytes: number;
  scratch: { pooled: number; inUse: number; bytes: number; sizes: string[] } | null;
  biggest: Array<{ cls: string; w: number; h: number; bytes: number }>;
} {
  const scratch =
    typeof window === "undefined"
      ? null
      : (
          (window as unknown as Record<string, unknown>).__r0nixScratchPoolCensus as
            | (() => { pooled: number; inUse: number; bytes: number; sizes: string[] })
            | undefined
        )?.() ?? null;

  if (typeof document === "undefined") return { count: 0, bytes: 0, scratch, biggest: [] };
  const canvases = Array.from(document.querySelectorAll("canvas"));
  const rows = canvases.map((canvas) => {
    // 背景存储按 RGBA 4 字节/像素估算 —— 这就是 WebKit 实际要留的那块。
    const bytes = canvas.width * canvas.height * 4;
    return {
      cls: typeof canvas.className === "string" ? canvas.className.slice(0, 48) : "",
      w: canvas.width,
      h: canvas.height,
      bytes,
    };
  });
  rows.sort((left, right) => right.bytes - left.bytes);
  return {
    count: canvases.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    scratch,
    biggest: rows.slice(0, 5),
  };
}

/**
 * DOM 普查 —— 「viewer 到底挂没挂载」「渲染有没有真的发生」。
 *
 * 为什么必须有它：探针窗口不可见时，`IntersectionObserver` 可能一条都不派发，
 * 于是 PDFViewer 虽然挂载、却一张页都不渲染。此时 `canvasCensus().count === 0`
 * 既可能是「页没渲染」也可能是「viewer 根本没挂载」，两者对内存的含义完全不同 ——
 * 一个是「渲染过的位图留下了」，另一个是「根本没有位图」。这类**同形读数**是本
 * 项目反复踩的坑，所以把判据直接测出来：
 *  · `pageBlocks`  —— `.pdf-page-block` 页框数（虚拟列表渲染出的页，与是否绘制无关）；
 *  · `pageCanvases`—— `.pdf-page-canvas` 真正画过内容的画布数；
 *  · `imgs` / `blobImgs` / `imgBytes` —— `<img>` 数量与**解码后位图**的估算字节数。
 *    扫描件若走 Rust 出图 → blob URL → `<img>`，那 WebKit 侧的大头就在这里，
 *    而它与 canvas 是两条完全不同的渲染路径，只看 canvas 会得出「没有大对象」的错结论；
 *  · `globals` —— 各模块的 dev 探针全局是否已注册，用来判断**模块有没有被求值**
 *    （例如 `scratchPool` 缺失 = `readerCore` 没加载 = `PDFViewer` 没被 import。
 *    这是唯一能在进程外区分「挂了但没画」和「压根没挂」的证据）。
 */
export function domCensus(): {
  pageBlocks: number;
  pageCanvases: number;
  imgs: number;
  blobImgs: number;
  imgBytes: number;
  bodyLen: number;
  rootChildren: number;
  globals: { scratchPool: boolean; wavyProbe: boolean; assistLog: boolean };
} {
  const empty = {
    pageBlocks: 0,
    pageCanvases: 0,
    imgs: 0,
    blobImgs: 0,
    imgBytes: 0,
    bodyLen: 0,
    rootChildren: 0,
    globals: { scratchPool: false, wavyProbe: false, assistLog: false },
  };
  if (typeof document === "undefined") return empty;
  const win = typeof window === "undefined" ? null : (window as unknown as Record<string, unknown>);
  const images = Array.from(document.querySelectorAll("img"));
  const root = document.getElementById("root");
  return {
    pageBlocks: document.querySelectorAll(".pdf-page-block").length,
    pageCanvases: document.querySelectorAll(".pdf-page-canvas").length,
    imgs: images.length,
    blobImgs: images.filter((image) => image.src.startsWith("blob:")).length,
    // 解码后的位图估算（RGBA 4 字节/像素）—— 这才是 WebKit 实际要留的那块，
    // 而不是 PNG/blob 的原始字节数。
    imgBytes: images.reduce(
      (sum, image) => sum + (image.naturalWidth || 0) * (image.naturalHeight || 0) * 4,
      0,
    ),
    bodyLen: document.body ? document.body.innerText.length : 0,
    rootChildren: root ? root.childElementCount : 0,
    globals: {
      scratchPool: Boolean(win?.__r0nixScratchPoolCensus),
      wavyProbe: Boolean(win?.__r0nixWavyProbe),
      assistLog: Boolean(win?.__r0nixAssistLog),
    },
  };
}

/** 一次性把三样东西打包 —— 调用点只打一条日志，避免多行交织难读。 */
export function runtimeCensus(): {
  workers: ReturnType<typeof workerCensus>;
  canvases: ReturnType<typeof canvasCensus>;
  dom: ReturnType<typeof domCensus>;
} {
  return { workers: workerCensus(), canvases: canvasCensus(), dom: domCensus() };
}
