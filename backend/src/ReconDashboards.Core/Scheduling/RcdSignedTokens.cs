using System.Security.Cryptography;
using System.Text;

namespace ReconDashboards.Core.Scheduling;

/// <summary>
/// Self-authenticating tokens for the two anonymous endpoints: unsubscribe
/// (payload "u|{subscriptionId}|{email}") and the open-tracking pixel
/// (payload "o|{dispatchRecipientId}"). Format:
/// base64url(payload) + "." + base64url(HMAC-SHA256(secret, payload)).
///
/// The payload travels INSIDE the token (the endpoint has no other way to
/// learn who is unsubscribing), the HMAC proves the server minted it, and the
/// purpose prefix pins each token to one endpoint — an open token can never
/// be replayed as an unsubscribe and vice versa. Verification decodes, then
/// recomputes the MAC and compares in constant time; any malformed input is
/// just "invalid", never an exception. Tokens do not expire: an unsubscribe
/// link in a months-old email must still work, and the worst a stolen open
/// token enables is a bumped open counter.
/// </summary>
public static class RcdSignedTokens
{
    private const string UnsubscribePurpose = "u";
    private const string OpenPurpose = "o";

    public static string CreateUnsubscribeToken(string secret, int subscriptionId, string email) =>
        Sign(secret, $"{UnsubscribePurpose}|{subscriptionId}|{email}");

    public static bool TryReadUnsubscribeToken(string secret, string? token, out int subscriptionId, out string email)
    {
        subscriptionId = 0;
        email = "";
        if (!TryVerify(secret, token, out var payload))
        {
            return false;
        }

        // Email is the LAST field and may itself contain '|' in exotic quoted
        // local parts, so split at most twice and keep the remainder intact.
        var parts = payload.Split('|', 3);
        if (parts.Length != 3
            || parts[0] != UnsubscribePurpose
            || !int.TryParse(parts[1], out subscriptionId)
            || string.IsNullOrWhiteSpace(parts[2]))
        {
            return false;
        }

        email = parts[2];
        return true;
    }

    public static string CreateOpenToken(string secret, long dispatchRecipientId) =>
        Sign(secret, $"{OpenPurpose}|{dispatchRecipientId}");

    public static bool TryReadOpenToken(string secret, string? token, out long dispatchRecipientId)
    {
        dispatchRecipientId = 0;
        if (!TryVerify(secret, token, out var payload))
        {
            return false;
        }

        var parts = payload.Split('|', 2);
        return parts.Length == 2
            && parts[0] == OpenPurpose
            && long.TryParse(parts[1], out dispatchRecipientId);
    }

    private static string Sign(string secret, string payload)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(secret);
        var payloadBytes = Encoding.UTF8.GetBytes(payload);
        var mac = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), payloadBytes);
        return Base64Url(payloadBytes) + "." + Base64Url(mac);
    }

    private static bool TryVerify(string secret, string? token, out string payload)
    {
        payload = "";
        if (string.IsNullOrWhiteSpace(secret) || string.IsNullOrWhiteSpace(token))
        {
            return false;
        }

        var dot = token.IndexOf('.');
        if (dot <= 0 || dot == token.Length - 1)
        {
            return false;
        }

        if (!TryUnBase64Url(token[..dot], out var payloadBytes)
            || !TryUnBase64Url(token[(dot + 1)..], out var providedMac))
        {
            return false;
        }

        var expectedMac = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), payloadBytes);
        if (!CryptographicOperations.FixedTimeEquals(expectedMac, providedMac))
        {
            return false;
        }

        payload = Encoding.UTF8.GetString(payloadBytes);
        return true;
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static bool TryUnBase64Url(string text, out byte[] bytes)
    {
        bytes = [];
        var padded = text.Replace('-', '+').Replace('_', '/');
        padded += (padded.Length % 4) switch
        {
            2 => "==",
            3 => "=",
            0 => "",
            _ => "!", // length % 4 == 1 is never valid base64; force failure
        };

        try
        {
            bytes = Convert.FromBase64String(padded);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
