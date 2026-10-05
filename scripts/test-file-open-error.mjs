import assert from "node:assert/strict";

const {
  classifyFileOpenError,
  describeFileOpenError,
} = await import("../src/services/fileOpenError.ts");

// ------------------------------------------------- 分类：errno 文案
// 每一条都来自真实或可预期的失败，不是凑出来的字符串。
const CASES = [
  // ★ 今天真机复现的那一条（macOS TCC 拦 ~/Downloads）
  ["PDF.js failed to load the document: failed to open pdf bytes: Operation not permitted (os error 1)", "permission"],
  ["failed to open pdf bytes: Permission denied (os error 13)", "permission"],
  ["No such file or directory (os error 2)", "missing"],
  ["failed to open pdf bytes: Not found", "missing"],
  // ★ 只剩裸 errno：这三种形态少了哪一种，分类都会退化成 unknown（给不出动作）
  ["failed to open pdf bytes: os error 1", "permission"],
  ["os error 2", "missing"],
  ['Os { code: 13, kind: PermissionDenied, message: "Permission denied" }', "permission"],
  ['Os { code: 2, kind: NotFound, message: "No such file or directory" }', "missing"],
  ["document is encrypted", "encrypted"],
  ["password required", "encrypted"],
  ["Rust read_opened_pdf_bytes timed out", "timeout"],
  ["something utterly new", "unknown"],
];
for (const [message, want] of CASES) {
  assert.equal(classifyFileOpenError(message), want, `分类错了: ${message}`);
}

// 大小写与前置包装都得认：错误跨三层，措辞与大小写不受我们控制
assert.equal(classifyFileOpenError("OPERATION NOT PERMITTED"), "permission");
assert.equal(
  classifyFileOpenError("wrapped: further wrapped: permission denied"),
  "permission",
  "包装层增加后分类不能失效",
);

// ------------------------------------------------- ★ 顺序：permission 优先于 timeout
// 「Operation not permitted (os error 1)」里没有 timeout 词，但反过来
// 「timed out waiting for permission」必须判成 permission —— 给错了动作比不分类更坏。
assert.equal(classifyFileOpenError("timed out: permission denied"), "permission");
// 反证：一条真的只是超时的不能落到 permission
assert.equal(classifyFileOpenError("read timed out"), "timeout");

// ------------------------------------------------- 空与非 Error 输入不得抛错
assert.equal(classifyFileOpenError(""), "unknown");
assert.equal(typeof describeFileOpenError(null, "zh-CN"), "string");
assert.equal(typeof describeFileOpenError(undefined, "en"), "string");
assert.equal(typeof describeFileOpenError({}, "en"), "string");

// ------------------------------------------------- ★ 每条提示都必须给出一个动作
// 这是这一层存在的理由：「打不开」用户已经知道了，告诉他下一步才有价值。
// 判据用可机检的锚点：中文必须出现「请」，英文必须出现第一二人称或祈使动词。
for (const kind of ["permission", "missing", "encrypted", "timeout"]) {
  const zh = describeFileOpenError(new Error(
    kind === "permission"
      ? "Operation not permitted (os error 1)"
      : kind === "missing"
        ? "No such file or directory (os error 2)"
        : kind === "encrypted"
          ? "document is encrypted"
          : "read timed out",
  ), "zh-CN");
  const en = describeFileOpenError(new Error(
    kind === "permission"
      ? "Operation not permitted (os error 1)"
      : kind === "missing"
        ? "No such file or directory (os error 2)"
        : kind === "encrypted"
          ? "document is encrypted"
          : "read timed out",
  ), "en");
  assert.ok(zh.includes("请"), `${kind} 的中文提示没有给出动作: ${zh}`);
  assert.ok(/reopen|again|not supported|use /i.test(en), `${kind} 的英文提示没有给出动作: ${en}`);
}

// ------------------------------------------------- ★ 权限提示必须点名「打开文件」
// 这是 macOS 下唯一的解法（powerbox 授权），不写等于没分类。
const permZh = describeFileOpenError(
  new Error("PDF.js failed to load the document: failed to open pdf bytes: Operation not permitted (os error 1)"),
  "zh-CN",
);
assert.ok(permZh.includes("打开文件"), "权限提示必须告诉用户改用「打开文件」");
// 且不能再把原始 errno 甩给用户 —— 那是他已经撞上、却没法处理的事实
assert.ok(!permZh.includes("os error"), "权限提示不该再展示原始 errno");

// ------------------------------------------------- unknown 必须保留原始信息
const unknownZh = describeFileOpenError(new Error("brand new failure"), "zh-CN");
assert.ok(unknownZh.includes("brand new failure"), "unknown 必须保留原始串，那是报 bug 的唯一证据");

// ------------------------------------------------- 语言切换
assert.ok(
  !describeFileOpenError(new Error("Operation not permitted"), "en").includes("请"),
  "英文环境不该出现中文提示",
);
assert.ok(
  describeFileOpenError(new Error("Operation not permitted"), "zh-CN") !==
    describeFileOpenError(new Error("Operation not permitted"), "en"),
  "中英文提示必须不同",
);

console.log("file-open-error: ok");
