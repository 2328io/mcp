# 2328 Wallet plugin

The package connects Codex-compatible plugin hosts to `https://mcp.2328.io/mcp`. Authentication is handled by the MCP server through OAuth; project keys are entered only on the 2328 authorization page.

## ChatGPT registration

ChatGPT requires a registered remote MCP connection before the package can reference it:

1. Enable Developer mode in ChatGPT.
2. Register `https://mcp.2328.io/mcp` in the ChatGPT Plugins page.
3. Copy the generated technical ID beginning with `plugin_asdk_app`.
4. Copy `app.example.json` to `.app.json`, replace its placeholder with the generated ID and add `"apps": "./.app.json"` to `.codex-plugin/plugin.json`.

Do not commit a guessed or placeholder application ID. The `.mcp.json` file remains the source configuration for Codex and other compatible hosts.
