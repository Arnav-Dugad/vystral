using Microsoft.UI.Xaml;
using Windows.Storage.Pickers;

namespace Vystral.App.Host;

/// <summary>System file dialogs. These are the only way a file path can enter VYSTRAL from the UI.</summary>
internal static class Pickers
{
    public static Task<string?> PickFileAsync(MainWindow window, string[] extensions) => window.OnUiAsync(async () =>
    {
        var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.ComputerFolder, ViewMode = PickerViewMode.List };
        foreach (var ext in extensions) picker.FileTypeFilter.Add(ext);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, Win32.GetHwnd(window));
        var file = await picker.PickSingleFileAsync();
        return file?.Path;
    });

    public static Task<string?> PickFolderAsync(MainWindow window) => window.OnUiAsync(async () =>
    {
        var picker = new FolderPicker { SuggestedStartLocation = PickerLocationId.PicturesLibrary };
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, Win32.GetHwnd(window));
        var folder = await picker.PickSingleFolderAsync();
        return folder?.Path;
    });

    public static Task<string?> PickSaveAsync(MainWindow window, string suggestedName, string extension, string description) =>
        window.OnUiAsync(async () =>
        {
            var picker = new FileSavePicker { SuggestedStartLocation = PickerLocationId.DocumentsLibrary, SuggestedFileName = suggestedName };
            picker.FileTypeChoices.Add(description, [extension]);
            WinRT.Interop.InitializeWithWindow.Initialize(picker, Win32.GetHwnd(window));
            var file = await picker.PickSaveFileAsync();
            return file?.Path;
        });
}
