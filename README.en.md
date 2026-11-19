# Local AI Model Gateway for Windows

[中文部署说明](README.md) · [Project site](https://zzayoung.github.io/local-ai-model-gateway/) · [Download the Windows package](https://github.com/zzayoung/local-ai-model-gateway/releases/latest)

Local AI Model Gateway connects **Claude Code, DeepSeek Harness, and WorkBuddy** to one Windows-local catalog. It routes GPT to OpenAI Responses, WorkBuddy models through a browser-authorized local adapter, and Gemini to Google AI Studio. Gemini is available in DeepSeek Harness, WorkBuddy, and the model manager's direct chat.

| Provider | Models in the initial catalog |
| --- | --- |
| OpenAI | GPT-6 Luna, GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra |
| WorkBuddy | Hy4 Flash (limited-time free), Hy4 Flash (standard), Hy4, Hy3, DeepSeek V4.1 Flash, GLM-5.3 Flash |
| Google AI Studio | Gemini 4 Hydrogen (free and paid projects), Gemini 4 Argon and Carbon (paid project) |

GPT-6.2 Astra and Sol support `low`, `medium`, `high`, `xhigh`, and `max`, with `medium` as the default. See [models.json](gateway/models.json) for each model's settings. Availability and charges depend on the upstream service and your account.

The model manager's image and audio panel supports GPT Image 2.6 Flare and Sunburst, Nano Banana 2.1, Gemini 3.8 Flash and Flash-Lite TTS, and Lyria 3.5. Both TTS models can use either Google project. Nano Banana and Lyria use the paid project. You can preview and download outputs in the browser.

Call `GET /v1/media/models` with the gateway token to list generation models. Send `model` and `prompt` to `POST /v1/images/generations` for a Base64 image. Send `model` and `input` to `POST /v1/audio/speech` for WAV speech or `POST /v1/audio/music` for MP3 music.

WorkBuddy, DeepSeek Harness, and Antigravity can call the same [media tools](#media-tools-for-desktop-clients) from chat.

## Install on Windows

1. Install Node.js 24.5 or later and the clients you plan to use. Close the clients before installing. The gateway uses `127.0.0.1:8791`.
2. Extract the [Windows package](https://github.com/zzayoung/local-ai-model-gateway/releases/latest) and double-click **Install.cmd**. The installer defaults to `E:\AI-Tools` when drive E exists and `%LOCALAPPDATA%\AI-Tools` otherwise. To customize the setup, run the following command with `-InstallRoot`, `-HarnessExe`, `-ClaudeExe`, or `-WorkBuddyExe` as needed.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
   ```

3. Run `Connect-WorkBuddy.ps1` from the installed `Model Gateway` folder and authorize in your browser. Use `-Region global` for the international service. The bridge stores its authorization via Windows DPAPI.
4. Supply your own OpenAI Platform key locally using the `openai-key` file in the installed gateway folder or `OPENAI_API_KEY` in the gateway process environment. Keep credentials and runtime logs out of the repository.
5. For Gemini, create a UTF-8 `.env` file in the installed `Model Gateway` folder. Set `GEMINI_API_KEY` for the free Hydrogen entry and `GEMINI_PAID_API_KEY` for paid Hydrogen, Argon, and Carbon. You can configure either or both. The paid key is never used as a fallback for the free entry. The file is read on each request. The same names can also be set in the gateway process environment.
6. Open **Model Manager - Local Gateway**. Verify [the local health endpoint](http://127.0.0.1:8791/health), then test a model from each configured provider. Gemini also appears in the DeepSeek Harness and WorkBuddy model pickers. The Windows task `Local AI Model Gateway` starts the gateway at user sign-in.

Claude Code connects to the gateway's Anthropic Messages-compatible endpoint. DeepSeek Harness and WorkBuddy use local OpenAI-compatible endpoints. The direct chat entry uses the system prompt supplied in the browser and calls the WorkBuddy service through the adapter without starting the desktop client. Upstream service rules and usage charges still apply.

The WorkBuddy adapter comes from [workbuddy-to-dsh](https://github.com/Ianzhyh/workbuddy-to-dsh). See its [MIT license](gateway/bridge/LICENSE) and [attribution](gateway/bridge/NOTICE.md).

## Media tools for desktop clients

The Windows installer registers `gateway_media` in WorkBuddy, DeepSeek Harness, and Antigravity and preserves other connectors. The three clients share the local gateway and the credentials configured on the target computer.

- **WorkBuddy.** In Experts, Skills & Connectors, open Connectors and Custom Connectors. Trust `gateway_media` the first time you use it. [Tencent's connector setup](https://docs.ardot.tencent.com/ardot-mcp/ide-integration.html#workbuddy)
- **DeepSeek Harness.** Open **DeepSeek Harness - Local Gateway** from the desktop to load the configured profile. [DeepSeek Harness MCP Manager](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-manager)
- **Antigravity.** Launch as usual and check Customizations, Installed, and MCP Servers for the tools. [Google's MCP setup](https://antigravity.google/docs/mcp)

See the [JSON and YAML examples](README.md#在三个客户端使用媒体工具) if you use a custom client profile.

Reopen the client and start a fresh chat. Try asking, “Call `gateway_media`'s `synthesize_speech` with `gemini-3.8-flash-tts-free` to read ‘Hello’ and return the file path.” The `generate_image` tool defaults to GPT Image 2.6 Flare, and `generate_music` defaults to Lyria 3.5. Each tool lists its available models. Outputs are saved under `Model Gateway\media-output`.

## Upgrade from an earlier version

Stop the clients and gateway, then run the new `Install.ps1` with your existing installation root. The installer backs up the catalog and client configurations to `<InstallRoot>\Migration backups`, adds missing Gemini and Hy4 Flash entries, and keeps models you added. It also migrates the GPT-6.1 entries in v0.1.0 to GPT-6.2 Sol and Astra.
