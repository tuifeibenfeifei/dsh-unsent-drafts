// dsh-unsent-drafts 宿主侧入口。
//
// 本插件是**纯客户端插件**：所有逻辑都在 client.js（浏览器半身）里：
//   - 草稿存在浏览器 localStorage（DSH 自己的草稿持久化机制）
//   - 会话目录、切换会话、workspace 都是 Client 侧服务（ctx.sessions /
//     ctx.uiWorkspace / ctx.workspaces）
//   - UI 走 slots（sidebar.panellist 行 + main 面板）
//
// 宿主侧没有任何可做的事，空 apply 即可。保留这个文件是因为
// dsh.bundle.patch 指向本包，且 Loader 需要一个可加载的入口。
export function apply() {}
