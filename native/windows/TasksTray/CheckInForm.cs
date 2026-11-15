namespace TasksTray;

/// <summary>What the person answered to "how far along?"</summary>
public enum CheckInKind { Progress, Done, Pause, KeepGoing }

public record CheckInAnswer(CheckInKind Kind, double Progress = 0);

/// <summary>A small topmost window that asks about the running task</summary>
internal sealed class CheckInForm : FloatingForm
{
    public CheckInForm(string task, string worked, DateTimeOffset deadline, Action<CheckInAnswer> answer) : base(440, 196)
    {
        Text = "Check in";

        void Answer(CheckInAnswer result)
        {
            Close();
            answer(result);
        }

        var title = AddText($"Still working on “{task}”?", 20, 16, 370, font: new Font("Segoe UI Semibold", 12));
        var y = title.Bottom + 6;
        AddText($"{worked} so far. How far along is it?", 20, y, 400, Theme.Secondary);
        y += 30;
        double[] steps = [0.1, 0.25, 0.5, 0.75, 0.9];
        var x = 20;
        for (var i = 0; i < steps.Length; i++)
        {
            var step = steps[i];
            var chip = new PillButton { Text = $"{step * 100:0}%", Color = Theme.Levels[i % Theme.Levels.Length], Outlined = true, Location = new Point(x, y), Height = 28, Font = new Font("Segoe UI", 10, FontStyle.Bold) }.Fit(60);
            chip.Click += (_, _) => Answer(new CheckInAnswer(CheckInKind.Progress, step));
            Controls.Add(chip);
            x = chip.Right + 8;
        }
        y += 40;
        var done = new PillButton { Text = "Done", Icon = "\uE73E", Color = Theme.Done, Location = new Point(20, y) }.Fit(96);
        done.Click += (_, _) => Answer(new CheckInAnswer(CheckInKind.Done));
        var pause = new PillButton { Text = "Pause", Icon = "\uE769", Color = Theme.Pause, Location = new Point(done.Right + 8, y) }.Fit(96);
        pause.Click += (_, _) => Answer(new CheckInAnswer(CheckInKind.Pause));
        var keepGoing = new PillButton { Text = "Keep going", Color = Theme.Primary }.Fit(110);
        keepGoing.Location = new Point(420 - keepGoing.Width, y);
        keepGoing.Click += (_, _) => Answer(new CheckInAnswer(CheckInKind.KeepGoing));
        Controls.AddRange([done, pause, keepGoing]);
        y += 44;
        AddText($"No answer by {deadline.ToLocalTime():t} pauses it as of the question.", 20, y, 400, Theme.Secondary, new Font("Segoe UI", 8.5f));
        ClientSize = new Size(440, y + 30);
        PlaceByTray();
        // Closing the window is no answer: the grace period still runs
    }
}
