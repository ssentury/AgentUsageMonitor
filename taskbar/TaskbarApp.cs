using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AgentUsageTaskbar
{
    internal sealed class TaskbarApp : ApplicationContext
    {
        private const int OfflineAfterFailures = 5;

        private readonly Options _options;
        private readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1500) };
        private readonly Timer _refreshTimer = new Timer { Interval = 1000 };
        private readonly Timer _layoutTimer = new Timer { Interval = 2000 };
        private readonly Timer _hoverTimer = new Timer { Interval = 350 };
        private readonly BandRenderer _renderer = new BandRenderer();
        private readonly DetailsPopup _popup = new DetailsPopup();
        private readonly Form _menuOwner = new Form { ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None, Size = new Size(1, 1), Opacity = 0 };
        private readonly ContextMenuStrip _menu = new ContextMenuStrip();

        private BandWindow _band;
        private UsageSnapshot _snapshot;
        private int _failures = OfflineAfterFailures;
        private bool _refreshing;
        private bool _hovering;
        private bool _lightTheme;
        private Rectangle _bandScreenBounds;
        private Size _lastBitmapSize;

        public TaskbarApp(Options options)
        {
            _options = options;
            _menu.Items.Add("대시보드 열기", null, (s, e) => OpenUrl("/"));
            _menu.Items.Add("모델 가격", null, (s, e) => OpenUrl("/prices.html"));
            _menu.Items.Add("다시 스캔", null, async (s, e) => await PostAsync("/api/rescan"));
            _menu.Items.Add("서비스 시작", null, (s, e) => StartService());
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add("작업 표시줄 표시 종료", null, (s, e) => ExitThread());

            _refreshTimer.Tick += async (s, e) => await RefreshAsync();
            _layoutTimer.Tick += (s, e) => Guard(EnsureBand);
            _hoverTimer.Tick += (s, e) => Guard(ShowPopup);
            Guard(EnsureBand);
            _refreshTimer.Start();
            _layoutTimer.Start();
            _ = RefreshAsync();
        }

        #region Data

        private async Task RefreshAsync()
        {
            if (_refreshing) return;
            _refreshing = true;
            try
            {
                var json = await _http.GetStringAsync(_options.BaseUrl + "/api/taskbar");
                _snapshot = UsageSnapshot.Parse(json);
                _failures = 0;
            }
            catch (Exception error) when (error is HttpRequestException || error is TaskCanceledException || error is ArgumentException || error is InvalidOperationException)
            {
                // The service may be restarting; keep the last values briefly before showing offline.
                _failures++;
            }
            catch (Exception error)
            {
                _failures++;
                Log(error);
            }
            finally
            {
                _refreshing = false;
            }
            Guard(Redraw);
        }

        private bool Offline => _failures >= OfflineAfterFailures;

        private async Task PostAsync(string path)
        {
            try
            {
                using (var response = await _http.PostAsync(_options.BaseUrl + path, new StringContent("")))
                {
                    response.EnsureSuccessStatusCode();
                }
            }
            catch (Exception error)
            {
                Log(error);
            }
        }

        #endregion

        #region Taskbar hosting

        private void EnsureBand()
        {
            var taskbar = Native.FindWindow("Shell_TrayWnd", null);
            if (taskbar == IntPtr.Zero)
            {
                // Explorer is restarting; the old band died with the old taskbar.
                DisposeBand();
                return;
            }
            if (_band == null || _band.Host != taskbar || !_band.IsAlive)
            {
                DisposeBand();
                _band = new BandWindow(taskbar);
                _band.MouseEntered += (s, e) => { _hovering = true; _hoverTimer.Start(); };
                _band.MouseLeft += (s, e) => { _hovering = false; _hoverTimer.Stop(); _popup.Hide(); };
                _band.LeftClicked += (s, e) => OpenUrl("/");
                _band.RightClicked += (s, e) => ShowMenu();
                _lastBitmapSize = Size.Empty;
            }
            _lightTheme = ReadLightTheme();
            Redraw();
        }

        private void Redraw()
        {
            if (_band == null || !_band.IsAlive) return;
            var taskbar = _band.Host;
            if (!Native.GetClientRect(taskbar, out var client) || !Native.GetWindowRect(taskbar, out var window)) return;
            var scale = Native.GetDpiForWindow(taskbar) / 96f;
            if (scale <= 0) scale = 1;

            using (var bitmap = _renderer.Render(_snapshot, Offline, _lightTheme, scale, client.Height))
            {
                var x = ComputeLeft(taskbar, client, window, bitmap.Width, scale);
                var bounds = new Rectangle(x, 0, bitmap.Width, client.Height);
                _band.Place(bounds);
                _band.Present(bitmap);
                _lastBitmapSize = bitmap.Size;
                _bandScreenBounds = new Rectangle(window.Left + x, window.Top, bitmap.Width, client.Height);
            }
            if (_hovering && _popup.Visible) ShowPopup();
        }

        private int ComputeLeft(IntPtr taskbar, Native.RECT client, Native.RECT window, int width, float scale)
        {
            if (_options.Settings.OffsetX.HasValue) return (int)(_options.Settings.OffsetX.Value * scale);
            var advanced = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced");
            using (advanced)
            {
                var centered = advanced == null || !(advanced.GetValue("TaskbarAl") is int alignment) || alignment != 0;
                if (centered)
                {
                    // Centered icons leave the left edge free, except for the Widgets button.
                    var widgets = advanced != null && advanced.GetValue("TaskbarDa") is int da && da != 0;
                    return (int)((widgets ? 200 : 8) * scale);
                }
            }
            // Left-aligned icons: sit just left of the notification area.
            var tray = Native.FindWindowEx(taskbar, IntPtr.Zero, "TrayNotifyWnd", null);
            if (tray != IntPtr.Zero && Native.GetWindowRect(tray, out var trayRect) && trayRect.Width > 0)
            {
                return Math.Max(0, trayRect.Left - window.Left - width - (int)(8 * scale));
            }
            return Math.Max(0, client.Width - width - (int)(320 * scale));
        }

        private static bool ReadLightTheme()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            {
                return key != null && key.GetValue("SystemUsesLightTheme") is int light && light != 0;
            }
        }

        private void DisposeBand()
        {
            _popup.Hide();
            _band?.Dispose();
            _band = null;
        }

        #endregion

        #region Interaction

        private void ShowPopup()
        {
            _hoverTimer.Stop();
            if (!_hovering || _band == null) return;
            _popup.ShowAbove(_bandScreenBounds, _snapshot, Offline, _lightTheme);
        }

        private void ShowMenu()
        {
            _popup.Hide();
            // The menu needs a foreground owner or it will not close when clicking elsewhere.
            if (!_menuOwner.IsHandleCreated) _menuOwner.Show();
            Native.SetForegroundWindow(_menuOwner.Handle);
            _menu.Show(Cursor.Position);
        }

        private void OpenUrl(string path)
        {
            try
            {
                Process.Start(new ProcessStartInfo(_options.BaseUrl + path) { UseShellExecute = true });
            }
            catch (Exception error)
            {
                Log(error);
            }
        }

        private void StartService()
        {
            if (string.IsNullOrEmpty(_options.Root)) return;
            try
            {
                var script = Path.Combine(_options.Root, "scripts", "Ensure-Monitor.ps1");
                Process.Start(new ProcessStartInfo("powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\" -NoTaskbar")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
            }
            catch (Exception error)
            {
                Log(error);
            }
        }

        #endregion

        private void Guard(Action action)
        {
            try { action(); }
            catch (Exception error) { Log(error); }
        }

        public static void Log(Exception error)
        {
            try
            {
                var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentUsageMonitor");
                Directory.CreateDirectory(directory);
                File.AppendAllText(Path.Combine(directory, "taskbar-error.log"), DateTime.Now.ToString("s") + " " + error + Environment.NewLine);
            }
            catch (IOException)
            {
                // Logging must never take the indicator down.
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _refreshTimer.Dispose();
                _layoutTimer.Dispose();
                _hoverTimer.Dispose();
                DisposeBand();
                _popup.Dispose();
                _menu.Dispose();
                _menuOwner.Dispose();
                _renderer.Dispose();
                _http.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class TaskbarSettings
    {
        // Logical pixels from the taskbar's left edge; overrides automatic placement.
        public double? OffsetX;

        public static TaskbarSettings Load(string path)
        {
            var settings = new TaskbarSettings();
            try
            {
                if (!File.Exists(path)) return settings;
                if (new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path)) is Dictionary<string, object> values
                    && values.TryGetValue("offsetX", out var offset) && offset != null)
                {
                    settings.OffsetX = Convert.ToDouble(offset);
                }
            }
            catch (Exception error)
            {
                TaskbarApp.Log(error);
            }
            return settings;
        }
    }

    internal sealed class Options
    {
        public string BaseUrl = "http://127.0.0.1:47831";
        public string Root;
        public TaskbarSettings Settings;

        public static Options Parse(string[] args)
        {
            var options = new Options();
            for (var index = 0; index + 1 < args.Length; index++)
            {
                if (args[index] == "--port" && int.TryParse(args[index + 1], out var port)) options.BaseUrl = "http://127.0.0.1:" + port;
                if (args[index] == "--root") options.Root = args[index + 1];
            }
            var stateRoot = Environment.GetEnvironmentVariable("AGENT_USAGE_MONITOR_STATE_ROOT");
            if (string.IsNullOrEmpty(stateRoot))
            {
                stateRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agent-usage-monitor");
            }
            options.Settings = TaskbarSettings.Load(Path.Combine(stateRoot, "taskbar.json"));
            return options;
        }
    }
}
