using System.Diagnostics;
using System.Drawing.Drawing2D;
using Microsoft.Win32;

namespace TasksTray;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var single = new Mutex(true, "TasksTray.SingleInstance", out var first);
        if (!first) return;
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext());
    }
}

/// <summary>
/// Tray icon: green while a task runs, amber when paused, grey when idle or offline. The tooltip shows
/// the task and its time, double click pauses/resumes, the menu has the controls and "Switch to".
/// </summary>
internal sealed class TrayContext : ApplicationContext
{
    private readonly NotifyIcon icon = new() { Visible = true, Text = "Tasks" };
    private readonly ContextMenuStrip menu = new();
    private readonly System.Windows.Forms.Timer ticker = new() { Interval = 1000 };
    private readonly SynchronizationContext ui;
    private readonly CancellationTokenSource stop = new();
    private readonly Dictionary<string, Icon> icons = new();

    private Api? api;
    private CurrentTask? current;
    private List<OpenTodo> openTodos = [];
    private DateTimeOffset fetchedAt = DateTimeOffset.Now;
    private bool connected;
    private string? problem;
    private Config? config;
    private readonly System.Windows.Forms.Timer checkInTimer = new() { Interval = 30_000 };
    private CheckInForm? checkInForm;
    /// <summary>When the open check-in question was asked</summary>
    private DateTimeOffset? promptedAt;
    /// <summary>Last answer (or "keep going"): the next question comes an interval after it</summary>
    private DateTimeOffset? answeredAt;
    private DateTimeOffset? sleptAt;

    public TrayContext()
    {
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        icon.ContextMenuStrip = menu;
        menu.Opening += (_, _) => BuildMenu();
        icon.DoubleClick += (_, _) => TogglePause();
        ticker.Tick += (_, _) => UpdateIcon();
        ticker.Start();
        checkInTimer.Tick += (_, _) => CheckInTick();
        checkInTimer.Start();
        SystemEvents.PowerModeChanged += OnPowerModeChanged;
        UpdateIcon();
        _ = Run();
    }

    // Sleep: the hours the computer sleeps are not work -------------------------------------------

    private void OnPowerModeChanged(object? sender, PowerModeChangedEventArgs e)
    {
        if (config?.PauseOnSleep == false) return;
        if (e.Mode == PowerModes.Suspend && Running && current is { } task && api != null)
        {
            sleptAt = DateTimeOffset.Now;
            CloseCheckIn();
            try { api.SetStatus(task.Uid, task.Todo.Id, "paused", at: sleptAt).Wait(TimeSpan.FromSeconds(3)); } catch { }
        }
        else if (e.Mode == PowerModes.Resume && sleptAt is { } slept)
        {
            sleptAt = null;
            _ = EnsurePausedAfterSleep(slept);
        }
    }

    /// <summary>The pause may not have reached the server before the network went down: make sure it did</summary>
    private async Task EnsurePausedAfterSleep(DateTimeOffset slept)
    {
        for (var attempt = 0; attempt < 10; attempt++)
        {
            if (api == null) return;
            try
            {
                var task = await api.Current();
                if (task is { Running: true } && task.Todo.RunningSince is { } since && since <= slept)
                    await api.SetStatus(task.Uid, task.Todo.Id, "paused", at: slept);
                await Refresh();
                return;
            }
            catch
            {
                await Task.Delay(TimeSpan.FromSeconds(6));
            }
        }
    }

    // Check-ins: "how far along?" while a task runs, so none is left running forgotten -------------

    private TimeSpan CheckInInterval => TimeSpan.FromMinutes(config?.CheckInMinutes ?? 45);
    private TimeSpan CheckInGrace => TimeSpan.FromMinutes(config?.CheckInGraceMinutes ?? 10);

    private void CheckInTick()
    {
        if (current is not { Running: true } task || task.Todo.RunningSince is not { } since)
        {
            CloseCheckIn();
            return;
        }
        if (promptedAt is { } asked)
        {
            if (DateTimeOffset.Now - asked >= CheckInGrace)
            {
                // Nobody answered: the work stopped when we asked
                CloseCheckIn();
                problem = $"Paused “{task.Todo.Name}”: no answer to the check-in";
                _ = SetStatusAt(task, asked);
            }
            return;
        }
        if (CheckInInterval <= TimeSpan.Zero) return;
        var last = new[] { since, task.Todo.LastCheckIn ?? since, answeredAt ?? since }.Max();
        if (DateTimeOffset.Now - last >= CheckInInterval) AskCheckIn();
    }

    private async Task SetStatusAt(CurrentTask task, DateTimeOffset at)
    {
        try { if (api != null) await api.SetStatus(task.Uid, task.Todo.Id, "paused", at: at); } catch (Exception error) { problem = error.Message; }
        await Refresh();
    }

    private void AskCheckIn()
    {
        if (current is not { Running: true } task) return;
        CloseCheckIn();
        var asked = DateTimeOffset.Now;
        promptedAt = asked;
        checkInForm = new CheckInForm(task.Todo.Name, Format(task.Minutes + Elapsed), asked + CheckInGrace, answer => _ = Answered(answer, task));
        checkInForm.Show();
        checkInForm.Activate();
    }

    private void CloseCheckIn()
    {
        promptedAt = null;
        var form = checkInForm;
        checkInForm = null;
        if (form is { IsDisposed: false })
        {
            form.Hide();
            form.Dispose();
        }
    }

    private async Task Answered(CheckInAnswer answer, CurrentTask task)
    {
        if (checkInForm == null && promptedAt == null) return; // closed by us, not answered
        promptedAt = null;
        checkInForm = null;
        answeredAt = DateTimeOffset.Now;
        if (api == null) return;
        try
        {
            switch (answer.Kind)
            {
                case CheckInKind.Progress: await api.CheckIn(task.Uid, task.Todo.Id, answer.Progress); break;
                case CheckInKind.Done: await SetStatusAsync(task.Uid, task.Todo.Id, "done"); break;
                case CheckInKind.Pause: await api.SetStatus(task.Uid, task.Todo.Id, "paused"); break;
            }
        }
        catch (Exception error)
        {
            problem = error.Message;
        }
        await Refresh();
    }

    private bool Running => current?.Running == true;

    private double Elapsed => Running ? (DateTimeOffset.Now - fetchedAt).TotalMinutes : 0;

    /// <summary>Keeps the event stream open (with backoff) and refreshes on every event</summary>
    private async Task Run()
    {
        var delay = TimeSpan.FromSeconds(1);
        while (!stop.IsCancellationRequested)
        {
            var config = Config.Load();
            if (config?.Remote == null || config.Token == null)
            {
                problem = "Run \"tasks remote set <url> --token <token>\" first";
                Post(UpdateIcon);
                await Task.Delay(TimeSpan.FromSeconds(10));
                continue;
            }
            this.config = config;
            api = new Api(config);
            await Refresh();
            try
            {
                connected = true;
                delay = TimeSpan.FromSeconds(1);
                await api.Listen(() => _ = Refresh(), stop.Token);
            }
            catch (Exception error) when (!stop.IsCancellationRequested)
            {
                problem = error.Message;
            }
            connected = false;
            Post(UpdateIcon);
            await Task.Delay(delay);
            delay = TimeSpan.FromSeconds(Math.Min(delay.TotalSeconds * 2, 60));
        }
    }

    private async Task Refresh()
    {
        if (api == null) return;
        try
        {
            var nextCurrent = await api.Current();
            var nextOpen = await api.OpenTodos();
            Post(() =>
            {
                current = nextCurrent;
                openTodos = nextOpen;
                fetchedAt = DateTimeOffset.Now;
                problem = null;
                UpdateIcon();
            });
        }
        catch (Exception error)
        {
            Post(() => { problem = error.Message; UpdateIcon(); });
        }
    }

    private void Post(Action action) => ui.Post(_ => action(), null);

    private void SetStatus(string uid, int id, string status) => _ = SetStatusAsync(uid, id, status);

    private async Task SetStatusAsync(string uid, int id, string status)
    {
        if (api == null) return;
        try
        {
            await api.SetStatus(uid, id, status);
        }
        catch (ApiException error) when (error.Error.Code == "open-descendants")
        {
            var answer = MessageBox.Show($"{error.Message}. A macrotask is done when all of its subtasks are.\n\nComplete all of them?",
                "Complete the subtasks too?", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (answer == DialogResult.OK) await api.SetStatus(uid, id, status, withDescendants: true);
        }
        catch (Exception error)
        {
            problem = error.Message;
        }
        await Refresh();
    }

    private void TogglePause()
    {
        if (current == null) return;
        SetStatus(current.Uid, current.Todo.Id, Running ? "paused" : "running");
    }

    private void UpdateIcon()
    {
        var state = !connected || problem != null ? "offline" : Running ? "running" : current != null ? "paused" : "idle";
        icon.Icon = IconFor(state);
        var text = current == null
            ? "Tasks: no task yet"
            : $"{(Running ? "▶" : "⏸")} {current.Todo.Name} · {Format(current.Minutes + Elapsed)}\nToday: {Format(current.TodayMinutes + Elapsed)}";
        if (state == "offline") text = $"Tasks: {problem ?? "offline"}";
        icon.Text = text.Length > 127 ? text[..126] + "…" : text; // NotifyIcon's limit
    }

    private void BuildMenu()
    {
        menu.Items.Clear();
        if (current != null)
        {
            menu.Items.Add(new ToolStripMenuItem(string.Join(" › ", current.Path.Append(current.Todo.Name))) { Enabled = false });
            menu.Items.Add(new ToolStripMenuItem($"{current.Workspace} · {Format(current.Minutes + Elapsed)}") { Enabled = false });
            menu.Items.Add(new ToolStripSeparator());
            var task = current;
            menu.Items.Add(Running ? "Pause" : "Resume", null, (_, _) => SetStatus(task.Uid, task.Todo.Id, Running ? "paused" : "running"));
            menu.Items.Add("Done", null, (_, _) => SetStatus(task.Uid, task.Todo.Id, "done"));
            if (Running) menu.Items.Add("Check in…", null, (_, _) => AskCheckIn());
            if (task.Eta.Remaining is { } remaining)
                menu.Items.Add(new ToolStripMenuItem(task.Eta.Over ? "Over the estimate" : $"ETA: ~{Format(Math.Max(0, remaining - Elapsed))} left") { Enabled = false });
        }
        else
        {
            menu.Items.Add(new ToolStripMenuItem("No task yet") { Enabled = false });
        }

        var switchTo = new ToolStripMenuItem("Switch to") { Enabled = openTodos.Count > 0 };
        var workspaces = openTodos
            .GroupBy(todo => todo.Uid)
            .OrderByDescending(group => group.Max(todo => todo.LastWorked ?? 0));
        foreach (var workspace in workspaces)
        {
            var item = new ToolStripMenuItem(workspace.First().Workspace);
            AddTodos(item, workspace.ToList(), null);
            switchTo.DropDownItems.Add(item);
        }
        menu.Items.Add(switchTo);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem($"Today: {Format((current?.TodayMinutes ?? 0) + Elapsed)}") { Enabled = false });
        if (problem != null || !connected)
            menu.Items.Add(new ToolStripMenuItem($"⚠ {problem ?? "Offline"}") { Enabled = false });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open web app", null, (_, _) =>
        {
            if (api != null) Process.Start(new ProcessStartInfo(api.WebUrl.ToString()) { UseShellExecute = true });
        });
        menu.Items.Add("Refresh", null, (_, _) => _ = Refresh());
        menu.Items.Add("Quit", null, (_, _) => Quit());
    }

    /// <summary>Macrotasks become submenus (5 levels at most), starting with an entry for themselves</summary>
    private void AddTodos(ToolStripMenuItem parent, List<OpenTodo> todos, int? parentId)
    {
        foreach (var todo in todos.Where(todo => todo.ParentId == parentId))
        {
            var children = todos.Any(other => other.ParentId == todo.Id);
            var target = todo;
            if (children)
            {
                var submenu = new ToolStripMenuItem(todo.Name);
                submenu.DropDownItems.Add($"Start “{todo.Name}”", null, (_, _) => SetStatus(target.Uid, target.Id, "running"));
                submenu.DropDownItems.Add(new ToolStripSeparator());
                AddTodos(submenu, todos, todo.Id);
                parent.DropDownItems.Add(submenu);
            }
            else
            {
                var item = new ToolStripMenuItem(todo.Name, null, (_, _) => SetStatus(target.Uid, target.Id, "running"))
                {
                    Checked = todo.Status == "running",
                    Enabled = todo.Status != "running",
                };
                parent.DropDownItems.Add(item);
            }
        }
    }

    /// <summary>A round badge in the state's color, drawn once per state</summary>
    private Icon IconFor(string state)
    {
        if (icons.TryGetValue(state, out var cached)) return cached;
        var color = state switch
        {
            "running" => Color.LimeGreen,
            "paused" => Color.Orange,
            "offline" => Color.Crimson,
            _ => Color.SlateGray,
        };
        using var bitmap = new Bitmap(32, 32);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using var brush = new SolidBrush(color);
            graphics.FillEllipse(brush, 2, 2, 28, 28);
            using var white = new SolidBrush(Color.White);
            if (state == "running")
                graphics.FillPolygon(white, [new Point(12, 9), new Point(12, 23), new Point(24, 16)]);
            else if (state == "paused")
            {
                graphics.FillRectangle(white, 10, 9, 4, 14);
                graphics.FillRectangle(white, 18, 9, 4, 14);
            }
            else
                graphics.FillRectangle(white, 10, 14, 12, 4);
        }
        var result = Icon.FromHandle(bitmap.GetHicon());
        icons[state] = result;
        return result;
    }

    private static string Format(double minutes)
    {
        var total = (int)minutes;
        return total >= 60 ? $"{total / 60}h {total % 60}m" : $"{total}m";
    }

    private void Quit()
    {
        SystemEvents.PowerModeChanged -= OnPowerModeChanged;
        CloseCheckIn();
        stop.Cancel();
        icon.Visible = false;
        ExitThread();
    }
}
