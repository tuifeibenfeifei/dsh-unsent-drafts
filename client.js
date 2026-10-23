/**
 * dsh-unsent-drafts — 浏览器半身：找回切换会话后丢失的未发送草稿。
 *
 * ## 问题
 *
 * DSH 的侧栏规则：只有「当前」那一行空白会话显示，其他空白会话行被隐藏。
 * 于是「新建会话 → 打了字没发 → 切到别的会话」之后，那个会话从侧栏消失，
 * 用户既切不回去，也看不到自己打了什么。
 *
 * 但草稿与会话其实都还在：草稿持久化在浏览器 localStorage，空白会话也被
 * 持久化、仍在会话目录里。缺的只是一个入口。
 *
 * ## 做法
 *
 * 扫描 localStorage 里所有「带草稿」的键 → 用 sessionId 去会话目录查标题 →
 * 侧栏注册一个「未发送草稿」行 + 一个 main 面板 → 点某条就切回该会话，
 * 草稿由 DSH 自身的恢复机制回填。
 *
 * ## 注册契约（全部来自本机实测，未凭记忆写）
 *
 * - 侧栏行 + 主面板：参考 dsh-cost-tracker/client.js L2594-2665 与
 *   dshmarket 的官方实现——
 *     ctx.slots.inject('sidebar.panellist', () => {
 *       ctx.slots.register({ name: 'main', key: PANEL_ID, locale: ns }, Panel)
 *       ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order, label, locale: ns }, Icon)
 *     })
 *   并且整段必须包在 ctx.effect() 里：**slot 在 apply 早期尚未建立，
 *   裸调用 register 会被静默丢弃**（2026-10-21 实测踩坑，见 cost-tracker 注释）。
 * - locale：ctx.effect(() => ctx.locale.register(ns, { zh: {...}, en: {...} }))
 * - inject：['slots', 'locale']
 * - 整个 apply 包 try/catch：前端插件抛异常会让 DSH 判定启动失败。
 *
 * ## 不猜的部分
 *
 * 草稿键名 / 会话目录接口 / 切会话接口都不是本文件假定的：
 *   - 草稿扫描是**前缀自适应**的——扫全部 localStorage 键，只认「解析后是
 *     对象且 .draft 有非空文本」的那些，sessionId 从对象字段或键名尾部取。
 *     默认前缀 dsh.conversation. 只作为面板里的提示，不是硬编码依赖。
 *   - 切会话是一条尝试链（uiWorkspace.openSession → sessions.retain），
 *     每一步的结果都写进面板的「诊断」区，失败时用户能看到究竟哪步不行。
 */

window.__ModuleLoader__.load({
  id: 'dsh-unsent-drafts',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /**
     * ⚠️ hooks 不能在模块级解构。
     *
     * 宿主可能把 React 实例替换/重新加载（HMR、多份 React），模块级解构会拿到
     * 一份过期的 useState/useEffect，调用时直接抛
     * "Invalid hook call / dispatcher is null"，表现就是面板白屏。
     * 这里每次渲染都从当前 React 对象上现取。
     */
    function useReact() {
      return React
    }

    // ------------------------------------------------------------------
    // 常量
    // ------------------------------------------------------------------

    const PANEL_ID = 'unsent-drafts'
    const NAMESPACE = 'unsent-drafts'

    /** 面板里提示用的默认前缀；扫描不依赖它（见文件头） */
    const HINT_PREFIX = 'dsh.conversation.'

    /** 预览截断长度 */
    const PREVIEW_LIMIT = 60
    /** 单次扫描最多解析多少个键（防止超大 localStorage 卡死面板） */
    const SCAN_LIMIT = 500
    /** 单个值超过这个大小就跳过（草稿不可能有 1MB） */
    const VALUE_MAX_BYTES = 512 * 1024
    /** 实时同步的轮询间隔（storage 事件只在同页面其他标签页触发，这里靠自己轮询） */
    const SYNC_INTERVAL_MS = 1200

    /** 宿主 ctx：切会话用。模块作用域，组件闭包外也能读 */
    let hostCtx = null

    // ------------------------------------------------------------------
    // 草稿解析
    // ------------------------------------------------------------------

    /**
     * 把 localStorage 里的一条记录解成 { text, references }。
     *
     * draft 有两种历史格式，必须都兼容：
     *   - 纯字符串（早期）："abc"
     *   - 结构化对象（新）：{ text: "abc", references: [...] }
     * 以及 null / 空串 / 只有空白 → 一律返回 null（不算有草稿）。
     */
    function parseStoredDraft(parsed) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const draft = parsed.draft
      let text = ''
      let references = []
      if (typeof draft === 'string') {
        text = draft
      } else if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
        if (typeof draft.text === 'string') text = draft.text
        if (Array.isArray(draft.references)) references = draft.references
      } else {
        return null
      }
      if (!text.trim()) return null
      return { text, references }
    }

    /** 从一条记录里取 sessionId：先看对象字段，再退回键名尾部 */
    function extractSessionId(key, parsed) {
      for (const f of ['sessionId', 'session', 'conversationId', 'id']) {
        const v = parsed[f]
        if (typeof v === 'string' && v) return v
      }
      const i = key.lastIndexOf('.')
      if (i > 0 && i < key.length - 1) return key.slice(i + 1)
      return key
    }

    /** 键的前缀（诊断用）：最后一个 '.' 之前的部分 */
    function prefixOf(key) {
      const i = key.lastIndexOf('.')
      return i > 0 ? key.slice(0, i + 1) : '(no-dot)'
    }

    /**
     * 枚举 localStorage 的全部键。
     *
     * ⚠️ 不能只用 Object.keys(localStorage)：Storage 是「具名属性」宿主对象，
     * 在部分 Chromium/Electron 构建里 Object.keys() 会返回空数组，症状就是
     * 面板能打开但永远显示「没有未发送草稿」。这里用 length/key(i) 为主、
     * Object.keys 做并集兜底，两条路都走一遍。
     */
    function enumerateKeys(ls) {
      const out = []
      const seen = new Set()
      const push = (k) => {
        if (typeof k === 'string' && k && !seen.has(k)) { seen.add(k); out.push(k) }
      }
      try {
        const n = typeof ls.length === 'number' ? ls.length : 0
        for (let i = 0; i < n; i++) {
          try { push(ls.key(i)) } catch { /* 单个键取失败不影响其他 */ }
        }
      } catch { /* length/key 不可用时退回 Object.keys */ }
      try {
        for (const k of Object.keys(ls)) push(k)
      } catch { /* 忽略 */ }
      return out
    }

    /**
     * 扫描 localStorage。
     * 返回 { items, total, prefixes, error }——永远不抛。
     *
     * items: [{ key, sessionId, text, refCount }]
     */
    function scanDrafts() {
      let ls = null
      try {
        ls = (typeof window !== 'undefined' && window.localStorage) || null
      } catch {
        ls = null
      }
      if (!ls) {
        return { items: [], total: 0, prefixes: {}, error: '读不到 window.localStorage' }
      }

      let keys = []
      try {
        keys = enumerateKeys(ls)
      } catch (e) {
        return { items: [], total: 0, prefixes: {}, sample: [], error: '枚举 localStorage 失败：' + errMsg(e) }
      }
      if (keys.length === 0) {
        let len = -1
        try { len = ls.length } catch { /* 忽略 */ }
        return {
          items: [], total: 0, prefixes: {}, sample: [], parseFailed: 0, noDraft: 0,
          error: '枚举到 0 个键（localStorage.length=' + len + '）。可能是页面无存储权限，或键不在本页 origin 下。',
        }
      }

      const items = []
      const prefixes = {}
      const sample = []
      let parseFailed = 0
      let noDraft = 0

      for (const key of keys) {
        if (items.length >= SCAN_LIMIT) break
        if (sample.length < 8) sample.push(key)
        let raw = null
        try {
          raw = ls.getItem(key)
        } catch {
          continue
        }
        if (!raw || raw.length > VALUE_MAX_BYTES) continue

        let parsed = null
        try {
          parsed = JSON.parse(raw)
        } catch {
          parseFailed++
          continue
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue

        const d = parseStoredDraft(parsed)
        if (!d) {
          noDraft++
          continue
        }

        const p = prefixOf(key)
        prefixes[p] = (prefixes[p] || 0) + 1
        items.push({
          key,
          sessionId: extractSessionId(key, parsed),
          text: d.text,
          refCount: d.references.length,
        })
      }

      items.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
      return {
        items,
        total: keys.length,
        prefixes,
        sample,
        parseFailed,
        noDraft,
        error: null,
      }
    }

    function errMsg(e) {
      return e && e.message ? e.message : String(e)
    }

    // ------------------------------------------------------------------
    // 会话目录
    // ------------------------------------------------------------------

    /**
     * 用 ctx.sessions.search 拉会话目录（Host 侧搜索，空 query = 全量）。
     * 失败返回 null，由调用方退化成「只显示 sessionId」。
     */
    async function loadSessionCatalog() {
      const s = hostCtx && hostCtx.sessions
      if (!s || typeof s.search !== 'function') return null
      try {
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
        const signal = ac ? ac.signal : undefined
        // 3 秒后主动放弃，避免面板无限转圈
        if (ac) setTimeout(() => { try { ac.abort() } catch { /* 忽略 */ } }, 3000)
        const res = await s.search('', signal)
        // RemoteResult：可能是 { items } 或 { data: { items } } 或裸数组
        let items = null
        if (Array.isArray(res)) items = res
        else if (res && Array.isArray(res.items)) items = res.items
        else if (res && res.data && Array.isArray(res.data.items)) items = res.data.items
        if (!items) return null

        const map = {}
        for (const it of items) {
          if (!it) continue
          const id = it.sessionId || it.id
          if (!id) continue
          map[String(id)] = {
            title: it.title || it.name || '',
            workspaceId: it.workspaceId || (it.workspace && it.workspace.id) || '',
            workspaceTitle: (it.workspace && it.workspace.title)
              || it.workspaceTitle || it.workspaceName || '',
            blank: it.blank === true,
            archived: it.archived === true,
          }
        }
        return map
      } catch (e) {
        return null
      }
    }

    // ------------------------------------------------------------------
    // 切回会话
    // ------------------------------------------------------------------

    /**
     * 尝试链：uiWorkspace.openSession(string) → openSession({sessionId})
     *        → sessions.retain(string) → sessions.retain({sessionId})
     * 返回 { ok, via } 或 { ok:false, reason }。绝不抛。
     *
     * 为什么要尝试链：SessionTarget 的确切形状没有公开文档，
     * 这里逐个试，把成功的那个记进诊断区。
     */
    async function switchToSession(sessionId) {
      const attempts = []
      const ws = hostCtx && hostCtx.uiWorkspace

      if (ws && typeof ws.openSession === 'function') {
        for (const target of [sessionId, { sessionId }]) {
          try {
            ws.openSession(target)
            return { ok: true, via: 'uiWorkspace.openSession(' + (typeof target === 'string' ? 'string' : 'object') + ')' }
          } catch (e) {
            attempts.push('openSession(' + (typeof target === 'string' ? 'string' : 'object') + '): ' + errMsg(e))
          }
        }
      } else {
        attempts.push('uiWorkspace.openSession 不存在')
      }

      const s = hostCtx && hostCtx.sessions
      if (s && typeof s.retain === 'function') {
        for (const target of [sessionId, { sessionId }]) {
          try {
            const ref = s.retain(target, {})
            // 有些实现把「打开」做在 reference 上
            if (ref && typeof ref.open === 'function') ref.open()
            return { ok: true, via: 'sessions.retain(' + (typeof target === 'string' ? 'string' : 'object') + ')' }
          } catch (e) {
            attempts.push('retain(' + (typeof target === 'string' ? 'string' : 'object') + '): ' + errMsg(e))
          }
        }
      } else {
        attempts.push('sessions.retain 不存在')
      }

      return { ok: false, reason: attempts.join('；') }
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    function truncate(s, n) {
      const t = String(s || '').replace(/\s+/g, ' ').trim()
      return t.length > n ? t.slice(0, n) + '…' : t
    }

    function shortId(id) {
      const s = String(id || '')
      return s.length > 8 ? s.slice(0, 8) : s
    }

    function copyText(text) {
      const done = () => true
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text))
        }
      } catch { /* 落到 legacy */ }
      return Promise.resolve(legacyCopy(text))
    }

    function legacyCopy(text) {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
      } catch {
        return false
      }
    }

    // ------------------------------------------------------------------
    // 样式（只用宿主主题令牌）
    // ------------------------------------------------------------------

    const PANEL_CSS = [
      // 外层撑满 + 内部滚动：面板内容比一屏高时必须能在面板里滚，
      // 否则底部内容被裁掉且滚轮不动（cost-tracker 早期踩过）。
      '.dshud-root{display:flex;flex-direction:column;gap:14px;padding:18px 20px;',
      '  box-sizing:border-box;width:100%;height:100%;min-height:0;',
      '  overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;',
      '  scrollbar-gutter:stable;',
      '  color:var(--dsw-alias-text-primary,inherit);font-size:13px;line-height:1.6}',
      '.dshud-root::-webkit-scrollbar{width:10px}',
      '.dshud-root::-webkit-scrollbar-track{background:transparent}',
      '.dshud-root::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-primary,rgba(127,127,127,.35));',
      '  border-radius:6px;border:2px solid transparent;background-clip:content-box}',
      '.dshud-inner{display:flex;flex-direction:column;gap:14px;width:100%;max-width:820px;',
      '  margin:0 auto;flex:0 0 auto}',
      '.dshud-root h2{margin:0;font-size:16px;font-weight:700}',
      '.dshud-root h3{margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.04em;',
      '  color:var(--dsw-alias-text-secondary,#9ca3af);text-transform:uppercase}',
      '.dshud-card{padding:14px 16px;border-radius:10px;',
      '  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));',
      '  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.18))}',
      '.dshud-hint{color:var(--dsw-alias-text-secondary,#9ca3af);font-size:12px;line-height:1.55}',
      '.dshud-list{display:flex;flex-direction:column;gap:8px}',
      '.dshud-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;',
      '  padding:10px 12px;border-radius:8px;text-align:left;width:100%;',
      '  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));',
      '  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.14));',
      '  color:inherit;font:inherit;cursor:pointer}',
      '.dshud-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));',
      '  border-color:var(--dsw-alias-border-strong,rgba(127,127,127,.3))}',
      '.dshud-row:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,#3b82f6);outline-offset:1px}',
      '.dshud-row-main{min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.dshud-preview{font-weight:600;word-break:break-word;',
      '  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.dshud-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11.5px;',
      '  color:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.dshud-tag{display:inline-flex;align-items:center;gap:4px}',
      '.dshud-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;',
      '  background:var(--dsw-alias-state-warning-primary,#f59e0b)}',
      '.dshud-dot.orphan{background:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.dshud-acts{display:flex;gap:6px;flex:0 0 auto}',
      '.dshud-btn{padding:5px 10px;border-radius:7px;font-size:12px;cursor:pointer;',
      '  background:transparent;color:inherit;',
      '  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.28))}',
      '.dshud-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',
      '.dshud-btn.primary{background:var(--dsw-alias-state-info-primary,#3b82f6);',
      '  border-color:transparent;color:#fff}',
      '.dshud-btn.primary:hover{filter:brightness(1.08)}',
      '.dshud-btn:disabled{opacity:.55;cursor:default}',
      '.dshud-tip{padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.55;',
      '  background:var(--dsw-alias-state-warning-primary,rgba(251,191,36,.12));',
      '  border:1px solid var(--dsw-alias-state-warning-primary,rgba(251,191,36,.35))}',
      '.dshud-tip.bad{background:var(--dsw-alias-state-error-primary,rgba(217,45,32,.1));',
      '  border-color:var(--dsw-alias-state-error-primary,rgba(217,45,32,.32))}',
      '.dshud-tip.good{background:var(--dsw-alias-state-success-primary,rgba(34,160,107,.1));',
      '  border-color:var(--dsw-alias-state-success-primary,rgba(34,160,107,.3))}',
      '.dshud-empty{padding:26px 12px;text-align:center;border-radius:10px;',
      '  border:1px dashed var(--dsw-alias-border-primary,rgba(127,127,127,.28));',
      '  color:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.dshud-diag{margin:0;padding:10px 12px;border-radius:8px;overflow-x:auto;',
      '  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));',
      '  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.14));',
      '  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;',
      '  line-height:1.5;white-space:pre-wrap;word-break:break-all;',
      '  color:var(--dsw-alias-text-secondary,#9ca3af)}',
    ].join('')

    let cssMounted = false
    function mountCss() {
      if (cssMounted) return
      try {
        if (typeof document === 'undefined') return
        if (document.getElementById('dshud-css')) { cssMounted = true; return }
        const s = document.createElement('style')
        s.id = 'dshud-css'
        s.textContent = PANEL_CSS
        ;(document.head || document.documentElement).appendChild(s)
        cssMounted = true
      } catch { /* 样式失败不影响功能 */ }
    }

    // ------------------------------------------------------------------
    // 组件
    // ------------------------------------------------------------------

    /** 侧栏行图标：宿主给 16px 格子，尺寸从 owner.size 取 */
    function NavIcon(owner) {
      const size = (owner && owner.size) || 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      }, [
        h('path', { key: 'doc', d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h8L20 8.5v10A2.5 2.5 0 0 1 17.5 21h-11A2.5 2.5 0 0 1 4 18.5v-13Z' }),
        h('path', { key: 'fold', d: 'M14 3v6h6', opacity: 0.55 }),
        h('path', { key: 'l1', d: 'M8 13.5h7' }),
        h('path', { key: 'l2', d: 'M8 17h4.5' }),
      ])
    }

    /**
     * 错误边界：把渲染异常显示在面板里，而不是让宿主吞掉变成白屏。
     * 没有它时，任何渲染错误都表现为「点开面板一片空白、连诊断按钮都没有」。
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null, info: '' }
      }

      static getDerivedStateFromError(err) {
        return { err }
      }

      componentDidCatch(err, info) {
        try {
          console.error('[dsh-unsent-drafts] panel render error:', err, info)
        } catch { /* 忽略 */ }
        this.setState({ info: (info && info.componentStack) || '' })
      }

      render() {
        if (this.state.err) {
          const e = this.state.err
          const text = [
            '面板渲染失败（插件内部错误，不是 DSH 的问题）：',
            String(e && e.message ? e.message : e),
            '',
            String(e && e.stack ? e.stack : '').split('\n').slice(0, 12).join('\n'),
          ].join('\n')
          return React.createElement('div', {
            className: 'dshud-root',
            style: { padding: '18px 20px' },
          }, [
            React.createElement('h2', { key: 't', style: { margin: '0 0 10px', fontSize: '16px' } }, '未发送草稿'),
            React.createElement('pre', {
              key: 'e',
              className: 'dshud-diag',
              style: { whiteSpace: 'pre-wrap', color: '#d92d20' },
            }, text),
          ])
        }
        return this.props.children
      }
    }

    /** 对外入口：套一层错误边界，保证任何异常都可见 */
    function DraftsPanelGuarded() {
      return React.createElement(PanelBoundary, null, React.createElement(DraftsPanel))
    }

    function DraftsPanel() {
      mountCss()

      // 每次渲染从当前 React 实例取 hooks（理由见 useReact 注释）
      const { useState, useEffect, useCallback } = useReact()

      const [items, setItems] = useState([])
      const [catalog, setCatalog] = useState(null)
      const [scanInfo, setScanInfo] = useState({ total: 0, prefixes: {}, sample: [], error: null })
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const [showDiag, setShowDiag] = useState(false)

      // 会话目录只拉一次：切会话不依赖它，它只用于显示标题
      useEffect(() => {
        let alive = true
        loadSessionCatalog().then((map) => { if (alive) setCatalog(map) })
        return () => { alive = false }
      }, [])

      const refresh = useCallback(() => {
        const r = scanDrafts()
        setItems(r.items)
        setScanInfo({
          total: r.total,
          prefixes: r.prefixes || {},
          sample: r.sample || [],
          parseFailed: r.parseFailed || 0,
          noDraft: r.noDraft || 0,
          error: r.error,
        })
      }, [])

      // 首次 + 定时同步。storage 事件只跨标签页触发，同页面输入不触发，
      // 所以用轮询兜底；间隔放到 1.2s，够跟手又不至于拖累宿主。
      useEffect(() => {
        refresh()
        const t = setInterval(refresh, SYNC_INTERVAL_MS)
        const onStorage = () => refresh()
        try { window.addEventListener('storage', onStorage) } catch { /* 忽略 */ }
        return () => {
          clearInterval(t)
          try { window.removeEventListener('storage', onStorage) } catch { /* 忽略 */ }
        }
      }, [refresh])

      const onJump = useCallback(async (sessionId) => {
        setBusy(true)
        setNote(null)
        try {
          const r = await switchToSession(sessionId)
          if (r.ok) {
            setNote({ kind: 'good', text: '已切回会话 ' + shortId(sessionId) + '（' + r.via + '）。草稿应由 DSH 自动回填到输入框。' })
          } else {
            setNote({ kind: 'bad', text: '切不回该会话：' + r.reason })
          }
        } catch (e) {
          setNote({ kind: 'bad', text: '切会话出错：' + errMsg(e) })
        } finally {
          setBusy(false)
        }
      }, [])

      const onCopy = useCallback(async (item) => {
        const ok = await copyText(item.text)
        setNote(ok
          ? { kind: 'good', text: '已复制 ' + item.text.length + ' 字到剪贴板。' }
          : { kind: 'bad', text: '复制失败（浏览器拒绝了剪贴板访问）。' })
      }, [])

      const prefixSummary = Object.keys(scanInfo.prefixes || {})
        .map((p) => p + ' × ' + scanInfo.prefixes[p])
        .join('　') || '（无）'

      const diagText = [
        '页面 origin：' + (typeof location !== 'undefined' ? location.origin : '(未知)'),
        'localStorage 键总数：' + scanInfo.total,
        '前几个键：' + ((scanInfo.sample && scanInfo.sample.length) ? scanInfo.sample.join('、') : '（无）'),
        '识别到的草稿前缀：' + prefixSummary,
        'JSON 解析失败：' + (scanInfo.parseFailed || 0) + ' 条；无草稿字段：' + (scanInfo.noDraft || 0) + ' 条',
        '扫描上限：' + SCAN_LIMIT + ' 条',
        '会话目录：' + (catalog === null ? '未取到（将只显示 sessionId）' : '已取到 ' + Object.keys(catalog).length + ' 个会话'),
        '切会话 API：uiWorkspace.openSession=' + (hostCtx && hostCtx.uiWorkspace && typeof hostCtx.uiWorkspace.openSession === 'function' ? '有' : '无')
          + '，sessions.retain=' + (hostCtx && hostCtx.sessions && typeof hostCtx.sessions.retain === 'function' ? '有' : '无'),
        '默认提示前缀：' + HINT_PREFIX,
      ].join('\n')

      return h('div', { className: 'dshud-root' }, [
        h('div', { key: 'inner', className: 'dshud-inner' }, [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } }, [
            h('h2', { key: 't' }, '未发送草稿'),
            h('button', {
              key: 'r',
              className: 'dshud-btn',
              type: 'button',
              onClick: refresh,
            }, '刷新'),
          ]),

          h('div', { key: 'lead', className: 'dshud-hint' },
            '这里列出所有「打了字但还没发送」的会话。点击某一条即可切回该会话，'
            + '草稿会由 DSH 自动回填到输入框。'),

          scanInfo.error
            ? h('div', { key: 'err', className: 'dshud-tip bad' }, '⚠ ' + scanInfo.error)
            : null,

          note
            ? h('div', {
              key: 'note',
              className: 'dshud-tip ' + (note.kind === 'bad' ? 'bad' : note.kind === 'good' ? 'good' : ''),
            }, note.text)
            : null,

          items.length === 0
            ? h('div', { key: 'empty', className: 'dshud-empty' }, [
              h('div', { key: 'e1', style: { fontWeight: 700 } }, '没有未发送草稿'),
              h('div', { key: 'e2', style: { marginTop: '4px', fontSize: '12px' } },
                '新建会话打几个字、不要发送，再切到别的会话，这里就会出现一条。'),
            ])
            : h('div', { key: 'list', className: 'dshud-list' }, items.map((item) => {
              const info = catalog ? catalog[String(item.sessionId)] : undefined
              const orphan = !info
              const title = info && info.title ? info.title : ('会话 ' + shortId(item.sessionId))
              const meta = []
              if (info && info.workspaceTitle) meta.push('工作区：' + info.workspaceTitle)
              meta.push(item.text.length + ' 字')
              if (item.refCount > 0) meta.push(item.refCount + ' 个引用')
              if (info && info.blank) meta.push('未发送会话')
              if (info && info.archived) meta.push('已归档')
              if (orphan) meta.push('目录里查不到（孤立草稿）')

              return h('div', { key: item.key, className: 'dshud-row', role: 'group' }, [
                h('button', {
                  key: 'main',
                  type: 'button',
                  className: 'dshud-row',
                  style: { border: 'none', background: 'transparent', padding: 0, cursor: busy ? 'default' : 'pointer' },
                  disabled: busy,
                  onClick: () => { onJump(item.sessionId) },
                  title: '切回会话 ' + item.sessionId,
                }, [
                  h('span', { key: 'prev', className: 'dshud-preview' }, truncate(item.text, PREVIEW_LIMIT)),
                  h('span', { key: 'meta', className: 'dshud-meta' }, [
                    h('span', { key: 'dot', className: 'dshud-dot' + (orphan ? ' orphan' : ''), 'aria-hidden': true }),
                    h('span', { key: 'title' }, title),
                    h('span', { key: 'id', title: item.sessionId }, '#' + shortId(item.sessionId)),
                    ...meta.map((m, i) => h('span', { key: 'm' + i, className: 'dshud-tag' }, m)),
                  ]),
                ]),
                h('div', { key: 'acts', className: 'dshud-acts' }, [
                  h('button', {
                    key: 'copy',
                    className: 'dshud-btn',
                    type: 'button',
                    onClick: () => { onCopy(item) },
                    title: '复制草稿全文',
                  }, '复制'),
                  h('button', {
                    key: 'go',
                    className: 'dshud-btn primary',
                    type: 'button',
                    disabled: busy,
                    onClick: () => { onJump(item.sessionId) },
                    title: '切回该会话',
                  }, orphan ? '尝试跳回' : '跳回'),
                ]),
              ])
            })),

          h('div', { key: 'diagbox', className: 'dshud-card' }, [
            h('button', {
              key: 'toggle',
              className: 'dshud-btn',
              type: 'button',
              onClick: () => setShowDiag((v) => !v),
            }, showDiag ? '收起诊断' : '展开诊断'),
            showDiag
              ? h('pre', { key: 'd', className: 'dshud-diag', style: { marginTop: '8px' } }, diagText)
              : null,
            h('div', { key: 'dn', className: 'dshud-hint', style: { marginTop: '8px' } },
              '诊断区显示本插件实际看到了什么：扫到多少个键、命中的前缀、'
              + '会话目录是否取到、切会话 API 是否存在。跳转失败时先看这里。'),
          ]),
        ]),
      ])
    }

    // ------------------------------------------------------------------
    // 注册
    // ------------------------------------------------------------------

    const inject = ['slots', 'locale']

    /**
     * 插件入口。
     *
     * ⚠️ 整个函数包在 try/catch 里：前端插件抛异常会让 DSH 判定启动失败，
     * 弹出「禁用第三方插件」恢复界面。出错打 console.error 而不静默。
     */
    function apply(ctx) {
      try {
        applyInner(ctx)
      } catch (e) {
        try { console.error('[dsh-unsent-drafts] apply failed:', e) } catch { /* 忽略 */ }
      }
    }

    function applyInner(ctx) {
      hostCtx = ctx

      // 自诊断：面板里读它，便于在真实页面里核对注册是否成功
      const diag = (typeof window !== 'undefined'
        ? (window.__dshUnsentDraftsDiag = window.__dshUnsentDraftsDiag || {})
        : {})
      if (diag.panellist === undefined) diag.panellist = 'pending'
      if (diag.panel === undefined) diag.panel = 'pending'

      ctx.effect(
        () => ctx.locale.register(NAMESPACE, {
          zh: { 'panel.title': '未发送草稿' },
          en: { 'panel.title': 'Unsent Drafts' },
        }),
        'unsent-drafts: dictionaries',
      )

      /**
       * 侧栏行 + 主面板。
       *
       * ⚠️ 必须用 ctx.slots.inject gate 且整段包在 ctx.effect 里：
       * apply 早期 sidebar.panellist 还没建立，裸 register 会被静默丢弃
       * （cost-tracker 2026-10-21 实测：返回了 disposer 但 occupants 里没有）。
       */
      ctx.effect(() => {
        let offPanel = null
        let offRow = null
        let layoutRef = null

        const offInject = ctx.slots.inject('sidebar.panellist', () => {
          try {
            offPanel = ctx.slots.register({
              name: 'main',
              key: PANEL_ID,
              locale: NAMESPACE,
            }, DraftsPanelGuarded)
            diag.panel = 'registered'
          } catch (e) {
            diag.panel = 'failed: ' + errMsg(e)
            try { console.error('[dsh-unsent-drafts] main panel register failed:', e) } catch { /* 忽略 */ }
          }
          try {
            offRow = ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              // order 取 120：宿主原生行在前，第三方插件（cost-tracker 用 90）
              // 之后，两者不贴在一起。
              order: 120,
              label: '草稿',
              locale: NAMESPACE,
            }, NavIcon)
            diag.panellist = 'registered'
          } catch (e) {
            diag.panellist = 'failed: ' + errMsg(e)
            try { console.error('[dsh-unsent-drafts] sidebar.panellist register failed:', e) } catch { /* 忽略 */ }
          }
        })

        try {
          ctx.inject(['layout'], (scoped) => {
            layoutRef = scoped && scoped.layout ? scoped.layout : null
          })
        } catch { /* 宿主无 layout 服务时忽略 */ }

        return () => {
          try {
            // 卸载时若正停在我们的面板上，先退回会话，别留一个空面板
            if (layoutRef && layoutRef.selectPanel) layoutRef.selectPanel(null)
          } catch { /* 忽略 */ }
          if (typeof offRow === 'function') { try { offRow() } catch { /* 忽略 */ } }
          if (typeof offPanel === 'function') { try { offPanel() } catch { /* 忽略 */ } }
          if (typeof offInject === 'function') { try { offInject() } catch { /* 忽略 */ } }
        }
      }, 'unsent-drafts: sidebar entry')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
