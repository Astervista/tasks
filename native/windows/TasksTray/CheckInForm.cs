namespace TasksTray;

/// <summary>What the person answered to "how far along?"</summary>
public enum CheckInKind { Progress, Done, Pause, KeepGoing }

public record CheckInAnswer(CheckInKind Kind, double Progress = 0);

/// <summary>A small topmost window that asks about the running task</summary>
public sealed class CheckInForm : Form
{
    private static readonly Color[] Colors = [Color.Crimson, Color.OrangeRed, Color.Orange, Color.Teal, Color.RoyalBlue, Color.MediumOrchid, Color.DeepPink];

    public CheckInForm(string task, string worked, DateTimeOffset deadline, Action<CheckInAnswer> answer)
    {
        Text = "Check in";
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        ShowInTaskbar = true;
        ClientSize = new Size(440, 190);
        BackColor = Color.FromArgb(0x33, 0x33, 0x33);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10);
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        Location = new Point(area.Right - Width - 20, area.Bottom - Height - 20);

        void Answer(CheckInAnswer result)
        {
            Close();
            answer(result);
        }

        Controls.Add(new Label { Text = $"Still working on “{task}”?", Font = new Font(Font, FontStyle.Bold), AutoSize = true, Location = new Point(16, 12) });
        Controls.Add(new Label { Text = $"{worked} so far. How far along is it?", ForeColor = Color.Silver, AutoSize = true, Location = new Point(16, 38) });
        double[] steps = [0.1, 0.25, 0.5, 0.75, 0.9];
        for (var i = 0; i < steps.Length; i++)
        {
            var step = steps[i];
            var button = new Button
            {
                Text = $"{step * 100:0}%", Location = new Point(16 + i * 82, 70), Size = new Size(74, 32),
                BackColor = Colors[i % Colors.Length], ForeColor = Color.White, FlatStyle = FlatStyle.Flat,
            };
            button.FlatAppearance.BorderSize = 0;
            button.Click += (_, _) => Answer(new CheckInAnswer(CheckInKind.Progress, step));
            Controls.Add(button);
        }
        Button Plain(string text, int x, CheckInKind kind, Color? color = null)
        {
            var button = new Button { Text = text, Location = new Point(x, 112), Size = new Size(100, 30), FlatStyle = FlatStyle.Flat, BackColor = color ?? Color.DimGray, ForeColor = Color.White };
            button.FlatAppearance.BorderSize = 0;
            button.Click += (_, _) => Answer(new CheckInAnswer(kind));
            Controls.Add(button);
            return button;
        }
        Plain("Done ✔", 16, CheckInKind.Done, Color.ForestGreen);
        Plain("Pause", 124, CheckInKind.Pause);
        Plain("Keep going", 324, CheckInKind.KeepGoing);
        Controls.Add(new Label
        {
            Text = $"No answer by {deadline.ToLocalTime():t} pauses it as of now.",
            ForeColor = Color.Silver, AutoSize = true, Location = new Point(16, 156), Font = new Font("Segoe UI", 8.5f),
        });
        // Closing the window is no answer: the grace period still runs
    }
}
