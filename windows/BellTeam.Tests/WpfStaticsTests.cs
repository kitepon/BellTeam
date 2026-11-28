using System.Reflection;
using System.Windows;
using System.Windows.Threading;
using BellTeam.App;

namespace BellTeam.Tests;

// A brush, template or style that a static field holds for every UI thread must be sealed or frozen (no Dispatcher): an unsealed one belongs to the thread that built it,
// and a second UI thread (parallel tests) using it throws. Per-thread values use [ThreadStatic] (StartupViews, SecretInputWindow).
public sealed class WpfStaticsTests
{
    [Fact]
    public void NoStaticFieldHoldsAThreadBoundWpfObject()
    {
        var offenders = new List<string>(); Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                foreach (var type in typeof(SecretInputWindow).Assembly.GetTypes().Where(t => !t.ContainsGenericParameters))
                {
                    System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(type.TypeHandle);
                    foreach (var field in type.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                        if (field.GetCustomAttribute<ThreadStaticAttribute>() is null && !field.IsLiteral && field.GetValue(null) is (Freezable or Style or FrameworkTemplate) and DispatcherObject { Dispatcher: not null })
                            offenders.Add(type.Name + "." + field.Name);
                }
            }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
        Assert.True(offenders.Count == 0, "Static fields holding a thread-bound WPF object (seal or freeze it, or make it [ThreadStatic]):\n" + string.Join("\n", offenders));
    }
}
