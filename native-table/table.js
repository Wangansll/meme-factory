/**
 * 原生 JS 虚拟滚动表格
 * 无框架、无构建、无依赖。
 *
 * 核心难点：
 *   1. 1 万行只能渲染约 20 个 DOM 节点 —— 用占位高度 + translateY 模拟完整滚动区
 *   2. 滚动、搜索、排序都要节流到动画帧，避免一次滚动触发多次重排
 *   3. 事件用委托挂在容器上，不随行数线性增长监听器
 */
'use strict';

// ═══════════════════════════════════════════════════════
//  1. 数据：生成 10000 行假数据
// ═══════════════════════════════════════════════════════
const DEPTS = ['技术部', '产品部', '设计部', '运营部', '市场部', '财务部'];
const LEVELS = ['P4', 'P5', 'P6', 'P7', 'P8'];
const NAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴'];

function mulberry32(seed) {
  // 可复现的伪随机，保证每次刷新数据一样，方便对比
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRows(n) {
  const rnd = mulberry32(20261105);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const name = NAMES[Math.floor(rnd() * NAMES.length)] + NAMES[Math.floor(rnd() * NAMES.length)];
    rows.push({
      id: i + 1,
      name: `${name}${100 + Math.floor(rnd() * 900)}`,
      dept: DEPTS[Math.floor(rnd() * DEPTS.length)],
      level: LEVELS[Math.floor(rnd() * LEVELS.length)],
      salary: 8000 + Math.floor(rnd() * 22000),
      joinedAt: `20${10 + Math.floor(rnd() * 16)}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`,
    });
  }
  return rows;
}

// ═══════════════════════════════════════════════════════
//  2. 表格类
// ═══════════════════════════════════════════════════════
class VirtualTable {
  constructor(root, options = {}) {
    this.root = root;
    this.rowHeight = options.rowHeight ?? 40;
    this.buffer = options.buffer ?? 6;

    this.allRows = [];
    this.viewRows = [];          // 过滤 + 排序后的结果
    this.sortKey = null;
    this.sortDir = 1;            // 1 升序 / -1 降序
    this.keyword = '';
    this.selected = new Set();

    this.viewport = root.querySelector('.vt-viewport');
    this.phantom = root.querySelector('.vt-phantom');
    this.body = root.querySelector('.vt-body');
    this.head = root.querySelector('.vt-head');
    this.stat = document.querySelector('.vt-stat');   // 在 .vt 外面，必须从 document 取

    this._raf = 0;
    this._lastStart = -1;

    this._bind();
  }

  setData(rows) {
    this.allRows = rows;
    this._apply();
  }

  // ── 过滤 + 排序 + 重算滚动区高度 ──
  _apply() {
    const kw = this.keyword.trim().toLowerCase();
    let rows = this.allRows;
    if (kw) {
      rows = rows.filter(r =>
        r.name.toLowerCase().includes(kw) ||
        r.dept.includes(kw) ||
        r.level.toLowerCase().includes(kw)
      );
    }
    if (this.sortKey) {
      const k = this.sortKey, dir = this.sortDir;
      rows = rows.slice().sort((a, b) => {
        const va = a[k], vb = b[k];
        if (typeof va === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb), 'zh-CN') * dir;
      });
    }
    this.viewRows = rows;
    this.phantom.style.height = rows.length * this.rowHeight + 'px';
    this._lastStart = -1;               // 强制重绘
    this.stat.textContent = `${rows.length.toLocaleString()} 行`;
    this.render();
  }

  // ── 只渲染可视区域 ──
  render() {
    const scrollTop = this.viewport.scrollTop;
    const viewH = this.viewport.clientHeight;
    const total = this.viewRows.length;

    const start = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.buffer);
    const visible = Math.ceil(viewH / this.rowHeight) + this.buffer * 2;
    const end = Math.min(total, start + visible);

    if (start === this._lastStart && this._lastEnd === end) return;
    this._lastStart = start;
    this._lastEnd = end;

    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = this.viewRows[i];
      if (!row) continue;
      const el = document.createElement('div');
      el.className = 'vt-row' + (this.selected.has(row.id) ? ' sel' : '');
      el.dataset.id = row.id;
      el.style.transform = `translateY(${i * this.rowHeight}px)`;
      el.innerHTML =
        `<span class="c c-chk"><input type="checkbox" ${this.selected.has(row.id) ? 'checked' : ''}></span>` +
        `<span class="c c-id">${row.id}</span>` +
        `<span class="c c-name">${row.name}</span>` +
        `<span class="c c-dept">${row.dept}</span>` +
        `<span class="c c-level">${row.level}</span>` +
        `<span class="c c-salary">¥${row.salary.toLocaleString()}</span>` +
        `<span class="c c-date">${row.joinedAt}</span>`;
      frag.appendChild(el);
    }
    this.body.replaceChildren(frag);
  }

  // ── 事件：全部委托 ──
  _bind() {
    // 滚动：合并到下一帧，避免一次滚动触发多次渲染
    this.viewport.addEventListener('scroll', () => {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this.render();
      });
    }, { passive: true });

    // 表头排序
    this.head.addEventListener('click', (e) => {
      const th = e.target.closest('.c[data-key]');
      if (!th) return;
      const key = th.dataset.key;
      this.sortDir = this.sortKey === key ? -this.sortDir : 1;
      this.sortKey = key;
      this.head.querySelectorAll('.c').forEach(h => h.classList.remove('asc', 'desc'));
      th.classList.add(this.sortDir === 1 ? 'asc' : 'desc');
      this._apply();
    });

    // 行选择：委托到 body
    this.body.addEventListener('change', (e) => {
      const cb = e.target;
      if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox') return;
      const rowEl = cb.closest('.vt-row');
      if (!rowEl) return;
      const id = Number(rowEl.dataset.id);
      if (cb.checked) this.selected.add(id); else this.selected.delete(id);
      rowEl.classList.toggle('sel', cb.checked);
      this._syncSelected();
    });
  }

  _syncSelected() {
    const n = this.selected.size;
    document.querySelectorAll('[data-selected-count]').forEach(el => {
      el.textContent = n ? `已选 ${n} 项` : '';
    });
  }

  search(kw) {
    this.keyword = kw;
    this._apply();
  }
}

// ═══════════════════════════════════════════════════════
//  3. 启动
// ═══════════════════════════════════════════════════════
const table = new VirtualTable(document.querySelector('.vt'), { rowHeight: 40 });
table.setData(buildRows(10000));

// 搜索输入：防抖 200ms
let searchTimer = 0;
document.querySelector('[data-search]').addEventListener('input', (e) => {
  const v = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => table.search(v), 200);
});

// 统计实际渲染的 DOM 节点数
const observer = new MutationObserver(() => {
  const nodes = table.body.childElementCount;
  document.querySelector('[data-rendered]').textContent = String(nodes);
});
observer.observe(table.body, { childList: true });

// 暴露到全局，方便在控制台里玩
window.__table = table;
