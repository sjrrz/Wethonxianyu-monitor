using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string ps1 = Path.Combine(dir, "托盘.ps1");
        if (!File.Exists(ps1))
        {
            MessageBox.Show("找不到托盘脚本：\r\n" + ps1 + "\r\n\r\n请确认 闲鱼扫货监控.exe 和 托盘.ps1 在同一个文件夹里。",
                "闲鱼扫货监控", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        string ps = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            @"WindowsPowerShell\v1.0\powershell.exe");
        if (!File.Exists(ps))
        {
            MessageBox.Show("找不到 Windows PowerShell：\r\n" + ps,
                "闲鱼扫货监控", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        try
        {
            ProcessStartInfo si = new ProcessStartInfo();
            si.FileName = ps;
            si.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + ps1 + "\"";
            si.WorkingDirectory = dir;
            si.UseShellExecute = false;
            si.CreateNoWindow = true;
            Process.Start(si);
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动失败：\r\n" + ex.Message,
                "闲鱼扫货监控", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
