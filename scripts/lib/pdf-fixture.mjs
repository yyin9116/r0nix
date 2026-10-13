/**
 * 程序化 PDF 夹具生成（内存 / 性能探针共用）。
 *
 * 为什么抽成共享模块：内存探针（probe-pdf-memory-footprint.mjs）与滚动开销探针
 * （probe-pdf-scroll-cost.mjs）必须用**同一份夹具**，否则两边的读数不可比 ——
 * 「同一个文件、同一套夹具」是跨探针交叉验证的前提。此前 scroll-cost 里有一份
 * 等价实现，现已迁到这里。
 *
 * ⚠️ 迁移记录（2026-10-10）：原 scroll-cost 内联版的正文文案是
 * `…a representative document page for scroll cost probing`，迁到本文件时统一成
 * 中性的 `…for probe fixtures`（见 createPdfFixture）。该字符串只进内容流的 `Tj`，
 * 只影响文本层的字符数与 `/Length`（每页约 5 字节 × 30 行），**不影响版式、像素与
 * 渲染开销**，因此不改变任何既有测量结论；但夹具字节确实变了，故在此留痕。
 */
import zlib from "node:zlib";

/** 内容流对象体：`<< /Length n >> stream ... endstream`（二进制安全）。 */
export function streamBody(content, extraDict = "") {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "latin1");
  return Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length}${extraDict} >>\nstream\n`, "latin1"),
    bytes,
    Buffer.from("\nendstream", "latin1"),
  ]);
}

/**
 * 把 PDF 对象体数组组装成文件字节（含 xref 表）。
 *
 * ⚠️ 全程走 Buffer 而不是字符串拼接：位图流里任意字节都可能出现，用 `utf8`
 * 字符串中转会把 `0xC3 0xA9` 这类序列重新编码成别的字节，xref 偏移跟着错位，
 * pdf.js 会报「文件损坏」而不是「图花了」——那种错比花图难查得多。
 */
export function assemblePdf(objectBodies) {
  const chunks = [];
  let offset = 0;
  const push = (value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1");
    chunks.push(buffer);
    offset += buffer.length;
  };
  push("%PDF-1.4\n");
  const offsets = [];
  objectBodies.forEach((body) => {
    offsets.push(offset);
    push(`${offsets.length} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objectBodies.length + 1}\n0000000000 65535 f \n`;
  for (const item of offsets) xref += `${String(item).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objectBodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/**
 * 轻量夹具：每页 30 行正文、无图。
 *
 * ⚠️ 它**复现不了重文档的内存/滚动问题**：30 行文字、文本层只有 90 个 span，
 * 文件不到 0.1 MiB。留着它只是为了做「文档规模」这个变量的**下界对照**。
 */
export function createPdfFixture(pageCount) {
  const lines = [
    "BT /F1 11 Tf 72 740 Td 0 -16 Td",
    ...Array.from(
      { length: 30 },
      (_, index) => `(Paragraph line ${index + 1} of a representative document page for probe fixtures) Tj 0 -16 Td`,
    ),
    "ET",
  ].join("\n");
  const pageObjects = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ");
  const fontId = pageCount + 3;
  const contentId = pageCount + 4;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjects}] /Count ${pageCount} >>`,
    ...Array.from(
      { length: pageCount },
      () =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    streamBody(lines),
  ]);
}

/**
 * 扫描件夹具：**每页一张各自独立的** 1600×2200 RGB 位图（`/FlateDecode`）+ 60 行文字。
 *
 * ── 为什么必须和 createHeavyPdfFixture 分开（这是本文件里最容易搞错的一处）──
 * `createHeavyPdfFixture` 的 200 页**共享同一个 XObject**：文件里只有一份位图数据，
 * 200 个页对象都引用它 → 实测 200 页只有 **0.21 MiB**。用它测「绘制成本」没问题
 * （每页照样要 drawImage 一次全尺寸位图），但**测内存完全无效**：文件本身小、
 * pdf.js 解码缓存也可能只留一份，恰好绕开了「整份文件进内存 + 每页解码」这条主路径。
 * 用户报的 2GB 来自 **90 MiB 的 200 页扫描版**，每次 `open` 都要把整份文件读进去。
 * 所以内存探针必须用本函数：**每页一张独立位图**，页间纹理不同、体积与真实扫描件同量级。
 *
 * 体积标定（实测，level 6 deflate）：
 *   noiseAmp=4 noiseStride=13 → 0.545 MiB/页 → 200 页 ≈ 109 MiB（默认，对齐用户的 90 MiB）
 *   noiseAmp=2 noiseStride=17 → 0.412 MiB/页 → 200 页 ≈  83 MiB
 *   noiseAmp=1 noiseStride= 7 → 0.389 MiB/页 → 200 页 ≈  78 MiB
 *   噪声幅度 0（纯低频）      → 0.089 MiB/页 → 200 页 ≈  18 MiB（压得太狠，复现不了）
 * 旋钮是「噪声密度」：`noiseAmp` 是幅度，`noiseStride` 决定每隔几个像素加一次噪声。
 * 幅度 0→1 就足以把压缩率从 113:1 打到 7:1（每像素多 3 个状态），所以细调**只能靠 stride**。
 */
export function createScannedPdfFixture(
  pageCount,
  { imageWidth = 1600, imageHeight = 2200, noiseAmp = 4, noiseStride = 13 } = {},
) {
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index);
  const imageIds = Array.from({ length: pageCount }, (_, index) => 3 + pageCount + index);
  const fontId = 3 + pageCount * 2;
  const contentIds = Array.from({ length: pageCount }, (_, index) => 4 + pageCount * 2 + index);

  const textLines = Array.from(
    { length: 60 },
    (_, index) => `(Line ${index + 1}: representative body text for raster and text-layer cost measurement) Tj T*`,
  ).join("\n");
  const pageContent = ["q 612 0 0 792 0 0 cm /Im0 Do Q", "BT /F1 10 Tf 40 756 Td 13 TL", textLines, "ET"].join("\n");

  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  ];

  for (let index = 0; index < pageCount; index += 1) {
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im0 ${imageIds[index]} 0 R >> >> ` +
        `/Contents ${contentIds[index]} 0 R >>`,
    );
  }

  for (let page = 0; page < pageCount; page += 1) {
    const raw = Buffer.alloc(imageWidth * imageHeight * 3);
    // xorshift32：种子随页号变化 → 每页噪声序列不同 → 位图字节不同（真实扫描件的关键特征）。
    let state = ((page + 1) * 2654435761) >>> 0;
    for (let y = 0; y < imageHeight; y += 1) {
      for (let x = 0; x < imageWidth; x += 1) {
        const offset = (y * imageWidth + x) * 3;
        // 低频基底（纸张底色 + 渐变），保证压缩后有合理的「纸张」占比。
        let r = 200 + ((x >> 6) & 31) - ((y >> 7) & 15);
        let g = 200 + ((y >> 6) & 31);
        let b = 195 + (((x >> 7) + (y >> 6)) & 15);
        if (noiseAmp > 0 && (x * 7 + y * 13 + page * 31) % noiseStride === 0) {
          state ^= state << 13;
          state >>>= 0;
          state ^= state >> 17;
          state ^= state << 5;
          state >>>= 0;
          const jitter = ((state & 0xff) % (noiseAmp * 2 + 1)) - noiseAmp;
          r += jitter;
          g += jitter;
          b += jitter;
        }
        raw[offset] = r & 0xff;
        raw[offset + 1] = g & 0xff;
        raw[offset + 2] = b & 0xff;
      }
    }
    bodies.push(
      streamBody(
        zlib.deflateSync(raw, { level: 6 }),
        ` /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      ),
    );
  }

  bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let index = 0; index < pageCount; index += 1) {
    bodies.push(streamBody(pageContent));
  }

  if (bodies.length !== 3 + pageCount * 3) {
    throw new Error(`scanned fixture object count mismatch: ${bodies.length} vs ${3 + pageCount * 3}`);
  }
  return assemblePdf(bodies);
}

/**
 * 重页夹具：每页一张 1600×2200 RGB 位图（`/FlateDecode`）+ 60 行文字。
 *
 * 位图选「低频纹理」而不是纯色或高频噪声：
 *   · 纯色 → 被 deflate 压成几十字节，pdf.js 还能走快速路径，量不到真实代价；
 *   · 高频噪声 → 压不动，文件几十 MB，传输本身成了噪声源；
 *   · 低频条纹/棋盘 → 压得动，但解码 + 缩放 + 整页位图绘制是实打实的工作。
 * 这正是真实论文 / 扫描件 PDF 在阅读器里的主要开销来源。
 *
 * ⚠️ 200 页的规模是刻意对齐用户反馈里的「90 MiB / 200 页扫描版」——
 * 内存探针要复现的是**那个文件**，不是随便一个 PDF。
 */
export function createHeavyPdfFixture(pageCount) {
  const imageWidth = 1600;
  const imageHeight = 2200;
  const raw = Buffer.alloc(imageWidth * imageHeight * 3);
  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const offset = (y * imageWidth + x) * 3;
      raw[offset] = (x >> 3) & 0xff;
      raw[offset + 1] = (y >> 3) & 0xff;
      raw[offset + 2] = 96 + ((((x >> 6) + (y >> 6)) & 1) * 128);
    }
  }
  const imageData = zlib.deflateSync(raw, { level: 6 });

  const lines = Array.from(
    { length: 60 },
    (_, index) => `(Line ${index + 1}: representative body text for raster and text-layer cost measurement) Tj T*`,
  ).join("\n");
  const content = ["q 612 0 0 792 0 0 cm /Im0 Do Q", "BT /F1 10 Tf 40 756 Td 13 TL", lines, "ET"].join("\n");

  const pageObjects = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ");
  const imageId = pageCount + 3;
  const fontId = pageCount + 4;
  const contentId = pageCount + 5;

  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjects}] /Count ${pageCount} >>`,
    ...Array.from(
      { length: pageCount },
      () =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im0 ${imageId} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>`,
    ),
    streamBody(
      imageData,
      ` /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    streamBody(content),
  ]);
}
