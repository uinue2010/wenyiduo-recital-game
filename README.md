# 闻一多《最后一次讲演》朗诵闯关

一个面向八年级语文课堂的本地网页应用。学生逐段朗读《最后一次讲演》，系统采集麦克风音频，结合 Gemini Live 与结构化评分接口，给出即时评分、专业点评和本机进度记录。

## 功能

- 固定课文闯关，按段落预设“演讲”或“朗诵”模式
- 录音过程中显示实时转写辅助
- 朗读结束后立即返回结构化评分与专业点评
- 本地保存录音、成绩、点评和通关状态
- 无 API Key 时提供本地模拟评分，方便联调

## 环境

- Node.js `24.x`
- Gemini API Key

## 启动

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

填写 `.env` 中的 `GEMINI_API_KEY`。

3. 本地开发

```bash
npm run dev
```

- 前端默认运行在 [http://localhost:5173](http://localhost:5173)
- 后端默认运行在 [http://localhost:8787](http://localhost:8787)

4. 构建

```bash
npm run build
```

## 部署为 HTTPS 链接

最省事的方式是部署到 Render，然后把生成的 `https://xxx.onrender.com` 链接发给别人。

### 方案特点

- 别的 Windows 电脑不用装 Node，也不用下载源码
- 浏览器直接打开 HTTPS 链接即可使用麦克风
- `GEMINI_API_KEY` 只放在你的部署平台，不会暴露给学生电脑

### 推荐步骤

1. 把这个项目上传到 GitHub 仓库
2. 注册并登录 Render
3. 在 Render 新建 `Web Service`
4. 连接你的 GitHub 仓库
5. Render 会读取根目录的 `render.yaml`
6. 在环境变量里填写：
   - `GEMINI_API_KEY`
   - `WEB_ORIGIN`
     - 首次可先填你部署后的域名，例如 `https://wenyiduo-recital-game.onrender.com`
7. 部署完成后，把 Render 分配的 HTTPS 地址直接发给对方

### 重要提醒

- 如果使用 Render 免费实例，服务重启后本地 SQLite 与录音文件可能丢失，因为免费实例默认是临时文件系统。
- 如果你需要长期保留学生成绩和录音，建议升级到支持持久磁盘的方案，或后续把数据改存到托管数据库/对象存储。
- 如果只是课堂演示、试用或短期使用，免费实例通常已经够用。

## API

- `GET /api/lesson`
- `POST /api/attempts`
- `POST /api/attempts/:id/audio`
- `GET /api/attempts/:id/result`
- `GET /api/history`
- `GET /api/health`
- `WS /api/live/:attemptId`

## 说明

- `data/` 目录会在首次运行时自动创建，用于存放 SQLite 数据库和录音文件。
- Live 转写走 Gemini Live API；最终评分优先使用 Gemini 结构化输出。
- 如需课堂演示但暂时没有 API Key，系统会自动切换为本地模拟评分模式。
