# Local AI Model Gateway · Windows 本地模型网关

[项目首页](https://zzayoung.github.io/local-ai-model-gateway/) · [下载 Windows 部署包](https://github.com/zzayoung/local-ai-model-gateway/releases/latest) · [English](README.en.md)

在 Windows 上用一个本地模型网关，让 **Claude Code、DeepSeek Harness 和 WorkBuddy** 共用 OpenAI 官方 API、WorkBuddy 模型及各自支持的思考档位。模型管理页可以检查 OpenAI 新模型，勾选后同步到三端，也可以直接发起纯对话或重启三个客户端。

## 支持的模型和客户端

| 提供方 | 初始模型 |
| --- | --- |
| OpenAI 官方 API | GPT-6 Luna、GPT-6.2 Astra、GPT-6.2 Sol、GPT-6 Astra |
| WorkBuddy | Hy4、Hy3、DeepSeek V4.1 Flash、GLM-5.3 Flash |

GPT-6.2 Astra 和 Sol 支持 `low`、`medium`、`high`、`xhigh`、`max`，默认 `medium`。各模型的档位见 [模型清单](gateway/models.json)。调用能否成功取决于账号权限、余额及上游当时的服务状态。

| 客户端 | 本地网关接口 | 选择模型 |
| --- | --- | --- |
| Claude Code | Anthropic Messages 兼容接口 `/v1/messages` | `/model` |
| DeepSeek Harness | `/v1/responses`、`/v1/chat/completions` | 模型选择器 |
| WorkBuddy | 自定义模型接口 `/workbuddy/v1/chat/completions` | 模型选择器 |

网关监听 `127.0.0.1:8791`。三个客户端与模型管理页通过本机连接，网关再向对应的供应方发起请求。

## 安装前

- 从 [GitHub Releases](https://github.com/zzayoung/local-ai-model-gateway/releases/latest) 下载并解压 Windows 部署包，也可以克隆本仓库。
- 使用 Windows 10 或 11，以及 PATH 上的 Node.js 24.5 或更高版本。
- 安装需要使用的三个客户端。默认从当前 Windows 用户的 WorkBuddy 安装位置及常见的 Claude Code、DeepSeek Harness 位置查找，也可显式指定三个 EXE 的完整路径。Claude Code 使用网关入口时由网关提供模型，随包生成的令牌用于本机连接。
- 关闭三个客户端。如果本机已有网关，先停止原网关并确认本地端口 8791 空闲。

## 安装

在解压后的目录中打开 PowerShell：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

默认放在 `E:\AI-Tools`。没有 E 盘时使用其他本地目录，应用在非默认位置时追加对应参数：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -InstallRoot 'D:\AI-Tools' -HarnessExe 'D:\Apps\DeepSeek Harness\DeepSeek Harness.exe' -ClaudeExe 'D:\Apps\Claude\claude.exe' -WorkBuddyExe 'D:\Apps\WorkBuddy\WorkBuddy.exe'
```

安装会备份现有的 WorkBuddy 模型配置和目标目录中的 Harness 桌面配置，备份位于 `<InstallRoot>\Migration backups`。Claude Code 配置与工作区、DeepSeek Harness 的新配置目录都在安装根目录下。Windows 任务 `Local AI Model Gateway` 在当前用户登录时启动网关，桌面生成模型管理页和三个客户端入口。若安装时没有找到 Claude Code 或 Harness，可安装后在网关目录的 `deployment.json` 填入对应的 EXE 路径。

从 v0.1.0 升级时，先关闭客户端和网关，再用原安装目录运行新版 `Install.ps1`。安装器备份网关模型清单，将 GPT-6.1 Sol 替换为 GPT-6.2 Sol，将 GPT-6.1 Terra 替换为 GPT-6.2 Astra，并保留手动添加的其他模型。

## 在目标机授权

1. WorkBuddy 在浏览器完成授权。在运行网关的 Windows 账户中从安装后的网关目录运行下列命令。国际区使用 `-Region global`。凭据由 Windows DPAPI 保护。

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Connect-WorkBuddy.ps1
   ```

2. OpenAI 使用自己的官方 Platform API 密钥。在网关安装目录创建扩展名为空的 `openai-key` 文件，仅写入密钥本身，建议以 UTF-8 保存。也可以使用已经为网关进程配置的 `OPENAI_API_KEY`。用文件配置时下一次 API 请求即可读取。密钥只在本机录入，请勿提交到 Git 或粘贴到 Issue。

## 验证与日常使用

1. 打开桌面上的 **Model Manager - Local Gateway**。确认管理页显示 8 个初始模型及思考档位。浏览器也可访问 `http://127.0.0.1:8791/health` 查看网关状态。
2. 在管理页的纯对话里分别试一个 WorkBuddy 模型和一个 OpenAI 模型。纯对话走网关，WorkBuddy 模型使用该账号的 WorkBuddy 额度，系统提示词由对话页传入。
3. 用新生成的桌面入口启动各客户端。Claude Code 输入 `/model`，DeepSeek Harness 和 WorkBuddy 使用各自的模型选择器。
4. 在管理页检查 OpenAI 模型更新，选中要用的模型再同步。需要重新加载配置时先保存客户端中的工作，再使用重启客户端按钮。
5. 下次登录当前 Windows 用户后，复查 `/health` 确认登录自启。

网关启动错误记录在安装目录下的 `Model Gateway\error.log`。授权、模型调用或客户端路径有问题时，可以把脱敏后的报错和上述验证步骤交给 Codex 排查。

## 常见问题

### Claude Code 可以用 OpenAI API 吗？

Claude Code 连接网关提供的 Messages 兼容接口。网关再调用 OpenAI 官方 Responses API，并将选定的模型和思考档位转换为对应参数。

### 纯对话会经过 WorkBuddy 桌面客户端的提示词吗？

网关从管理页接收系统提示词和对话，经适配器向 WorkBuddy 上游发送。该入口绕开 WorkBuddy 桌面端，上游服务仍会按其规则处理请求和计费。

### 检查到新模型后会直接写入三个客户端吗？

管理页列出候选模型和核对到的能力，勾选并应用后才写入三端配置。

### 在另一台 Windows 电脑上怎么用 Codex 部署？

下载 Release 中的 ZIP 并交给 Codex，请它按本页说明执行 `Install.ps1`，再验证 `/health`、模型选择器和登录自启。每台电脑单独完成 WorkBuddy 浏览器授权和 OpenAI API 密钥设置。

## 第三方组件

WorkBuddy 适配器来自 [workbuddy-to-dsh](https://github.com/Ianzhyh/workbuddy-to-dsh)，保留其 [MIT 许可](gateway/bridge/LICENSE) 和 [来源说明](gateway/bridge/NOTICE.md)。这是独立的本地集成项目，WorkBuddy 适配器依赖上游登录及模型接口。
