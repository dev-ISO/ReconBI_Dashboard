using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The HMAC tokens ARE the credential for the two anonymous endpoints, so
/// these tests pin the full contract: round-trip, tamper-rejection, wrong
/// secret, purpose separation (an open token can never act as an unsubscribe
/// and vice versa), and graceful rejection of garbage.
/// </summary>
public sealed class RcdSignedTokensTests
{
    private const string Secret = "test-secret-long-enough-to-be-plausible";

    [Fact]
    public void UnsubscribeTokenRoundTrips()
    {
        var token = RcdSignedTokens.CreateUnsubscribeToken(Secret, 42, "Ops.Team@Example.com");

        Assert.True(RcdSignedTokens.TryReadUnsubscribeToken(Secret, token, out var id, out var email));
        Assert.Equal(42, id);
        Assert.Equal("Ops.Team@Example.com", email); // original casing preserved
    }

    [Fact]
    public void UnsubscribeTokenSurvivesEmailsContainingTheSeparator()
    {
        // Exotic-but-legal quoted local part with '|': the payload split must
        // keep the remainder intact because email is the LAST field.
        var token = RcdSignedTokens.CreateUnsubscribeToken(Secret, 7, "\"a|b\"@example.com");

        Assert.True(RcdSignedTokens.TryReadUnsubscribeToken(Secret, token, out var id, out var email));
        Assert.Equal(7, id);
        Assert.Equal("\"a|b\"@example.com", email);
    }

    [Fact]
    public void OpenTokenRoundTrips()
    {
        var token = RcdSignedTokens.CreateOpenToken(Secret, 123456789012345L);

        Assert.True(RcdSignedTokens.TryReadOpenToken(Secret, token, out var recipientId));
        Assert.Equal(123456789012345L, recipientId);
    }

    [Fact]
    public void TamperedPayloadIsRejected()
    {
        var token = RcdSignedTokens.CreateUnsubscribeToken(Secret, 42, "a@example.com");
        var forged = RcdSignedTokens.CreateUnsubscribeToken(Secret, 43, "a@example.com");
        // Graft the forged payload onto the genuine signature.
        var tampered = forged.Split('.')[0] + "." + token.Split('.')[1];

        Assert.False(RcdSignedTokens.TryReadUnsubscribeToken(Secret, tampered, out _, out _));
    }

    [Fact]
    public void WrongSecretIsRejected()
    {
        var token = RcdSignedTokens.CreateUnsubscribeToken(Secret, 42, "a@example.com");

        Assert.False(RcdSignedTokens.TryReadUnsubscribeToken("other-secret", token, out _, out _));
    }

    [Fact]
    public void PurposesNeverCross()
    {
        // A valid open token must not unsubscribe anyone, and a valid
        // unsubscribe token must not stamp opens — same secret, same format.
        var openToken = RcdSignedTokens.CreateOpenToken(Secret, 42);
        var unsubToken = RcdSignedTokens.CreateUnsubscribeToken(Secret, 42, "a@example.com");

        Assert.False(RcdSignedTokens.TryReadUnsubscribeToken(Secret, openToken, out _, out _));
        Assert.False(RcdSignedTokens.TryReadOpenToken(Secret, unsubToken, out _));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("no-dot")]
    [InlineData(".leading-dot")]
    [InlineData("trailing-dot.")]
    [InlineData("not!base64.also!not")]
    [InlineData("YQ.YQ")] // valid base64, wrong MAC length
    public void MalformedTokensAreRejectedNotThrown(string? token)
    {
        Assert.False(RcdSignedTokens.TryReadUnsubscribeToken(Secret, token, out _, out _));
        Assert.False(RcdSignedTokens.TryReadOpenToken(Secret, token, out _));
    }

    [Fact]
    public void MissingSecretRejectsEverything()
    {
        var token = RcdSignedTokens.CreateUnsubscribeToken(Secret, 42, "a@example.com");

        Assert.False(RcdSignedTokens.TryReadUnsubscribeToken("", token, out _, out _));
        Assert.False(RcdSignedTokens.TryReadOpenToken(" ", token, out _));
    }
}
