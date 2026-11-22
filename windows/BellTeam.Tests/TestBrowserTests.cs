using BellTeam.App;

namespace BellTeam.Tests;

public class TestBrowserTests
{
    [Fact]
    public void WithoutTheVariableTheSystemBrowserIsUsedAndWithItAChromeOfThatProfileOpensTheAddress()
    {
        var before = Environment.GetEnvironmentVariable("BELLTEAM_TEST_CHROME_PROFILE");
        try
        {
            Environment.SetEnvironmentVariable("BELLTEAM_TEST_CHROME_PROFILE", null);
            Assert.Null(TestBrowser.Open);
            Environment.SetEnvironmentVariable("BELLTEAM_TEST_CHROME_PROFILE", @"C:\p");
            Assert.NotNull(TestBrowser.Open);
        }
        finally { Environment.SetEnvironmentVariable("BELLTEAM_TEST_CHROME_PROFILE", before); }
        Assert.Equal("--user-data-dir=\"C:\\p\" --no-first-run --no-default-browser-check \"https://example.test/a?b=1\"", TestBrowser.Arguments(@"C:\p", new Uri("https://example.test/a?b=1")));
    }
}
