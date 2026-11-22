namespace BellTeam.Linux;

// a529n: the device glyphs of the sessions screen. Generic device glyphs only, no brand marks (Tronie 2026-11-23); the path data is copied byte for byte from Rapi's files
// docs/architecture/modules/apple/sessions-icons/{phone,tablet,laptop,desktop,web,console}.svg (24 x 24 viewBox, drawn for this project). Every platform uses these same files; do not substitute another set.
public static class HomeSessionIcons
{
    public const string Phone = "M8 1h8a2 2 0 0 1 2 2v18a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2zm0 3v14h8V4zm4 15.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2z",
        Tablet = "M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v12h14V5zm7 13.4a1 1 0 1 0 0 2 1 1 0 0 0 0-2z",
        Laptop = "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10H4zm2 0v8h12V5zM2 17h20v1.5A1.5 1.5 0 0 1 20.5 20h-17A1.5 1.5 0 0 1 2 18.5z",
        Desktop = "M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-6.5l.8 3H17v2H7v-2h1.7l.8-3H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6z",
        Web = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c.9 0 2.3 1.9 2.8 5H9.2C9.7 5.9 11.1 4 12 4zM4.3 11h3c-.1.6-.1 1.3-.1 2s0 1.4.1 2h-3a8 8 0 0 1 0-4zm5 0h5.4c.1.6.1 1.3.1 2s0 1.4-.1 2H9.3c-.1-.6-.1-1.3-.1-2s0-1.4.1-2zm7.4 0h3a8 8 0 0 1 0 4h-3c.1-.6.1-1.3.1-2s0-1.4-.1-2zM9.2 17h5.6c-.5 3.1-1.9 5-2.8 5s-2.3-1.9-2.8-5z",
        Console = "M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 3.2 4.3 3.3L4 13.8v2.3l7-5.6-7-5.5zM12 15h7v1.8h-7z";

    // Mapping per kind (Rapi's reference): apple -> phone (the list does not say iPad or Mac), android -> phone, windows and linux -> desktop, web -> web, a console session -> console.
    public static string? Of(string kind, string? appKind) => kind == "console" ? Console : appKind switch { "apple" or "android" => Phone, "windows" or "linux" => Desktop, "web" => Web, _ => null };
}
