# Zotero Paper Summary

`zotero-paper-summary` 是面向 Zotero 10 的论文分层摘要插件。它通过 Zotero 的 SDT（Structured Document Text）API 提取 PDF 正文与章节结构，再调用 OpenAI 兼容接口生成摘要，在 PDF reader 的侧边面板中展示章节摘要树。

## 功能与要求

- **结构化提取**：依赖 `Zotero.SDT.getReader`，需要提供该 API 的 Zotero 10 版本；不支持仅有旧版 PDF 提取接口的 Zotero。
- **自底向上摘要**：先总结叶子章节，再结合子章节摘要与本节正文生成上层摘要；没有章节目录时按全文处理。
- **OpenAI 兼容接口**：配置 API Base URL、API key、模型和输出语言。Base URL 应包含服务要求的版本路径（例如 `https://api.openai.com/v1`），插件会追加 `/chat/completions`。输出语言支持中文、英文或跟随原文。
- **Reader 面板**：在 PDF 阅读器侧边栏的 Paper Summary 区域点击 **Generate summary**，查看提取、摘要生成进度以及结果或错误。不同附件的状态独立保存。
- **缓存**：运行期间保留附件状态，并将摘要树写入 Zotero 数据目录下的 `papersummary-summary-cache/`。重新打开附件时可加载匹配缓存；PDF 内容、模型、接口地址或输出语言改变后，旧缓存不再复用。

生成摘要会将论文正文片段及子章节摘要发送到所配置的 API 服务。使用前请确认服务的数据处理政策及论文内容的使用权限；本地缓存也包含提取的正文与摘要。

## 安装与使用

1. 获取构建生成的 `.xpi` 文件。
2. 在 Zotero 的插件管理器中选择“从文件安装插件”，安装 XPI，并重启 Zotero。
3. 打开 **Zotero Paper Summary** 偏好设置，配置接口地址、API key、模型与输出语言；可使用连接测试检查配置。
4. 打开 PDF，在 reader 的 Paper Summary 面板中生成摘要。

### 从旧模板身份迁移

插件现使用独立身份：

- 显示名称：`Zotero Paper Summary`
- 插件 ID：`papersummary@purkinje-cell`
- 内部引用：`papersummary`
- Zotero 实例：`PaperSummary`
- 偏好设置前缀：`extensions.zotero.papersummary`

身份更改后，必须重新安装新构建的 XPI 并重启 Zotero；旧模板插件不会自动变成新插件。请停用或卸载旧模板插件，避免同时加载两份代码。旧偏好设置不会自动迁移，需要在新插件中重新配置接口地址、API key、模型和输出语言。缓存目录也随新身份改变，旧模板缓存不会自动加载。

## 开发与构建

需要 Node.js LTS、npm，以及支持 SDT API 的 Zotero 10。进入项目目录后安装依赖：

```sh
npm install
```

将 `.env.example` 复制为 `.env`，配置 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` 和 `ZOTERO_PLUGIN_PROFILE_PATH`；如需单独的数据目录，可设置 `ZOTERO_PLUGIN_DATA_DIR`。建议使用独立的开发 profile 与数据目录，避免影响日常文献库。

启动开发环境（编译并热重载插件）：

```sh
npm start
```

构建插件并执行 TypeScript 类型检查：

```sh
npm run build
```

构建产物位于 `.scaffold/build/`。将其中的 XPI 按上述步骤安装；安装重新构建的 XPI 后应重启 Zotero，以加载新代码。

## 来源与许可证

本项目基于 [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) 开发，使用其插件开发与构建工具链。本项目保留 **AGPL-3.0-or-later** 许可证，详见 [LICENSE](LICENSE)。
