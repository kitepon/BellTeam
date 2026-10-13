using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace BellTeam.App;

public static class DesktopShortcut
{
    public const string AppId = "BellTeam.Desktop";
    public static (string Target, string AppId) Inspect(string path)
    {
        var link = (IShellLink)new ShellLink();
        try
        {
            ((IPersistFile)link).Load(path, 0); var target = new StringBuilder(32768); link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
            var key = new PropertyKey { Format = new("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 }; ((IPropertyStore)link).GetValue(ref key, out var value);
            try { if (value.Type != 31) throw new System.IO.InvalidDataException("ショートカットのAppUserModelIDが文字列ではありません。"); return (target.ToString(), Marshal.PtrToStringUni(value.Text)!); }
            finally { PropVariantClear(ref value); }
        }
        finally { Marshal.FinalReleaseComObject(link); }
    }
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropertyValue value);
    public static void Create(string path, string executable, string appId = AppId)
    {
        var link = (IShellLink)new ShellLink();
        try
        {
            link.SetPath(executable); link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(executable)!); link.SetDescription("BellTeam"); link.SetIconLocation(executable, 0);
            var store = (IPropertyStore)link; var key = new PropertyKey { Format = new("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
            var value = new PropertyValue { Type = 31, Text = Marshal.StringToCoTaskMemUni(appId) };
            try { store.SetValue(ref key, ref value); store.Commit(); ((IPersistFile)link).Save(path, true); }
            finally { Marshal.FreeCoTaskMem(value.Text); }
        }
        finally { Marshal.FinalReleaseComObject(link); }
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] private class ShellLink { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface IShellLink
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
        void GetIDList(out IntPtr list); void SetIDList(IntPtr list);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count); void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count); void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetHotkey(out short key); void SetHotkey(short key); void GetShowCmd(out int command); void SetShowCmd(int command);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index); void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved); void Resolve(IntPtr window, uint flags); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }
    [StructLayout(LayoutKind.Sequential)] private struct PropertyKey { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] private struct PropertyValue { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Text; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface IPropertyStore
    {
        void GetCount(out uint count); void GetAt(uint index, out PropertyKey key); void GetValue(ref PropertyKey key, out PropertyValue value); void SetValue(ref PropertyKey key, ref PropertyValue value); void Commit();
    }
}
