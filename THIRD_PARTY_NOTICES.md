# 第三方组件与来源

本项目自有代码采用 MIT。下列第三方组件及其传递依赖仍受各自许可证约束，本项目的 MIT 不替换它们的原始条款。

| 组件 | 用途与许可 |
| --- | --- |
| [Node.js](https://nodejs.org/) | 桌面 EXE 内嵌运行时；Node.js MIT 与其内置第三方通知。完整官方 LICENSE 随运行时放入内嵌 `licenses/Node-LICENSE.txt` |
| [Express](https://github.com/expressjs/express) | 本机 HTTP 服务；MIT，及其依赖各自的许可 |
| [Vue](https://github.com/vuejs/core) | 界面与相关编译产物；MIT |
| [Vite](https://github.com/vitejs/vite)、[@vitejs/plugin-vue](https://github.com/vitejs/vite-plugin-vue) | 开发/构建工具；MIT，及其依赖各自的许可 |
| [Playwright](https://github.com/microsoft/playwright) | 仅开发测试；Apache-2.0，不作为应用浏览器内嵌 |
| [Microsoft Edge WebView2 SDK](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31) | .NET 桌面窗口及原生加载器；Microsoft 专用许可，非 MIT。完整 LICENSE.txt、NOTICE.txt 放入内嵌 `licenses/WebView2-*` |
| [.NET Framework](https://dotnet.microsoft.com/download/dotnet-framework) 和 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) | 使用系统安装的 Microsoft 运行组件，未将系统运行环境安装器并入 EXE |

安装的准确 npm 版本和完整依赖关系以 `package-lock.json` 为准。生产包目录中的原始 LICENSE/NOTICE 随内嵌运行时保留；前端构建产物也保留构建工具生成的许可注释。Node.js 完整许可证包括其内置 SQLite 等第三方条款。

会计一级科目参考财政部发布的[《小企业会计准则》附录](https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf)，常用明细为本项目预设，不宣称是官方统一明细。使用时须结合实际行业和准则核对。

界面只参考公开工作台的布局形式，未获取参考网站私有数据或未公开接口，未复制其源码、商标、截图或图标。项目图标由绘图代码生成，示例截图由本项目虚构数据生成。
