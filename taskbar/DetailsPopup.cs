using System;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Windows.Forms;

namespace AgentUsageTaskbar
{
    // Hover card above the taskbar with reset times and status explanations.
    internal sealed class DetailsPopup : Form
    {
        private readonly Label _label;

        public DetailsPopup()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(12, 10, 12, 10);
            _label = new Label { AutoSize = true, Font = new Font("Segoe UI", 9f), MaximumSize = new Size(460, 0) };
            Controls.Add(_label);
        }

        protected override bool ShowWithoutActivation => true;

        protected override CreateParams CreateParams
        {
            get
            {
                var parameters = base.CreateParams;
                parameters.ExStyle |= Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOPMOST;
                return parameters;
            }
        }

        public void ShowAbove(Rectangle anchor, UsageSnapshot snapshot, bool offline, bool lightTheme)
        {
            BackColor = lightTheme ? Color.FromArgb(249, 249, 249) : Color.FromArgb(32, 32, 32);
            _label.ForeColor = lightTheme ? Color.FromArgb(28, 28, 28) : Color.FromArgb(240, 240, 240);
            _label.Text = Describe(snapshot, offline);
            PerformLayout();
            var screen = Screen.FromRectangle(anchor).Bounds;
            var x = Math.Max(screen.Left + 4, Math.Min(anchor.Left, screen.Right - Width - 4));
            Location = new Point(x, anchor.Top - Height - 8);
            if (!Visible) Show();
        }

        private static string Describe(UsageSnapshot snapshot, bool offline)
        {
            if (offline || snapshot == null)
            {
                return "Agent Usage Monitor 서비스에 연결할 수 없습니다.\n우클릭 → '서비스 시작'으로 다시 켤 수 있습니다.";
            }
            var text = new StringBuilder();
            foreach (var provider in snapshot.Providers.Where(item => item.HasUsage))
            {
                if (text.Length > 0) text.AppendLine();
                text.AppendLine(provider.Label + (provider.Active ? "  · 사용 중" : "  · 대기"));
                text.AppendLine("  최근 30초 " + BandRenderer.Money(provider.UsdPer30s) + " · 오늘 " + BandRenderer.Money(provider.TodayUsd)
                    + (provider.Unpriced ? " (가격 미설정 모델 있음)" : "") + " · API 환산");
                foreach (var limit in provider.Limits)
                {
                    var reset = limit.ResetsAt.HasValue ? " · " + limit.ResetsAt.Value.ToString("M/d HH:mm", CultureInfo.InvariantCulture) + " 초기화" : "";
                    text.AppendLine("  " + limit.Window + " " + Math.Round(limit.UsedPercent, 1).ToString(CultureInfo.InvariantCulture) + "%" + reset
                        + (limit.Stale ? " (마지막 값)" : ""));
                }
                if (provider.LimitStatus == "needs-cli")
                {
                    text.AppendLine("  ⚠ 사용량 %를 읽을 CLI 로그인이 만료되었습니다.");
                    text.AppendLine("     터미널에서 'claude'를 한 번 실행하면 자동으로 복구됩니다.");
                }
                else if (provider.LimitStatus == "error")
                {
                    text.AppendLine("  ⚠ 사용량 % 조회에 실패했습니다. 잠시 후 다시 시도합니다.");
                }
                else if (provider.Limits.Count == 0)
                {
                    text.AppendLine("  사용량 %가 아직 보고되지 않았습니다.");
                }
            }
            if (text.Length == 0) text.AppendLine("최근 30일간 사용 기록이 없습니다.");
            text.AppendLine();
            text.Append("클릭: 대시보드 · 우클릭: 메뉴");
            return text.ToString();
        }
    }
}
