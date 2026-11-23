# Antigravity Hub Sidebar Plugin (`agyqq-hub`)

Google Antigravity 侧边栏 MCP App 插件：在 Antigravity 侧边栏中一键打开 **Antigravity Hub** 控制台，并自动检测/后台拉起未运行的 **Bridge / NapCatQQ / GPT-SoVITS v5** 三大本地守护服务。

## 安装与构建

```powershell
# 1. 复制插件目录到 Antigravity 插件根目录（Windows 默认路径）
$Target = "$env:USERPROFILE\.gemini\config\plugins\agyqq-hub"
Copy-Item -Recurse -Force "plugins\agyqq-hub" $Target

# 2. 安装构建依赖并打包 dist/app.html
Set-Location $Target
npm install
npm run build
```

## 指定主项目目录

如果主项目不位于插件目录的上两级，请在 `mcp_config.json` 中为 `hub` 服务配置环境变量 `AGYQQ_BRIDGE_DIR`：

```json
{
  "mcpServers": {
    "hub": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/bin/server.mjs"],
      "env": {
        "AGYQQ_BRIDGE_DIR": "D:\\AGYQQ"
      }
    }
  }
}
```
