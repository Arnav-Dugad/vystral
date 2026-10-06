using System.Runtime.InteropServices.WindowsRuntime;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage.Streams;

namespace Vystral.App.Host;

/// <summary>Track M: copies a session replay card (already validated as a PNG) to the Windows clipboard. Never throws.</summary>
internal sealed class ClipboardHost(MainWindow window) : IClipboardHost
{
    public Task<bool> CopyPngAsync(byte[] png) => window.OnUiAsync(async () =>
    {
        try
        {
            var stream = new InMemoryRandomAccessStream();
            await stream.WriteAsync(png.AsBuffer());
            stream.Seek(0);
            var package = new DataPackage { RequestedOperation = DataPackageOperation.Copy };
            var reference = RandomAccessStreamReference.CreateFromStream(stream);
            package.SetBitmap(reference);
            // Apps that read the clipboard's PNG format keep the alpha channel and exact pixels.
            package.SetData("PNG", stream.CloneStream());
            Clipboard.SetContent(package);
            Clipboard.Flush();
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("clipboard", "Copying the replay image failed", ex: ex);
            return false;
        }
    });
}
