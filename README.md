# 表情包工厂 · AI 表情包生产线

输入一个「梗」，AI 产出一整套九张表情包。可切换萌系、熊猫头、doge、像素、手绘、3D 盲盒等 13 档画风，
支持透明抠图、九宫格下载与分享链接。

**线上地址**：https://meme-factory-55315.app.workbuddy.host/

## 技术栈

纯原生 HTML / CSS / JavaScript（无框架、无构建工具）+ Node 原生 `http` 后端。

## 本地运行

```bash
# 后端（默认 3000 端口）
PROVIDER_API_KEY=你的生图服务密钥 node server.js

# 前端是静态文件，后端已托管;直接访问 http://127.0.0.1:3000
```

`config.js` 只放前端可公开的配置（接口地址、发布级 key），**真正的密钥不写进代码**。

## 目录

| 路径 | 说明 |
|---|---|
| `index.html` / `style.css` / `app.js` | 前端（单页，1900+ 行原生 JS） |
| `server.js` | 后端：会话、生成、生成状态、分享创建/读取、作品列表 |
| `arena/` `native-table/` `portfolio/` `vendor/` | 附带的小页面与依赖 |
| `config.js` | 前端可公开配置 |

## 关于密钥

- 生成功能需要 `PROVIDER_API_KEY` 环境变量；未设置时接口返回 `missing_provider_key`，界面其余功能照常。
- 页面上的「访问密钥」（`mf-demo-2026`）是**演示用的解锁口令**，页面上直接展示，不是任何服务的凭据。
- `session-secret.key`、`.env`、`fx/`（生成素材，约 1.7 GB）都不进仓库。

## 说明

这是个人项目，用于学习与作品展示。生成的图片由第三方模型产出。