using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TasksTray;

/// <summary>Remote + token written by <c>tasks remote set</c> (%USERPROFILE%\.config\tasks\config.json)</summary>
/// <param name="PauseOnSleep">Pause the running task when the computer sleeps (default true)</param>
/// <param name="CheckInMinutes">Ask "how far along?" after this many minutes of running (default 45, 0 = never)</param>
/// <param name="CheckInGraceMinutes">Pause as of the question when nobody answers in time (default 10)</param>
public record Config(string? Remote, string? Token, bool? PauseOnSleep, double? CheckInMinutes, double? CheckInGraceMinutes)
{
    public static string Path => System.IO.Path.Combine(
        Environment.GetEnvironmentVariable("TASKS_CONFIG_DIR")
            ?? System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "tasks"),
        "config.json");

    public static Config? Load()
    {
        try
        {
            return JsonSerializer.Deserialize<Config>(File.ReadAllText(Path), Api.Json);
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>A logged session ({start, end}) or a day total ({day, minutes}); only sessions matter here</summary>
public record TimeEntry(double? Start, double? End);

public record CheckIn(double At, double Progress);

public record Todo(int Id, string Name, List<TimeEntry> Time, List<CheckIn> Checkins)
{
    public DateTimeOffset? LastCheckIn =>
        Checkins.Count == 0 ? null : DateTimeOffset.FromUnixTimeMilliseconds((long)Checkins.Max(checkin => checkin.At));

    public DateTimeOffset? RunningSince =>
        Time.FirstOrDefault(entry => entry.Start != null && entry.End == null) is { Start: { } start }
            ? DateTimeOffset.FromUnixTimeMilliseconds((long)start)
            : null;
}

/// <summary>The server's guess of the total work and what's left (minutes)</summary>
public record TodoEta(double? Total, double? Remaining, double? Progress, bool Over);

public record CurrentTask(string Uid, string Workspace, Todo Todo, List<string> Path, bool Running, double Minutes, double TodayMinutes, TodoEta Eta);

public record OpenTodo(string Uid, string Workspace, int Id, string Name, int? ParentId, int Depth, string Status, double? LastWorked);

public record ApiError(int StatusCode, string Message, string? Code);

public class ApiException(ApiError error) : Exception(error.Message)
{
    public ApiError Error { get; } = error;
}

/// <summary>REST + SSE client for the tasks server</summary>
public sealed class Api
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient http;
    public Uri WebUrl { get; }

    public Api(Config config)
    {
        WebUrl = new Uri(config.Remote!.TrimEnd('/') + "/");
        http = new HttpClient { BaseAddress = new Uri(WebUrl, "api/"), Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
    }

    private static async Task<HttpResponseMessage> Check(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadFromJsonAsync<ApiError>(Json).ConfigureAwait(false)
                        ?? new ApiError((int)response.StatusCode, $"Request failed with {(int)response.StatusCode}", null);
            throw new ApiException(error);
        }
        return response;
    }

    private static CancellationToken Short => new CancellationTokenSource(TimeSpan.FromSeconds(15)).Token;

    public async Task<CurrentTask?> Current()
    {
        var response = await Check(await http.GetAsync("current", Short));
        var text = await response.Content.ReadAsStringAsync();
        return string.IsNullOrWhiteSpace(text) || text == "null" ? null : JsonSerializer.Deserialize<CurrentTask>(text, Json);
    }

    public async Task<List<OpenTodo>> OpenTodos()
    {
        var response = await Check(await http.GetAsync("todos", Short));
        return await response.Content.ReadFromJsonAsync<List<OpenTodo>>(Json) ?? [];
    }

    /// <param name="at">With "paused": when the work actually stopped</param>
    public async Task SetStatus(string uid, int id, string status, bool withDescendants = false, DateTimeOffset? at = null)
    {
        object body = at is { } moment
            ? new { status, withDescendants, at = moment.ToUnixTimeMilliseconds() }
            : new { status, withDescendants };
        await Check(await http.PatchAsJsonAsync($"workspaces/{uid}/todos/{id}", body, Json, Short));
    }

    public async Task CheckIn(string uid, int id, double progress, string note = "")
    {
        await Check(await http.PostAsJsonAsync($"workspaces/{uid}/todos/{id}/checkins", new { progress, note }, Json, Short));
    }

    /// <summary>Calls <paramref name="onEvent"/> for every server event until the stream ends or fails</summary>
    public async Task Listen(Action onEvent, CancellationToken cancel)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "events");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        using var response = await Check(await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel));
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(cancel));
        while (await reader.ReadLineAsync(cancel) is { } line)
        {
            if (line.StartsWith("data:") && line.Length > 6) onEvent();
        }
    }
}
