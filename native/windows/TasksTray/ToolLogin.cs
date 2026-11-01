using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace TasksTray;

public record LoginStart(string DeviceCode, string UserCode, string VerificationUrl, string VerificationUrlComplete, string QrCodeSvg, double ExpiresIn, double Interval);

/// <summary>Logs in with approval from a browser on any device. See the login service's docs/tool-login.md</summary>
internal sealed class ToolLogin(Api api)
{
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(15) };
    private Uri? site;

    private static string ClientName
    {
        get
        {
            var host = Regex.Replace(Environment.MachineName, @"[^\p{L}\p{N} ._-]", "");
            var name = $"Tasks for Windows - {host}".Trim();
            return name.Length > 64 ? name[..64].TrimEnd() : name;
        }
    }

    /// <summary>The login service of the remote is found where it sends a visitor without a session</summary>
    private async Task<Uri> Site(CancellationToken cancel)
    {
        using var response = await Http.GetAsync(new Uri(api.WebUrl, "api/current"), cancel);
        if (response.Headers.Location is not { } location) throw new InvalidOperationException("This server doesn't ask for a login");
        var found = location.IsAbsoluteUri ? location : new Uri(api.WebUrl, location);
        return new Uri(found.GetLeftPart(UriPartial.Authority) + "/api/auth/tool-login/");
    }

    public async Task<LoginStart> Start(CancellationToken cancel)
    {
        site = await Site(cancel);
        using var response = await Http.PostAsJsonAsync(new Uri(site, "start"), new { clientName = ClientName }, Api.Json, cancel);
        var text = await response.Content.ReadAsStringAsync(cancel);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"Couldn't start the login ({(int)response.StatusCode})");
        return JsonSerializer.Deserialize<LoginStart>(text, Api.Json)!;
    }

    /// <summary>Waits for the approval: network trouble is retried until the login expires</summary>
    public async Task<Session> Collect(LoginStart start, CancellationToken cancel)
    {
        var deadline = DateTimeOffset.Now.AddSeconds(start.ExpiresIn);
        var wait = start.Interval;
        while (DateTimeOffset.Now < deadline)
        {
            await Task.Delay(TimeSpan.FromSeconds(wait), cancel);
            HttpResponseMessage response;
            string text;
            try
            {
                response = await Http.PostAsJsonAsync(new Uri(site!, "token"), new { deviceCode = start.DeviceCode }, Api.Json, cancel);
                text = await response.Content.ReadAsStringAsync(cancel);
            }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException && !cancel.IsCancellationRequested)
            {
                continue;
            }
            using (response)
            {
                if (response.IsSuccessStatusCode) return JsonSerializer.Deserialize<Session>(text, Api.Json)!;
                switch (PendingError(text))
                {
                    case "authorization_pending": break;
                    case "slow_down": wait += start.Interval; break;
                    case "access_denied": throw new InvalidOperationException("The login was denied.");
                    case "expired_token": throw new InvalidOperationException("The login expired. Try again.");
                    default: throw new InvalidOperationException($"The login failed ({(int)response.StatusCode}).");
                }
            }
        }
        throw new InvalidOperationException("The login expired. Try again.");
    }

    private static string? PendingError(string text)
    {
        try
        {
            using var json = JsonDocument.Parse(text);
            return json.RootElement.TryGetProperty("error", out var error) ? error.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
