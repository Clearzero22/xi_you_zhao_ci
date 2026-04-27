# 项目总结：xiyouzhaoci.com 关键词爬虫

## 概述

Amazon 关键词研究工具爬虫，用于从西柚找词（xiyouzhaoci.com）批量查询 ASIN 的关键词数据。

**技术栈：** Bun + Playwright + TypeScript

## 核心功能

- **并发查询**：同时查询多个 ASIN，信号量控制并发数（默认 3）
- **DOM 提取**：全选表格后直接从 DOM 提取数据，支持无头模式
- **CSV 导出**：关键词数据导出为 CSV 格式
- **数据可视化**：内置查看器，支持搜索、列过滤、分页

## 文件结构

```
xi_you_zhao_ci/
├── index.ts          # 主爬虫脚本
├── viewer.html       # CSV 数据查看器
├── record.ts         # 手动操作/录制模式
├── debug.ts          # 调试版本（截图、请求拦截）
├── .chrome-data/     # Chrome 持久化数据目录
├── keywords-*.csv    # 导出的关键词数据
└── package.json      # 项目依赖
```

## 使用方式

### 1. 配置 ASIN 列表

编辑 `index.ts` 中的 `TARGET_ASINS` 数组：

```typescript
const TARGET_ASINS = [
  "B0DZFGTCLR",
  "B0XXXXXXX",
  // 添加更多 ASIN
];
```

### 2. 运行爬虫

```bash
bun run index.ts
```

输出文件：`keywords-{ASIN}.csv`

### 3. 查看数据

浏览器打开 `viewer.html`，选择 CSV 文件即可可视化查看。

## 开发历程

| Commit | 说明 |
|--------|------|
| `dabf617` | 初始化：单 ASIN 查询，剪贴板复制 |
| `87e1cb5` | 滚动查找 `.check_block` 元素 |
| `1035df7` | 重构为并发多 ASIN（信号量控制，3 tab 并发） |
| `d776a3a` | DOM 表格提取替代剪贴板（支持 headless） |
| `54f9af6` | CSV 数据查看器（搜索、分页、列过滤） |

## 配置说明

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `DATA_DIR` | `./.chrome-data` | Chrome 持久化目录 |
| `CONCURRENCY` | `3` | 最大并发 tab 数 |
| `headless` | `true` | 无头模式开关 |

## 注意事项

- 首次运行需手动登录网站（Chrome 会话持久化）
- 虚拟滚动表格可能只渲染部分行，当前 DOM 提取仅获取已渲染行
- 无头模式下剪贴板 API 不可用，故采用 DOM 提取方案
