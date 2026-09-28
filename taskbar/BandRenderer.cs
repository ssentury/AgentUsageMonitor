using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.Linq;

namespace AgentUsageTaskbar
{
    // Draws the two-line summary into a per-pixel-alpha bitmap. Text uses grayscale
    // antialiasing because ClearType cannot blend onto a transparent background.
    internal sealed class BandRenderer : IDisposable
    {
        private static readonly Color ClaudeColor = Color.FromArgb(217, 119, 87);
        private static readonly Color CodexColor = Color.FromArgb(87, 157, 255);
        private static readonly Color ActiveColor = Color.FromArgb(63, 185, 80);
        private static readonly Color WarnColor = Color.FromArgb(228, 163, 58);
        private static readonly Color DangerColor = Color.FromArgb(229, 72, 77);

        private Font _font;
        private Font _boldFont;
        private float _fontScale;

        public Bitmap Render(UsageSnapshot snapshot, bool offline, bool lightTheme, float scale, int height)
        {
            EnsureFonts(scale);
            var foreground = lightTheme ? Color.FromArgb(28, 28, 28) : Color.FromArgb(245, 245, 245);
            var muted = lightTheme ? Color.FromArgb(110, 110, 110) : Color.FromArgb(170, 170, 170);
            var rows = BuildRows(snapshot, offline, foreground, muted);

            using (var measure = new Bitmap(1, 1))
            using (var graphics = Graphics.FromImage(measure))
            {
                graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                // Columns align across rows so the numbers stay put while values change.
                var columnCount = rows.Max(row => row.Count);
                var widths = new float[columnCount];
                foreach (var row in rows)
                {
                    for (var index = 0; index < row.Count; index++)
                    {
                        widths[index] = Math.Max(widths[index], Measure(graphics, row[index]));
                    }
                }
                var gap = 8f * scale;
                var padding = 6f * scale;
                var width = (int)Math.Ceiling(padding * 2 + widths.Sum() + gap * Math.Max(0, columnCount - 1));

                var bitmap = new Bitmap(Math.Max(width, 1), Math.Max(height, 1), PixelFormat.Format32bppArgb);
                using (var canvas = Graphics.FromImage(bitmap))
                {
                    // Alpha 1 keeps the whole band hit-testable without being visible.
                    canvas.Clear(Color.FromArgb(1, 0, 0, 0));
                    canvas.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    canvas.SmoothingMode = SmoothingMode.AntiAlias;
                    var lineHeight = _font.GetHeight(canvas);
                    var top = (height - lineHeight * rows.Count) / 2f;
                    for (var rowIndex = 0; rowIndex < rows.Count; rowIndex++)
                    {
                        var x = padding;
                        var y = top + rowIndex * lineHeight;
                        for (var index = 0; index < rows[rowIndex].Count; index++)
                        {
                            var cell = rows[rowIndex][index];
                            using (var brush = new SolidBrush(cell.Color))
                            {
                                canvas.DrawString(cell.Text, cell.Bold ? _boldFont : _font, brush, x, y, StringFormat.GenericTypographic);
                            }
                            x += widths[index] + gap;
                        }
                    }
                }
                return bitmap;
            }
        }

        private List<List<Cell>> BuildRows(UsageSnapshot snapshot, bool offline, Color foreground, Color muted)
        {
            var rows = new List<List<Cell>>();
            if (offline || snapshot == null)
            {
                rows.Add(new List<Cell> { new Cell("Agent Usage", muted, true), new Cell("서비스 꺼짐", muted) });
                return rows;
            }
            foreach (var provider in snapshot.Providers.Where(item => item.HasUsage))
            {
                var row = new List<Cell>
                {
                    new Cell("●", provider.Active ? ActiveColor : muted),
                    new Cell(provider.Label, provider.Id == "claude" ? ClaudeColor : provider.Id == "codex" ? CodexColor : foreground, true),
                    new Cell(Money(provider.UsdPer30s) + "/30s", provider.Active ? foreground : muted),
                    new Cell("오늘 " + Money(provider.TodayUsd) + (provider.Unpriced ? "+" : ""), foreground),
                };
                if (provider.LimitStatus == "needs-cli")
                {
                    row.Add(new Cell("CLI 로그인 필요", WarnColor));
                }
                else
                {
                    // Only the main windows fit; model-specific windows stay in the popup.
                    foreach (var limit in provider.Limits.Where(item => item.Window == "5h" || item.Window == "7d"))
                    {
                        var color = limit.Stale ? muted
                            : limit.UsedPercent >= 80 ? DangerColor
                            : limit.UsedPercent >= 60 ? WarnColor
                            : foreground;
                        row.Add(new Cell(limit.Window + " " + Math.Round(limit.UsedPercent).ToString(CultureInfo.InvariantCulture) + "%", color));
                    }
                }
                rows.Add(row);
            }
            if (rows.Count == 0) rows.Add(new List<Cell> { new Cell("Agent Usage", muted, true), new Cell("사용 기록 없음", muted) });
            return rows;
        }

        public static string Money(double usd)
        {
            if (usd >= 100) return "$" + Math.Round(usd).ToString(CultureInfo.InvariantCulture);
            return "$" + usd.ToString("0.00", CultureInfo.InvariantCulture);
        }

        private float Measure(Graphics graphics, Cell cell)
        {
            return graphics.MeasureString(cell.Text, cell.Bold ? _boldFont : _font, PointF.Empty, StringFormat.GenericTypographic).Width;
        }

        private void EnsureFonts(float scale)
        {
            if (_font != null && Math.Abs(_fontScale - scale) < 0.01f) return;
            _font?.Dispose();
            _boldFont?.Dispose();
            _font = new Font("Segoe UI", 12f * scale, FontStyle.Regular, GraphicsUnit.Pixel);
            _boldFont = new Font("Segoe UI Semibold", 12f * scale, FontStyle.Regular, GraphicsUnit.Pixel);
            _fontScale = scale;
        }

        public void Dispose()
        {
            _font?.Dispose();
            _boldFont?.Dispose();
        }

        private struct Cell
        {
            public readonly string Text;
            public readonly Color Color;
            public readonly bool Bold;

            public Cell(string text, Color color, bool bold = false)
            {
                Text = text;
                Color = color;
                Bold = bold;
            }
        }
    }
}
