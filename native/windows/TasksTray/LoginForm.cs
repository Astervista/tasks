using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;

namespace TasksTray;

/// <summary>The login window, opened from the menu when the session is missing or ended</summary>
internal sealed class LoginForm : Form
{
    private readonly Api api;
    private readonly CancellationTokenSource cancel = new();
    private readonly Label code = new() { AutoSize = false, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Consolas", 22, FontStyle.Bold), Location = new Point(16, 288), Size = new Size(328, 44) };
    private readonly Label message = new() { AutoSize = false, TextAlign = ContentAlignment.TopCenter, ForeColor = Color.Silver, Location = new Point(16, 334), Size = new Size(328, 54), Text = "Starting the login…" };
    private readonly PictureBox qr = new() { Location = new Point(70, 44), Size = new Size(220, 220), SizeMode = PictureBoxSizeMode.Zoom, Visible = false };
    private readonly Button open = new() { Text = "Open in browser", Location = new Point(70, 394), Size = new Size(130, 32), FlatStyle = FlatStyle.Flat, BackColor = Color.RoyalBlue, ForeColor = Color.White, Enabled = false };

    public LoginForm(Api api)
    {
        this.api = api;
        Text = "Log in to Tasks";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        TopMost = true;
        ClientSize = new Size(360, 440);
        BackColor = Color.FromArgb(0x33, 0x33, 0x33);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10);

        var title = new Label { Text = "Scan this code, or open the page in a browser", AutoSize = false, TextAlign = ContentAlignment.MiddleCenter, Font = new Font(Font, FontStyle.Bold), Location = new Point(16, 10), Size = new Size(328, 28) };
        var cancelButton = new Button { Text = "Cancel", Location = new Point(208, 394), Size = new Size(82, 32), FlatStyle = FlatStyle.Flat, BackColor = Color.DimGray, ForeColor = Color.White };
        cancelButton.Click += (_, _) => Close();
        Controls.AddRange([title, qr, code, message, open, cancelButton]);

        Shown += async (_, _) => await Run();
        FormClosed += (_, _) => cancel.Cancel();
    }

    private async Task Run()
    {
        try
        {
            var login = new ToolLogin(api);
            var start = await login.Start(cancel.Token);
            code.Text = start.UserCode;
            message.Text = "Only approve it if the page shows this same code.\nWaiting for approval…";
            open.Enabled = true;
            open.Click += (_, _) => Process.Start(new ProcessStartInfo(start.VerificationUrlComplete) { UseShellExecute = true });
            if (QrFromSvg(start.QrCodeSvg) is { } image)
            {
                qr.Image = image;
                qr.Visible = true;
            }
            (await login.Collect(start, cancel.Token)).Save();
            await api.Current();
            Close();
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            // The window was closed
        }
        catch (ApiException error) when (error.Error.IsNotLoggedIn)
        {
            Fail("Logged in, but the server refuses this session. The path's rule on the login service must require a permission flagged for Tools, and your account must have it. It then works with no new login.");
        }
        catch (Exception error)
        {
            Fail(error.Message);
        }
    }

    private void Fail(string text)
    {
        qr.Visible = false;
        code.Visible = false;
        open.Visible = false;
        message.ForeColor = Color.White;
        message.Location = new Point(16, 60);
        message.Size = new Size(328, 300);
        message.Text = text;
    }

    /// <summary>
    /// Draws the QR code of the login service, which is one stroked path of "M x y", "m dx 0" and "h n".
    /// Null if it ever looks different: the code and the link are enough to log in.
    /// </summary>
    internal static Bitmap? QrFromSvg(string svg)
    {
        var size = Regex.Match(svg, @"viewBox=""0 0 (\d+) \d+""");
        var path = Regex.Match(svg, @"stroke=""[^""]*""(?: stroke-opacity=""[^""]*"")? d=""([^""]+)""");
        if (!size.Success || !path.Success) return null;
        const int scale = 6;
        var modules = int.Parse(size.Groups[1].Value, CultureInfo.InvariantCulture);
        var image = new Bitmap(modules * scale, modules * scale);
        using var graphics = Graphics.FromImage(image);
        graphics.Clear(Color.White);
        double x = 0, y = 0;
        foreach (Match command in Regex.Matches(path.Groups[1].Value, @"([Mmh])([\d.]+)(?: ([\d.]+))?"))
        {
            var value = double.Parse(command.Groups[2].Value, CultureInfo.InvariantCulture);
            switch (command.Groups[1].Value)
            {
                case "M":
                    x = value;
                    y = double.Parse(command.Groups[3].Value, CultureInfo.InvariantCulture) - 0.5;
                    break;
                case "m":
                    x += value;
                    break;
                default:
                    graphics.FillRectangle(Brushes.Black, (int)x * scale, (int)y * scale, (int)value * scale, scale);
                    x += value;
                    break;
            }
        }
        return image;
    }
}
