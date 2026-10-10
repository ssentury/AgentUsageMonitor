using System;
using System.Drawing;

namespace AgentUsageTaskbar
{
    internal static class BandLayout
    {
        public static Rectangle VisibleBounds(Rectangle taskbar, Rectangle workArea)
        {
            // A compact Windows 11 taskbar can reserve a taller HWND than its visible strip.
            // Maximized windows cover that transparent margin above the work-area boundary.
            var top = workArea.Bottom > taskbar.Top && workArea.Bottom < taskbar.Bottom
                ? workArea.Bottom - taskbar.Top
                : 0;
            return new Rectangle(0, top, taskbar.Width, Math.Max(1, taskbar.Height - top));
        }
    }
}
