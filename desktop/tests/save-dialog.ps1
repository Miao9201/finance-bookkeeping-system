param([int]$TaskProcessId,[string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$taskRoot=[System.Windows.Automation.AutomationElement]::RootElement
$taskConditions=New-Object System.Windows.Automation.AndCondition((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'保存导出文件')),(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$TaskProcessId)))
$taskDialog=$null
for($taskAttempt=0;$taskAttempt -lt 80;$taskAttempt++) { $taskDialog=$taskRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$taskConditions);if($taskDialog){break};Start-Sleep -Milliseconds 100 }
if(!$taskDialog){throw 'Native Save As dialog not found'}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SaveDialogControl {
    private delegate bool EnumChildProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)] private static extern IntPtr SendText(IntPtr window, uint message, IntPtr wParam, string text);
    [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)] private static extern IntPtr ReadText(IntPtr window, uint message, IntPtr wParam, StringBuilder text);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    private static string ClassName(IntPtr window) {
        StringBuilder text=new StringBuilder(256);
        GetClassName(window,text,text.Capacity);
        return text.ToString();
    }
    public static void SaveFile(IntPtr dialog, int expectedProcessId, string path) {
        uint processId;
        GetWindowThreadProcessId(dialog,out processId);
        if(processId!=(uint)expectedProcessId || ClassName(dialog)!="#32770") throw new Exception("Save dialog identity changed");
        List<IntPtr> controls=new List<IntPtr>();
        EnumChildWindows(dialog,delegate(IntPtr control,IntPtr ignored){controls.Add(control);return true;},IntPtr.Zero);
        IntPtr edit=IntPtr.Zero,save=IntPtr.Zero;
        StringBuilder description=new StringBuilder();
        foreach(IntPtr control in controls) {
            string name=ClassName(control);int id=GetDlgCtrlID(control);
            description.Append(name+":"+id+" ");
            if(name=="Button" && id==1) save=control;
            if(name!="Edit") continue;
            for(IntPtr ancestor=control;ancestor!=IntPtr.Zero && ancestor!=dialog;ancestor=GetParent(ancestor))
                if(GetDlgCtrlID(ancestor)==1001) { edit=control;break; }
        }
        if(edit==IntPtr.Zero || save==IntPtr.Zero) throw new Exception("Native filename or Save control not found: "+description);
        SendText(edit,0x000C,IntPtr.Zero,path);
        StringBuilder actual=new StringBuilder(path.Length+32);
        ReadText(edit,0x000D,(IntPtr)actual.Capacity,actual);
        if(actual.ToString()!=path) throw new Exception("Native filename field did not accept the selected path");
        if(!PostMessage(save,0x00F5,IntPtr.Zero,IntPtr.Zero)) throw new Exception("Native Save button could not be invoked");
    }
}
'@
$taskHandle=[IntPtr]$taskDialog.Current.NativeWindowHandle
[SaveDialogControl]::SaveFile($taskHandle,$TaskProcessId,$OutputPath)
Write-Output 'NATIVE_SAVE_DIALOG_INVOKED'
