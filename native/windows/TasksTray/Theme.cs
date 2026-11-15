using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace TasksTray;

/// <summary>The web app's look: dark surfaces, pill buttons in solid colors, outlined chips in the level colors</summary>
internal static class Theme
{
    public static readonly Color Surface = Color.FromArgb(0x33, 0x33, 0x33);
    public static readonly Color Page = Color.FromArgb(0x2A, 0x2A, 0x2A);
    public static readonly Color Secondary = Color.FromArgb(0xAA, 0xAA, 0xAA);
    /// <summary>The address bar chips' palette, also the check-in steps' in the web app</summary>
    public static readonly Color[] Levels =
        [Color.FromArgb(0xFF, 0x22, 0x22), Color.OrangeRed, Color.Orange, Color.Teal, Color.RoyalBlue, Color.FromArgb(0xCC, 0x44, 0xFF), Color.DeepPink];
    public static readonly Color Play = Color.ForestGreen;
    public static readonly Color Done = Color.DarkGreen;
    public static readonly Color Pause = Color.Orange;
    public static readonly Color Primary = Color.FromArgb(0x8B, 0x65, 0xFD);
    public static readonly Color Neutral = Color.FromArgb(0x55, 0x55, 0x55);

    public static GraphicsPath Capsule(RectangleF bounds)
    {
        var path = new GraphicsPath();
        var diameter = Math.Min(bounds.Height, bounds.Width);
        path.AddArc(bounds.X, bounds.Y, diameter, diameter, 90, 180);
        path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 180);
        path.CloseFigure();
        return path;
    }
}

/// <summary>
/// <c>.button</c>: a solid pill with an uppercase label, lighter on hover and while pressed. With
/// <see cref="Outlined"/>, <c>.sub-folder</c>: an outlined chip in its color, filled on hover.
/// </summary>
internal sealed class PillButton : Control
{
    private bool hovering;
    private bool pressed;

    public Color Color { get; init; } = Theme.Primary;
    public bool Outlined { get; init; }
    /// <summary>A Segoe MDL2 Assets glyph drawn before the label</summary>
    public string? Icon { get; init; }

    public PillButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint
                 | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
        Cursor = Cursors.Hand;
        Font = new Font("Segoe UI Semibold", 9.5f);
        Height = 32;
    }

    protected override void OnMouseEnter(EventArgs e) { hovering = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hovering = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }

    /// <summary>Wide enough for the label and the icon</summary>
    public PillButton Fit(int minimum = 0)
    {
        var text = TextRenderer.MeasureText(Label, Font).Width + (Icon == null ? 0 : 22);
        Width = Math.Max(minimum, text + (Outlined ? 24 : 36));
        return this;
    }

    private string Label => Outlined ? Text : Text.ToUpperInvariant();

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.Clear(Parent?.BackColor ?? Theme.Surface);
        var bounds = new RectangleF(1, 1, Width - 2, Height - 2);
        using var path = Theme.Capsule(bounds);
        var filled = !Outlined || hovering || pressed;
        if (filled)
        {
            using var fill = new SolidBrush(Color);
            graphics.FillPath(fill, path);
        }
        if (Outlined)
        {
            using var pen = new Pen(Color, 2);
            graphics.DrawPath(pen, path);
        }
        else if (hovering || pressed)
        {
            using var overlay = new SolidBrush(Color.FromArgb(pressed ? 77 : 38, Color.White));
            graphics.FillPath(overlay, path);
        }
        var foreground = Outlined ? (filled ? Theme.Page : Color) : Color.White;
        var label = Label;
        var labelSize = TextRenderer.MeasureText(graphics, label, Font);
        var iconWidth = Icon == null ? 0 : 22;
        var x = (Width - labelSize.Width - iconWidth) / 2;
        if (Icon != null)
        {
            using var iconFont = new Font("Segoe MDL2 Assets", 9f);
            TextRenderer.DrawText(graphics, Icon, iconFont, new Rectangle(x, 0, iconWidth, Height), foreground,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding);
        }
        TextRenderer.DrawText(graphics, label, Font, new Rectangle(x + iconWidth, 0, labelSize.Width, Height), foreground,
            TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
    }
}

/// <summary>
/// A floating window without a title bar: rounded corners, a shadow, a close button in the corner, and
/// the whole background drags it. Laid out at 96 dpi and scaled to the screen's.
/// </summary>
internal class FloatingForm : Form
{
    protected FloatingForm(int width, int height)
    {
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        ShowInTaskbar = true;
        DoubleBuffered = true;
        ClientSize = new Size(width, height);
        BackColor = Theme.Surface;
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10);
        var close = new CloseButton { Location = new Point(width - 36, 8) };
        close.Click += (_, _) => Close();
        Controls.Add(close);
        Draggable(this);
    }

    /// <summary>Bottom right, next to the clock and the tray, on the screen with the mouse</summary>
    protected void PlaceByTray()
    {
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(area.Right - Width - 16, area.Bottom - Height - 16);
    }

    protected Label AddText(string text, int x, int y, int width, Color? color = null, Font? font = null)
    {
        var label = new Label
        {
            Text = text, Location = new Point(x, y), MaximumSize = new Size(width, 0), AutoSize = true,
            ForeColor = color ?? Color.White, Font = font ?? Font, BackColor = Color.Transparent,
        };
        Draggable(label);
        Controls.Add(label);
        return label;
    }

    private void Draggable(Control control)
    {
        control.MouseDown += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            Native.ReleaseCapture();
            Native.SendMessage(Handle, 0xA1 /* WM_NCLBUTTONDOWN */, 2 /* HTCAPTION */, 0);
        };
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.ClassStyle |= 0x20000; // CS_DROPSHADOW
            return parameters;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.RoundCorners(this);
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        if (!Native.HasRoundedWindows && Width > 0 && Height > 0)
        {
            // Windows 10 draws no rounded corners itself
            using var path = new GraphicsPath();
            const int radius = 16;
            path.AddArc(0, 0, radius, radius, 180, 90);
            path.AddArc(Width - radius, 0, radius, radius, 270, 90);
            path.AddArc(Width - radius, Height - radius, radius, radius, 0, 90);
            path.AddArc(0, Height - radius, radius, radius, 90, 90);
            path.CloseFigure();
            Region = new Region(path);
        }
    }

    private sealed class CloseButton : Control
    {
        private bool hovering;

        public CloseButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            Size = new Size(28, 28);
            Cursor = Cursors.Hand;
        }

        protected override void OnMouseEnter(EventArgs e) { hovering = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hovering = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Parent?.BackColor ?? Theme.Surface);
            if (hovering)
            {
                using var circle = new SolidBrush(Color.FromArgb(0x55, 0x55, 0x55));
                e.Graphics.FillEllipse(circle, 0, 0, Width - 1, Height - 1);
            }
            using var font = new Font("Segoe MDL2 Assets", 8f);
            TextRenderer.DrawText(e.Graphics, "\uE8BB", font, ClientRectangle, hovering ? Color.White : Theme.Secondary,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
    }
}

internal static class Native
{
    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr window, int message, int wParam, int lParam);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo
    {
        public uint Size;
        public uint Time;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LastInputInfo info);

    /// <summary>How long since the last keyboard or mouse input</summary>
    public static TimeSpan IdleTime
    {
        get
        {
            var info = new LastInputInfo { Size = (uint)Marshal.SizeOf<LastInputInfo>() };
            if (!GetLastInputInfo(ref info)) return TimeSpan.MaxValue;
            return TimeSpan.FromMilliseconds((uint)Environment.TickCount - info.Time);
        }
    }

    /// <summary>Windows 11 rounds windows that ask for it</summary>
    public static bool HasRoundedWindows => Environment.OSVersion.Version.Build >= 22000;

    public static void RoundCorners(Form form)
    {
        if (!HasRoundedWindows) return;
        var preference = 2; // DWMWCP_ROUND
        DwmSetWindowAttribute(form.Handle, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, ref preference, sizeof(int));
    }
}
