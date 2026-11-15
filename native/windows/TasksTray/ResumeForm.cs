using System.Text.Json;

namespace TasksTray;

/// <summary>
/// The task this app paused because the computer went to sleep, shut down or logged off. Kept on disk,
/// so the offer to resume survives a logoff, and cleared once the offer is made.
/// </summary>
/// <param name="At">Epoch milliseconds, like the API</param>
/// <param name="Reason">"sleep", "logoff" or "shutdown"</param>
public record SystemPause(string Uid, int Id, string Name, double At, string Reason)
{
    public static string Path => System.IO.Path.Combine(Config.Directory, "system-pause.json");

    public DateTimeOffset Date => DateTimeOffset.FromUnixTimeMilliseconds((long)At);

    public static SystemPause? Load()
    {
        try { return JsonSerializer.Deserialize<SystemPause>(File.ReadAllText(Path), Api.Json); }
        catch { return null; }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Config.Directory);
            File.WriteAllText(Path, JsonSerializer.Serialize(this, Api.Json));
        }
        catch { }
    }

    public static void Clear()
    {
        try { File.Delete(Path); } catch { }
    }

    public string Because => Reason switch
    {
        "sleep" => "when the computer went to sleep",
        "logoff" => "when you signed out",
        _ => "when the computer shut down",
    };
}

/// <summary>
/// "Welcome back": offers to resume the task that sleep or a logoff paused, so the timer doesn't stay
/// off without anyone noticing
/// </summary>
internal sealed class ResumeForm : FloatingForm
{
    public SystemPause Pause { get; }

    public ResumeForm(SystemPause pause, string workspace, string worked, Action<bool> answer) : base(440, 180)
    {
        Pause = pause;
        Text = "Resume";

        void Answer(bool resume)
        {
            Close();
            answer(resume);
        }

        var title = AddText($"Welcome back! Resume “{pause.Name}”?", 20, 16, 370, font: new Font("Segoe UI Semibold", 12));
        var local = pause.Date.ToLocalTime();
        var when = local.Date == DateTime.Today ? $"{local:t}" : $"{local:g}";
        var because = AddText($"It was paused at {when} {pause.Because}.", 20, title.Bottom + 6, 400, Theme.Secondary);
        var detail = AddText($"{workspace} · {worked} so far", 20, because.Bottom + 6, 400, Theme.Secondary, new Font("Segoe UI", 8.5f));
        var y = detail.Bottom + 14;
        var resume = new PillButton { Text = "Resume", Icon = "\uE768", Color = Theme.Play, Location = new Point(20, y) }.Fit(110);
        resume.Click += (_, _) => Answer(true);
        var notNow = new PillButton { Text = "Not now", Color = Theme.Neutral }.Fit(100);
        notNow.Location = new Point(420 - notNow.Width, y);
        notNow.Click += (_, _) => Answer(false);
        Controls.AddRange([resume, notNow]);
        ClientSize = new Size(440, y + 50);
        PlaceByTray();
    }
}
