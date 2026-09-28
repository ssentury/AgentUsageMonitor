using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace AgentUsageTaskbar
{
    // A layered child window hosted inside the Windows taskbar (Shell_TrayWnd).
    // Being part of the taskbar, it can never be covered by the taskbar itself.
    internal sealed class BandWindow : NativeWindow, IDisposable
    {
        private bool _tracking;

        public event EventHandler MouseEntered;
        public event EventHandler MouseLeft;
        public event EventHandler LeftClicked;
        public event EventHandler RightClicked;

        public IntPtr Host { get; }

        public BandWindow(IntPtr host)
        {
            Host = host;
            CreateHandle(new CreateParams
            {
                Caption = "AgentUsageTaskbar",
                Parent = host,
                Style = Native.WS_CHILD | Native.WS_VISIBLE | Native.WS_CLIPSIBLINGS,
                ExStyle = Native.WS_EX_LAYERED | Native.WS_EX_NOACTIVATE,
                Width = 1,
                Height = 1,
            });
        }

        public bool IsAlive => Handle != IntPtr.Zero && Native.IsWindow(Handle) && Native.GetParent(Handle) == Host;

        public void Place(Rectangle bounds)
        {
            // HWND_TOP keeps the band above the taskbar's own XAML content.
            Native.SetWindowPos(Handle, Native.HWND_TOP, bounds.X, bounds.Y, bounds.Width, bounds.Height,
                Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
        }

        public void Present(Bitmap bitmap)
        {
            var screen = Native.GetDC(IntPtr.Zero);
            var memory = Native.CreateCompatibleDC(screen);
            var hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
            var previous = Native.SelectObject(memory, hBitmap);
            try
            {
                var size = new Native.SIZE(bitmap.Width, bitmap.Height);
                var source = new Native.POINT(0, 0);
                var blend = new Native.BLENDFUNCTION
                {
                    BlendOp = Native.AC_SRC_OVER,
                    SourceConstantAlpha = 255,
                    AlphaFormat = Native.AC_SRC_ALPHA,
                };
                if (!Native.UpdateLayeredWindow(Handle, screen, IntPtr.Zero, ref size, memory, ref source, 0, ref blend, Native.ULW_ALPHA))
                {
                    throw new InvalidOperationException("UpdateLayeredWindow failed: " + Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                Native.SelectObject(memory, previous);
                Native.DeleteObject(hBitmap);
                Native.DeleteDC(memory);
                Native.ReleaseDC(IntPtr.Zero, screen);
            }
        }

        protected override void WndProc(ref Message message)
        {
            switch (message.Msg)
            {
                case Native.WM_MOUSEACTIVATE:
                    message.Result = (IntPtr)Native.MA_NOACTIVATE;
                    return;
                case Native.WM_MOUSEMOVE:
                    if (!_tracking)
                    {
                        var track = new Native.TRACKMOUSEEVENT
                        {
                            cbSize = Marshal.SizeOf(typeof(Native.TRACKMOUSEEVENT)),
                            dwFlags = Native.TME_LEAVE,
                            hwndTrack = Handle,
                        };
                        _tracking = Native.TrackMouseEvent(ref track);
                        MouseEntered?.Invoke(this, EventArgs.Empty);
                    }
                    break;
                case Native.WM_MOUSELEAVE:
                    _tracking = false;
                    MouseLeft?.Invoke(this, EventArgs.Empty);
                    break;
                case Native.WM_LBUTTONUP:
                    LeftClicked?.Invoke(this, EventArgs.Empty);
                    break;
                case Native.WM_RBUTTONUP:
                    RightClicked?.Invoke(this, EventArgs.Empty);
                    return;
            }
            base.WndProc(ref message);
        }

        public void Dispose()
        {
            if (Handle != IntPtr.Zero) DestroyHandle();
        }
    }
}
