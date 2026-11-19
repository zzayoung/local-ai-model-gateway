# Local AI Model Gateway for Windows

[中文部署说明](README.md) · [Project site](https://zzayoung.github.io/local-ai-model-gateway/) · [Download the Windows package](https://github.com/zzayoung/local-ai-model-gateway/releases/latest)

Local AI Model Gateway connects **Claude Code, DeepSeek Harness, and WorkBuddy** to one Windows-local catalog. It routes GPT to OpenAI Responses, WorkBuddy models through a browser-authorized local adapter, and Gemini to Google AI Studio. Gemini is available in DeepSeek Harness, WorkBuddy, and the model manager's direct chat.

| Provider | Models in the initial catalog |
| --- | --- |
| OpenAI | GPT-6 Luna, GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra |
| WorkBuddy | Hy4 Flash (limited-time free), Hy4 Flash (standard), Hy4, Hy3, DeepSeek V4.1 Flash, GLM-5.3 Flash |
| Google AI Studio | Gemini 4 Hydrogen (free and paid projects), Gemini 4 Argon and Carbon (paid project) |

GPT-6.2 Astra and Sol support `low`, `medium`, `high`, `xhigh`, and `max`, with `medium` as the default. See [models.json](gateway/models.json) for each model's settings. Availability and charges depend on the upstream service and your account.

## Install on Windows

1. Install Node.js 24.5 or later and the clients you plan to use. Close the clients before installing. The gateway uses `127.0.0.1:8791`.
2. Extract the [Windows package](https://github.com/zzayoung/local-ai-model-gateway/releases/latest) and run the following in its directory. The installer defaults to `E:\AI-Tools`. Use `-InstallRoot` for another disk and `-HarnessExe`, `-ClaudeExe`, or `-WorkBuddyExe` for custom app paths.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
   ```

3. Run `Connect-WorkBuddy.ps1` from the installed `Model Gateway` folder and authorize in your browser. Use `-Region global` for the international service. The bridge stores its authorization via Windows DPAPI.
4. Supply your own OpenAI Platform key locally using the `openai-key` file in the installed gateway folder or `OPENAI_API_KEY` in the gateway process environment. Keep credentials and runtime logs out of the repository.
5. For Gemini, create a UTF-8 `.env` file in the installed `Model Gateway` folder. Set `GEMINI_API_KEY` for the free Hydrogen entry and `GEMINI_PAID_API_KEY` for paid Hydrogen, Argon, and Carbon. You can configure either or both. The paid key is never used as a fallback for the free entry. The file is read on each request. The same names can also be set in the gateway process environment.
6. Open **Model Manager - Local Gateway**. Verify [the local health endpoint](http://127.0.0.1:8791/health), then test a model from each configured provider. Gemini also appears in the DeepSeek Harness and WorkBuddy model pickers. The Windows task `Local AI Model Gateway` starts the gateway at user sign-in.

Claude Code connects to the gateway's Anthropic Messages-compatible endpoint. DeepSeek Harness and WorkBuddy use local OpenAI-compatible endpoints. The direct chat entry uses the system prompt supplied in the browser and calls the WorkBuddy service through the adapter without starting the desktop client. Upstream service rules and usage charges still apply.

The WorkBuddy adapter comes from [workbuddy-to-dsh](https://github.com/Ianzhyh/workbuddy-to-dsh). See its [MIT license](gateway/bridge/LICENSE) and [attribution](gateway/bridge/NOTICE.md).

## Upgrade from an earlier version

Stop the clients and gateway, then run the new `Install.ps1` with your existing installation root. The installer backs up the catalog, adds missing Gemini and Hy4 Flash entries, and keeps models you added. It also migrates the GPT-6.1 entries in v0.1.0 to GPT-6.2 Sol and Astra.
