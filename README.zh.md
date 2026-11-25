# @kami232/dsh-btw — btw 侧边聊天

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![npm](https://img.shields.io/npm/v/@kami232/dsh-btw)](https://www.npmjs.com/package/@kami232/dsh-btw) [![npm downloads](https://img.shields.io/npm/dm/%40kami232%2Fdsh-btw?style=flat-square&color=orange)](https://www.npmjs.com/package/@kami232/dsh-btw) [![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/leezhian/dsh-btw)

[English](README.md) | 中文

一个 DeepSeek Harness 插件：提供 ChatGPT 式的临时侧边聊天——在工作旁边打开、
用完关闭即消失，主会话的上下文完全不受影响。

## 你会得到什么

- **两个入口**：`/btw` 命令（斜杠菜单行带插件图标、本地化名称与 `btw` 别名）
  和右侧面板「开始」页上的卡片。
- **主会话同款对话界面**：侧边聊天通过官方 sidebar-chat 同款的
  `SessionProvider` + `conversation.content` 挂载渲染——真实的附件、权限切换、
  模型切换、发送/停止一应俱全；不进入“新会话”选工作区界面，直接空上下文开聊。
- **结构性隔离**：侧边聊天是普通会话（主会话工作目录、无工作区、无子代理、
  无目录登记）。任何内容都不会回流主会话——没有结果投递、没有通知、不增长
  子代理徽标——且创建零模型调用。
- **用完即弃**：关闭标签页即取消并归档该会话（从所有列表消失）；下次 `/btw`
  全新开始。切换主会话时各会话的侧边聊天各自保留；并发打开自动合并。
- **优雅降级**：原生挂载万一抛错，错误边界自动退回自绘面板（流式对话、图片
  附件、本地化权限/模型切换）——绝不白屏。

## 组成

| 文件 | 职责 |
|---|---|
| `lib/client.js` | 标签页 + 开始页卡片 + `/btw` 客户端命令；每主会话的支线生命周期（创建/发送/丢弃），原生对话挂载与降级 |
| `lib/index.js` | 宿主侧仅保留针对 v0.3 遗留 btw 子代理的防护 |
| `docs/DETAIL.md` | 用法、隔离保证与已知限制 |

## 安装

在 DeepSeek Harness Web GUI 中：**Plugins → Add plugin**，选择本目录
（`dsh-btw/`）。需要标准 web 客户端组成（`dsh-client-ui-conversation`、
`dsh-client-ui-sidebar-right`），DSH 0.2.2-rc.3 及以后版本自带。

## 许可证

MIT
