using System;
using System.Threading;
using System.Windows.Forms;

namespace AgentUsageTaskbar
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            using (var mutex = new Mutex(true, @"Local\AgentUsageMonitorTaskbar", out var created))
            {
                if (!created) return 0;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += (sender, eventArgs) => TaskbarApp.Log(eventArgs.Exception);
                AppDomain.CurrentDomain.UnhandledException += (sender, eventArgs) =>
                {
                    if (eventArgs.ExceptionObject is Exception error) TaskbarApp.Log(error);
                };
                using (var app = new TaskbarApp(Options.Parse(args)))
                {
                    Application.Run(app);
                }
                return 0;
            }
        }
    }
}
