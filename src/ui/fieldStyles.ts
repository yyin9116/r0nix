/**
 * 表单控件共享基类
 * ---------------------------------------------------------------------------
 * 输入框 / 文本域 / 下拉三者的「外壳」在变更前被逐字重复了 12 次，且每次都带
 * `dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700`：浅色用 subtle 档描边、
 * 深色用 default 档 —— 同一个控件在两种模式下处在不同层级，属于配对本身写错了。
 * 这里统一取 --border-default（控件描边档）。
 * 这里**刻意不含宽度**。Tailwind 里 `w-full` 与 `w-72` 是同一属性的两个工具类，
 * 谁在产物里靠后谁赢 —— 把 `w-full` 写进基类会让调用方传的 `w-72` 静默失效
 * （已实测：w-72 的输入框被拉到 918px）。宽度一律由调用方给：
 * 表单里用 `w-full`，定宽控件用 `w-72` / `w-20`。
 */
export const FIELD =
  "rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm text-content-primary disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-content-disabled";
