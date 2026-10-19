using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public sealed class DesktopWindow : Form
{
    private readonly DesktopOptions options;
    private readonly Label status;
    private readonly WebView2 browser;
    private readonly object logLock = new object();
    private readonly List<Form> popupWindows = new List<Form>();
    private readonly Dictionary<string, PrintPreview> printPreviews = new Dictionary<string, PrintPreview>();
    private readonly TaskCompletionSource<string> backendReady = new TaskCompletionSource<string>();
    private CoreWebView2Environment environment;
    private Process backend;
    private string appOrigin;
    private volatile bool closing;
    private bool closeAllowed;
    private bool failed;
    private bool interfaceRendered;

    public DesktopWindow(DesktopOptions options)
    {
        if (options == null) throw new ArgumentNullException("options");
        this.options = options;
        Text = "财务代账系统";
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1440, 1000);
        MinimumSize = new Size(1000, 700);
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.White;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        browser = new WebView2 { Dock = DockStyle.Fill, Visible = false, DefaultBackgroundColor = Color.White };
        status = new Label {
            Dock = DockStyle.Fill,
            Text = "正在启动财务代账系统…\r\n首次打开可能需要几秒钟。",
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Microsoft YaHei", 12),
            Padding = new Padding(48)
        };
        Controls.Add(browser);
        Controls.Add(status);
        Shown += async delegate { await StartApplicationAsync(); };
    }

    private async Task StartApplicationAsync()
    {
        try
        {
            Directory.CreateDirectory(options.DataDir);
            Log("Desktop starting. Runtime=" + options.RuntimeDir + " Data=" + options.DataDir);
            StartBackend();
            Task winner = await Task.WhenAny(backendReady.Task, Task.Delay(25000));
            if (closing) return;
            if (winner != backendReady.Task) throw new TimeoutException("本地服务未能在 25 秒内启动。");
            string url = await backendReady.Task;
            if (closing) return;
            appOrigin = new Uri(url).GetLeftPart(UriPartial.Authority);
            status.Text = "正在打开财务代账系统界面…";

            CoreWebView2EnvironmentOptions environmentOptions = new CoreWebView2EnvironmentOptions();
            if (options.DebugPort > 0)
                environmentOptions.AdditionalBrowserArguments = "--remote-debugging-port=" + options.DebugPort + " --remote-allow-origins=http://localhost:" + options.DebugPort + ",http://127.0.0.1:" + options.DebugPort;
            environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(options.DataDir, "webview2-profile"), environmentOptions);
            if (closing) return;
            await browser.EnsureCoreWebView2Async(environment);
            if (closing) return;
            ConfigureBrowser(browser, this, true);
            await InstallPrintingBridgeAsync();
            browser.CoreWebView2.Navigate(url);
            Log("Navigating to " + url);
        }
        catch (Exception error)
        {
            if (!closing)
            {
                ShowFailure("财务代账系统启动失败", error);
            }
        }
        if (failed && !closing) await StopBackendAsync();
    }

    private void StartBackend()
    {
        string nodePath = Path.Combine(options.RuntimeDir, "node.exe");
        string entryPath = Path.Combine(options.RuntimeDir, "desktop-server.mjs");
        if (!File.Exists(nodePath) || !File.Exists(entryPath))
            throw new FileNotFoundException("程序文件不完整，请重新运行完整的财务代账系统程序包。");
        ProcessStartInfo start = new ProcessStartInfo {
            FileName = nodePath,
            Arguments = "\"" + entryPath + "\"",
            WorkingDirectory = options.RuntimeDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        start.EnvironmentVariables["YUNDAIZHANG_DATA_DIR"] = options.DataDir;
        backend = new Process { StartInfo = start, EnableRaisingEvents = true };
        backend.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) {
            if (args.Data == null) return;
            Log("server: " + args.Data);
            if (!args.Data.StartsWith("YUNDAIZHANG_READY ", StringComparison.Ordinal)) return;
            try
            {
                Dictionary<string, object> message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(args.Data.Substring("YUNDAIZHANG_READY ".Length));
                object value;
                Uri uri;
                if (!message.TryGetValue("url", out value) || !Uri.TryCreate(Convert.ToString(value), UriKind.Absolute, out uri) ||
                    uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.Port < 1 || uri.UserInfo.Length != 0)
                    throw new InvalidDataException("本地服务返回了无效的地址。");
                backendReady.TrySetResult(uri.AbsoluteUri);
            }
            catch (Exception error) { backendReady.TrySetException(error); }
        };
        backend.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) {
            if (args.Data != null) Log("server stderr: " + args.Data);
        };
        backend.Exited += delegate {
            string message = "本地服务意外退出。";
            try { message += "退出代码：" + backend.ExitCode; } catch { }
            Log(message);
            backendReady.TrySetException(new IOException(message));
            if (!closing) OnUi(delegate { ShowFailure("本地服务已停止，请关闭后重新打开财务代账系统", new IOException(message)); });
        };
        if (!backend.Start()) throw new IOException("无法启动本地服务。");
        backend.BeginOutputReadLine();
        backend.BeginErrorReadLine();
        Log("Backend PID=" + backend.Id);
    }

    private void ConfigureBrowser(WebView2 view, Form owner, bool mainWindow)
    {
        CoreWebView2 core = view.CoreWebView2;
        core.Settings.AreDefaultScriptDialogsEnabled = true;
        core.Settings.IsWebMessageEnabled = true;
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = options.DebugPort > 0;
        core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) {
            if (IsAppAddress(args.Uri)) return;
            if (!mainWindow && (args.Uri.StartsWith("data:text/html",StringComparison.OrdinalIgnoreCase) || args.Uri.StartsWith("about:blank",StringComparison.OrdinalIgnoreCase))) return;
            Log("Blocked navigation: " + (args.Uri.Length>80?args.Uri.Substring(0,80):args.Uri));
            args.Cancel = true;
            if (args.IsUserInitiated) OpenExternalAddress(args.Uri);
        };
        core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs args) {
            SaveDownload(owner, args);
        };
        core.NewWindowRequested += async delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args) {
            await OpenPopupAsync(args);
        };
        core.WindowCloseRequested += delegate { owner.Close(); };
        core.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs args) {
            Log("WebView2 process failed: " + args.ProcessFailedKind);
            if (mainWindow && !closing) ShowFailure("界面进程已停止，请关闭后重新打开财务代账系统", new IOException(args.ProcessFailedKind.ToString()));
        };
        if (mainWindow)
        {
            core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args) {
                if (closing || failed) return;
                if (!args.IsSuccess)
                {
                    if (interfaceRendered && args.WebErrorStatus == CoreWebView2WebErrorStatus.ConnectionAborted)
                    {
                        Log("Ignored canceled navigation after the interface loaded (for example, a download).");
                        return;
                    }
                    ShowFailure("财务代账系统界面加载失败", new IOException(args.WebErrorStatus.ToString()));
                    return;
                }
                interfaceRendered = true;
                browser.Visible = true;
                browser.BringToFront();
                status.Visible = false;
                Log("Desktop interface ready.");
            };
        }
    }

    private bool IsAppAddress(string address)
    {
        if (String.Equals(address, "about:blank", StringComparison.OrdinalIgnoreCase)) return true;
        if (appOrigin == null) return false;
        if (address.StartsWith("blob:" + appOrigin + "/", StringComparison.OrdinalIgnoreCase)) return true;
        Uri uri;
        return Uri.TryCreate(address, UriKind.Absolute, out uri) &&
            String.Equals(uri.GetLeftPart(UriPartial.Authority), appOrigin, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class PrintPreview
    {
        public Form Window;
        public WebView2 View;
        public bool Ready;
        public bool PrintRequested;
    }

    private async Task InstallPrintingBridgeAsync()
    {
        browser.CoreWebView2.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs args) {
            try
            {
                Log("Print bridge message from " + args.Source);
                if (!IsAppAddress(args.Source)) return;
                var message = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 }.Deserialize<Dictionary<string, object>>(args.WebMessageAsJson);
                Log("Print bridge fields: " + String.Join(",",message.Keys));
                Log("Print bridge kind="+Convert.ToString(message["type"])+" chars="+Convert.ToString(message["html"]).Length+" closing="+closing);
                object type, id, html, print;
                if (!message.TryGetValue("type", out type) || Convert.ToString(type) != "desktop-print" ||
                    !message.TryGetValue("id", out id) || !message.TryGetValue("html", out html) || !message.TryGetValue("print", out print)) return;
                string key = Convert.ToString(id), document = Convert.ToString(html);
                if (key.Length > 100 || document.Length > 2 * 1024 * 1024) return;
                bool printRequested=Convert.ToBoolean(print);
                BeginInvoke(new Action(async delegate {
                    try { await ShowPrintPreviewAsync(key,document,printRequested); }
                    catch(Exception error) { Log("Print preview failed: "+error);if(!closing)MessageBox.Show(this,"打印预览无法打开："+error.Message,"财务代账系统",MessageBoxButtons.OK,MessageBoxIcon.Error); }
                }));
            }
            catch (Exception error) { Log("Print preview failed: " + error); if (!closing) MessageBox.Show(this,"打印预览无法打开："+error.Message,"财务代账系统",MessageBoxButtons.OK,MessageBoxIcon.Error); }
        };
        // WebView2 replaces a window.open target asynchronously; keep synchronous voucher writes intact.
        await browser.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
(() => {
 const nativeOpen = window.open;
 window.open = function(url, target, features) {
  if ((url === '' || url === 'about:blank') && target === '_blank') {
   let html = ''; const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
   const send = print => window.chrome.webview.postMessage({type:'desktop-print', id, html, print});
   return {document:{write(value){html += String(value);},close(){send(false);}},focus(){},print(){send(true);},closed:false};
  }
  return nativeOpen.call(window, url, target, features);
 };
})();");
    }

    private async Task ShowPrintPreviewAsync(string id, string html, bool print)
    {
        PrintPreview preview;
        if (printPreviews.TryGetValue(id, out preview))
        {
            preview.PrintRequested = preview.PrintRequested || print;
            if (print && preview.Ready && !options.TestMode) preview.View.CoreWebView2.ShowPrintUI();
            return;
        }
        if (closing) return;
        preview = new PrintPreview { Window = new Form { Text="凭证打印 · 财务代账系统",StartPosition=FormStartPosition.CenterParent,Size=new Size(1100,850),MinimumSize=new Size(700,500),Icon=Icon }, View=new WebView2 { Dock=DockStyle.Fill,DefaultBackgroundColor=Color.White },PrintRequested=print };
        printPreviews.Add(id,preview); popupWindows.Add(preview.Window);
        preview.Window.Controls.Add(preview.View);
        PrintPreview retained=preview;
        preview.Window.FormClosed += delegate { printPreviews.Remove(id);popupWindows.Remove(retained.Window);retained.View.Dispose(); };
        preview.Window.Show(this);
        Log("Preparing printable document window.");
        await preview.View.EnsureCoreWebView2Async(environment);
        Log("Printable document controller ready.");
        if (closing || preview.Window.IsDisposed) return;
        ConfigureBrowser(preview.View,preview.Window,false);
        preview.View.CoreWebView2.DocumentTitleChanged += delegate { if(!retained.Window.IsDisposed)retained.Window.Text=retained.View.CoreWebView2.DocumentTitle+" · 财务代账系统"; };
        preview.View.CoreWebView2.NavigationCompleted += delegate(object sender,CoreWebView2NavigationCompletedEventArgs args) {
            Log("Printable navigation completed: "+args.IsSuccess+" "+args.WebErrorStatus);
            if(!args.IsSuccess || closing || retained.Window.IsDisposed)return;
            retained.Ready=true;
            Log("Printable document ready.");
            if(retained.PrintRequested && !options.TestMode)retained.View.CoreWebView2.ShowPrintUI();
        };
        preview.View.CoreWebView2.NavigateToString(html);
    }

    private void OpenExternalAddress(string address)
    {
        Uri uri;
        if (!Uri.TryCreate(address, UriKind.Absolute, out uri) || (uri.Scheme != "http" && uri.Scheme != "https")) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception error) { Log("External link failed: " + error); }
    }

    private async Task OpenPopupAsync(CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        if (!IsAppAddress(args.Uri))
        {
            if (args.IsUserInitiated) OpenExternalAddress(args.Uri);
            return;
        }
        CoreWebView2Deferral deferral = args.GetDeferral();
        Form popup = null;
        try
        {
            if (closing) return;
            popup = new Form {
                Text = "凭证打印 · 财务代账系统",
                StartPosition = FormStartPosition.CenterParent,
                Size = new Size(1100, 850),
                MinimumSize = new Size(700, 500),
                Icon = Icon
            };
            WebView2 popupBrowser = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.White };
            popup.Controls.Add(popupBrowser);
            popupWindows.Add(popup);
            Form retainedPopup = popup;
            popup.FormClosed += delegate {
                popupWindows.Remove(retainedPopup);
                popupBrowser.Dispose();
            };
            popup.Show(this);
            await popupBrowser.EnsureCoreWebView2Async(environment);
            if (closing || popup.IsDisposed) return;
            ConfigureBrowser(popupBrowser, popup, false);
            popupBrowser.CoreWebView2.DocumentTitleChanged += delegate {
                if (!retainedPopup.IsDisposed) retainedPopup.Text = popupBrowser.CoreWebView2.DocumentTitle + " · 财务代账系统";
            };
            args.NewWindow = popupBrowser.CoreWebView2;
            Log("Opened application popup: " + args.Uri);
        }
        catch (Exception error)
        {
            Log("Popup failed: " + error);
            if (popup != null && !popup.IsDisposed) popup.Close();
            if (!closing) MessageBox.Show(this, "打印窗口无法打开：" + error.Message, "财务代账系统", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            try { deferral.Complete(); }
            catch (Exception error) { Log("Popup deferral ended after its window closed: " + error.Message); }
        }
    }

    private void SaveDownload(Form owner, CoreWebView2DownloadStartingEventArgs args)
    {
        args.Handled = true;
        CoreWebView2Deferral deferral = args.GetDeferral();
        try
        {
            // Modal dialogs must run after the WebView2 callback returns.
            BeginInvoke(new Action(delegate { SelectDownloadFile(owner, args, deferral); }));
        }
        catch (Exception error)
        {
            args.Cancel = true;
            try { deferral.Complete(); } catch { }
            Log("Could not schedule download dialog: " + error);
        }
    }

    private void SelectDownloadFile(Form owner, CoreWebView2DownloadStartingEventArgs args, CoreWebView2Deferral deferral)
    {
        Exception saveError = null;
        try
        {
            if (closing || owner.IsDisposed) { args.Cancel = true; return; }
            if (options.TestMode)
            {
                string downloadDirectory = Path.Combine(options.DataDir, "test-downloads");
                Directory.CreateDirectory(downloadDirectory);
                args.ResultFilePath = Path.Combine(downloadDirectory, Path.GetFileName(args.ResultFilePath));
            }
            else
                using (SaveFileDialog dialog = new SaveFileDialog())
                {
                    dialog.Title = "保存导出文件";
                    dialog.FileName = Path.GetFileName(args.ResultFilePath);
                    dialog.Filter = "所有文件 (*.*)|*.*";
                    dialog.OverwritePrompt = true;
                    dialog.RestoreDirectory = true;
                    if (dialog.ShowDialog(owner) != DialogResult.OK) { args.Cancel = true; return; }
                    args.ResultFilePath = dialog.FileName;
                }
            Log("Download selected: " + args.ResultFilePath);
            CoreWebView2DownloadOperation operation = args.DownloadOperation;
            operation.StateChanged += delegate {
                Log("Download state: " + operation.State + " " + operation.ResultFilePath + " " + operation.InterruptReason);
                if (operation.State == CoreWebView2DownloadState.Interrupted &&
                    operation.InterruptReason != CoreWebView2DownloadInterruptReason.UserCanceled)
                {
                    string reason = DownloadFailureReason(operation.InterruptReason);
                    string fileName = Path.GetFileName(operation.ResultFilePath);
                    OnUi(delegate {
                        if (!closing && !owner.IsDisposed)
                            MessageBox.Show(owner, "文件未能完整保存：" + fileName + "\r\n\r\n" + reason + "\r\n请检查保存位置后重新导出。", "财务代账系统 · 保存失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    });
                }
            };
        }
        catch (Exception error)
        {
            try { args.Cancel = true; } catch { }
            Log("Download failed: " + error);
            saveError = error;
        }
        finally
        {
            try { deferral.Complete(); }
            catch (Exception error) { Log("Download deferral ended after its window closed: " + error.Message); }
        }
        if (saveError != null && !closing && !owner.IsDisposed)
            MessageBox.Show(owner, "无法保存文件：" + saveError.Message, "财务代账系统 · 保存失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private static string DownloadFailureReason(CoreWebView2DownloadInterruptReason reason)
    {
        switch (reason)
        {
            case CoreWebView2DownloadInterruptReason.FileAccessDenied: return "所选保存位置没有写入权限。";
            case CoreWebView2DownloadInterruptReason.FileNoSpace: return "目标磁盘剩余空间不足。";
            case CoreWebView2DownloadInterruptReason.FileNameTooLong: return "文件保存路径过长，请选择较短的路径。";
            case CoreWebView2DownloadInterruptReason.FileTooLarge: return "文件大小超过了目标磁盘文件系统的限制。";
            case CoreWebView2DownloadInterruptReason.FileTransientError: return "目标文件可能正在使用，或系统暂时无法写入文件。";
            case CoreWebView2DownloadInterruptReason.NetworkFailed:
            case CoreWebView2DownloadInterruptReason.NetworkTimeout:
            case CoreWebView2DownloadInterruptReason.NetworkDisconnected:
            case CoreWebView2DownloadInterruptReason.NetworkServerDown: return "下载连接中断，请重新导出。";
            default: return "下载已中断（" + reason + "）。";
        }
    }

    private void ShowFailure(string title, Exception error)
    {
        Log(title + ": " + error);
        if (closing || IsDisposed || failed) return;
        failed = true;
        status.Text = title + "\r\n\r\n" + error.Message + "\r\n\r\n请关闭窗口后重试。诊断记录：\r\n" + Path.Combine(options.DataDir, "desktop.log");
        status.Visible = true;
        status.BringToFront();
        browser.Visible = false;
    }

    private void OnUi(Action action)
    {
        if (IsDisposed || Disposing || !IsHandleCreated) return;
        try { BeginInvoke(action); } catch (InvalidOperationException) { }
    }

    private void Log(string message)
    {
        try
        {
            lock (logLock)
            {
                Directory.CreateDirectory(options.DataDir);
                File.AppendAllText(Path.Combine(options.DataDir, "desktop.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + message + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch { }
    }

    protected override async void OnFormClosing(FormClosingEventArgs args)
    {
        if (closeAllowed) { base.OnFormClosing(args); return; }
        args.Cancel = true;
        base.OnFormClosing(args);
        if (closing) return;
        closing = true;
        foreach (Form popup in new List<Form>(popupWindows))
            if (!popup.IsDisposed) popup.Close();
        status.Text = "正在关闭财务代账系统并保存本机数据…";
        status.Visible = true;
        status.BringToFront();
        await StopBackendAsync();
        browser.Dispose();
        closeAllowed = true;
        Close();
    }

    private async Task StopBackendAsync()
    {
        Process process = backend;
        if (process == null) return;
        try
        {
            if (process.HasExited) return;
            try
            {
                process.StandardInput.WriteLine("shutdown");
                process.StandardInput.Flush();
                process.StandardInput.Close();
            }
            catch (Exception error) { Log("Graceful shutdown request: " + error.Message); }
            bool stopped = await Task.Run(delegate { return process.WaitForExit(5000); });
            if (!stopped)
            {
                Log("Backend shutdown timed out; terminating owned PID=" + process.Id);
                process.Kill();
                await Task.Run(delegate { process.WaitForExit(1000); });
            }
        }
        catch (InvalidOperationException) { }
        catch (Exception error) { Log("Backend shutdown failed: " + error); }
    }
}
