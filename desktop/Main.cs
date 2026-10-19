using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("财务代账系统")]
[assembly: AssemblyProduct("财务代账系统")]
[assembly: AssemblyDescription("单人本机代账管理软件")]
[assembly: AssemblyVersion("1.0.1.0")]
[assembly: AssemblyFileVersion("1.0.1.0")]

public sealed class DesktopOptions {
    public string RuntimeDir;
    public string DataDir;
    public int DebugPort;
    public bool TestMode;
}

internal static class DesktopProgram {
    private static string runtime;
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern bool SetDllDirectory(string path);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);

    [STAThread]
    private static int Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string userRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"YundaizhangDesktop");
        DesktopOptions options=new DesktopOptions { DataDir=Path.Combine(userRoot,"data") };
        Mutex mutex=null; bool owns=false;
        try {
            for(int i=0;i<args.Length;i++) {
                if(args[i]=="--data-dir" && i+1<args.Length) options.DataDir=Path.GetFullPath(args[++i]);
                else if(args[i]=="--debug-port" && i+1<args.Length) {
                    options.DebugPort=int.Parse(args[++i]);
                    if(options.DebugPort<1024 || options.DebugPort>65535) throw new ArgumentException("调试端口无效");
                }
                else if(args[i]=="--test-mode") options.TestMode=true;
                else throw new ArgumentException("无法识别的启动参数");
            }
            Directory.CreateDirectory(options.DataDir);
            string identity=Hash(Encoding.UTF8.GetBytes(Path.GetFullPath(options.DataDir).ToLowerInvariant())).Substring(0,20);
            mutex=new Mutex(false,"Local\\YundaizhangDesktop-"+identity);
            try { owns=mutex.WaitOne(0); } catch(AbandonedMutexException) { owns=true; }
            if(!owns) { ActivateExisting(options.DataDir); return 0; }
            string payloadHash;
            using(Stream s=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.sha256"))
            using(StreamReader reader=new StreamReader(s)) payloadHash=reader.ReadToEnd().Trim();
            string cacheRoot=Path.Combine(userRoot,"runtime");
            runtime=Path.Combine(cacheRoot,"1.0.1-"+payloadHash.Substring(0,16));
            if(!IsReady(runtime,payloadHash)) {
                using(Form splash=new Form()) {
                    splash.Text="财务代账系统"; splash.ClientSize=new Size(440,150); splash.StartPosition=FormStartPosition.CenterScreen;
                    splash.FormBorderStyle=FormBorderStyle.FixedDialog; splash.MaximizeBox=false;
                    splash.Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                    splash.Controls.Add(new Label { Dock=DockStyle.Fill,Text="正在准备财务代账系统…\r\n首次启动需要解包运行环境，请稍候。",TextAlign=ContentAlignment.MiddleCenter,Font=new Font("Microsoft YaHei UI",11) });
                    splash.Show(); Application.DoEvents();
                    Extract(cacheRoot,runtime,payloadHash,splash);
                    splash.Close();
                }
            }
            options.RuntimeDir=runtime;
            SetDllDirectory(runtime);
            AppDomain.CurrentDomain.AssemblyResolve+=delegate(object sender,ResolveEventArgs e) {
                string name=new AssemblyName(e.Name).Name;
                if(name!="Microsoft.Web.WebView2.Core" && name!="Microsoft.Web.WebView2.WinForms") return null;
                string path=Path.Combine(runtime,name+".dll");
                return File.Exists(path)?Assembly.LoadFrom(path):null;
            };
            File.WriteAllText(Path.Combine(options.DataDir,"desktop.pid"),Process.GetCurrentProcess().Id.ToString(),Encoding.ASCII);
            RunWindow(options);
            return 0;
        }
        catch(OperationCanceledException) { return 0; }
        catch(Exception error) {
            try { File.AppendAllText(Path.Combine(options.DataDir,"desktop.log"),DateTime.Now.ToString("s")+" "+error+Environment.NewLine,Encoding.UTF8); } catch {}
            MessageBox.Show("财务代账系统未能启动：\r\n"+error.Message+"\r\n\r\n你的本地业务数据不会因此删除。","财务代账系统",MessageBoxButtons.OK,MessageBoxIcon.Error);
            return 1;
        }
        finally { if(owns && mutex!=null)mutex.ReleaseMutex();if(mutex!=null)mutex.Dispose(); }
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunWindow(DesktopOptions options) { Application.Run(new DesktopWindow(options)); }
    private static string Hash(byte[] bytes) { using(SHA256 sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); }
    private static bool IsReady(string dir,string hash) {
        string stamp=Path.Combine(dir,"payload.ready");
        return File.Exists(stamp)&&File.ReadAllText(stamp)==hash&&File.Exists(Path.Combine(dir,"node.exe"))&&File.Exists(Path.Combine(dir,"desktop-server.mjs"))&&File.Exists(Path.Combine(dir,"WebView2Loader.dll"));
    }
    private static void Extract(string cacheRoot,string target,string hash,Form splash) {
        Directory.CreateDirectory(cacheRoot);
        string staging=Path.Combine(cacheRoot,"preparing-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        string prefix=Path.GetFullPath(staging)+Path.DirectorySeparatorChar;
        using(Stream stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
            using(SHA256 sha=SHA256.Create()) {
                string actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
                if(actual!=hash) throw new InvalidDataException("运行包校验失败，请重新复制完整 EXE 文件");
            }
        }
        using(Stream stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        using(ZipArchive zip=new ZipArchive(stream,ZipArchiveMode.Read)) {
            int count=0;
            foreach(ZipArchiveEntry entry in zip.Entries) {
                string destination=Path.GetFullPath(Path.Combine(staging,entry.FullName.Replace('/',Path.DirectorySeparatorChar)));
                if(!destination.StartsWith(prefix,StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("运行包路径无效");
                if(entry.FullName.EndsWith("/")) { Directory.CreateDirectory(destination); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                using(Stream input=entry.Open())using(FileStream output=File.Create(destination))input.CopyTo(output);
                if(++count%30==0) { Application.DoEvents();if(splash.IsDisposed)throw new OperationCanceledException(); }
            }
        }
        File.WriteAllText(Path.Combine(staging,"payload.ready"),hash);
        if(Directory.Exists(target)) target+="-"+Guid.NewGuid().ToString("N");
        Directory.Move(staging,target);runtime=target;
    }
    private static void ActivateExisting(string dataDir) {
        try {
            int pid=int.Parse(File.ReadAllText(Path.Combine(dataDir,"desktop.pid")));
            Process existing=Process.GetProcessById(pid); IntPtr hwnd=existing.MainWindowHandle;
            if(hwnd!=IntPtr.Zero) { ShowWindow(hwnd,9);SetForegroundWindow(hwnd); }
        } catch {}
    }
}
