using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TasksTray;

/// <summary>
/// The web app in a small window by the tray, hidden when it loses the focus like a flyout. It is logged
/// in with this machine's tool session (the cookie the API calls send), so it needs no browser login.
/// </summary>
internal sealed class WebForm : Form
{
    private readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Theme.Page };
    private Uri? home;
    private string? loadedToken;
    private bool ready;

    /// <summary>The page landed on the login service: the tool login takes over</summary>
    public event Action? NeedsLogin;

    public WebForm()
    {
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = "Tasks";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Theme.Page;
        ClientSize = new Size(440, 680);
        Controls.Add(web);
        Deactivate += (_, _) => Hide();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.RoundCorners(this);
    }

    /// <summary>Shows the web app by the tray; false when WebView2 is missing (the caller opens the browser)</summary>
    public async Task<bool> Open(Uri url)
    {
        try
        {
            if (!ready)
            {
                var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TasksTray", "WebView2");
                var environment = await CoreWebView2Environment.CreateAsync(null, folder);
                await web.EnsureCoreWebView2Async(environment);
                web.CoreWebView2.NavigationStarting += OnNavigationStarting;
                web.CoreWebView2.NewWindowRequested += (_, e) =>
                {
                    e.Handled = true;
                    OpenInBrowser(e.Uri);
                };
                ready = true;
            }
        }
        catch (Exception error) when (error is WebView2RuntimeNotFoundException or COMException or InvalidOperationException)
        {
            return false;
        }
        var session = Session.Load();
        if (home != url || loadedToken != session?.Token || web.Source == null)
        {
            home = url;
            loadedToken = session?.Token;
            SetCookie(session, url);
            web.CoreWebView2.Navigate(url.ToString());
        }
        PlaceByTray();
        Show();
        Activate();
        web.Focus();
        return true;
    }

    /// <summary>Replaces whatever session cookie the page had with this machine's current one</summary>
    private void SetCookie(Session? session, Uri url)
    {
        var cookies = web.CoreWebView2.CookieManager;
        if (session == null)
        {
            cookies.DeleteAllCookies();
            return;
        }
        cookies.DeleteCookiesWithDomainAndPath(session.CookieName, url.Host, "/");
        var cookie = cookies.CreateCookie(session.CookieName, session.Token, url.Host, "/");
        cookie.IsSecure = url.Scheme == Uri.UriSchemeHttps;
        cookie.IsHttpOnly = true;
        if (DateTime.TryParse(session.ExpiresAt, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var expires))
            cookie.Expires = expires;
        cookies.AddOrUpdateCookie(cookie);
    }

    /// <summary>The web app stays in here; the login service and other sites go elsewhere</summary>
    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (home == null || !Uri.TryCreate(e.Uri, UriKind.Absolute, out var target)) return;
        if (target.Host == home.Host || target.Scheme == "about") return;
        e.Cancel = true;
        if (e.IsUserInitiated)
        {
            OpenInBrowser(e.Uri);
        }
        else
        {
            // Redirected away: not logged in, or this login may not use the web app
            loadedToken = null;
            Hide();
            NeedsLogin?.Invoke();
        }
    }

    private static void OpenInBrowser(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });

    /// <summary>Next to the tray: the corner of the working area on the taskbar's side</summary>
    private void PlaceByTray()
    {
        var screen = Screen.FromPoint(Cursor.Position);
        var area = screen.WorkingArea;
        var bounds = screen.Bounds;
        var x = area.Left > bounds.Left ? area.Left + 12 : area.Right - Width - 12;
        var y = area.Top > bounds.Top ? area.Top + 12 : area.Bottom - Height - 12;
        Location = new Point(x, y);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Kept for the next time: closing only hides it, unless the app quits
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnFormClosing(e);
    }
}
