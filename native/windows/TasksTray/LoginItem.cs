using Microsoft.Win32;

/// <summary>
/// Starting with Windows, through the user's Run key. On by default: the first launch adds it;
/// turning it off (here or in Task Manager › Startup apps) is then left alone.
/// </summary>
internal static class LoginItem
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string SettingsKey = @"Software\TasksTray";
    private const string Name = "TasksTray";

    public static bool Enabled
    {
        get
        {
            using var run = Registry.CurrentUser.OpenSubKey(RunKey);
            return run?.GetValue(Name) is string;
        }
    }

    public static void Set(bool on)
    {
        using var run = Registry.CurrentUser.CreateSubKey(RunKey);
        if (on)
        {
            run.SetValue(Name, $"\"{Environment.ProcessPath ?? Application.ExecutablePath}\"");
        }
        else
        {
            run.DeleteValue(Name, false);
        }
    }

    public static void OfferOnce()
    {
        using var settings = Registry.CurrentUser.CreateSubKey(SettingsKey);
        if (settings.GetValue("LoginItemOffered") is null)
        {
            settings.SetValue("LoginItemOffered", 1);
            Set(true);
        }
    }
}
