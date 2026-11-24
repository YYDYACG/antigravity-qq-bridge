# Antigravity Hub Sidebar Plugin (`agyqq-hub`)

Google **Antigravity 2.0（AGY 2）** 侧边栏 MCP App 插件（`v1.2.2`）：支持从 AGY 2 左侧 Plugins 整页入口（`global`）与右侧辅助面板（`aux_pane`）一键打开 **Antigravity Hub** 控制台，自动检测并后台拉起未运行的 **Bridge / NapCatQQ / GPT-SoVITS v5** 三大本地守护服务，并支持在面板内直接一键调起本机浏览器打开 NapCatQQ 扫码登录页。

## 一键安装（推荐）

在主项目根目录直接运行安装程序（会自动复制源码、写入 `AGYQQ_BRIDGE_DIR`、安装依赖并打包 `dist/app.html`）：

```powershell
node scripts/install.mjs --yes --with-plugin
```

## 手动安装与构建

```powershell
# 1. 复制插件目录到 Antigravity 2.0 插件根目录（Windows 默认路径）
$Target = "$env:USERPROFILE\.gemini\config\plugins\agyqq-hub"
Copy-Item -Recurse -Force "plugins\agyqq-hub" $Target

# 2. 安装构建依赖并打包 dist/app.html
Set-Location $Target
npm install
npm run build
```

## 指定主项目目录

如果主项目不位于插件目录的上两级，请在 `mcp_config.json` 中为 `hub` 服务配置环境变量 `AGYQQ_BRIDGE_DIR`（使用一键安装程序时会自动写入）：

```json
{
  "mcpServers": {
    "hub": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/bin/server.mjs"],
      "env": {
        "AGYQQ_BRIDGE_DIR": "D:\\antigravity-qq-bridge"
      }
    }
  }
}
```

## 注意事项

- 重建插件（`npm run build`）后，若希望左侧整页或侧边栏立即加载最新前端壳，请在 Antigravity 2.0 中重载该插件或重新打开窗口。
- 即使在旧缓存的页面中，点击控制台内的「打开扫码登录」也会自动回退到本地 Bridge 接口唤起本机默认浏览器，仅允许 `127.0.0.1` / `localhost` 地址。
