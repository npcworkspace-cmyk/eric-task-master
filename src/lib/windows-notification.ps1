param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('setup', 'show', 'open-settings')]
  [string]$Mode,
  [string]$AppId = 'NPC.EricTaskMaster',
  [string]$DashboardUrlB64 = '',
  [string]$TitleB64 = '',
  [string]$MessageB64 = '',
  [string]$TargetUrlB64 = ''
)

$ErrorActionPreference = 'Stop'

function Decode-Base64Utf8([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Escape-Xml([string]$Value) {
  return [Security.SecurityElement]::Escape($Value)
}

if ($Mode -eq 'open-settings') {
  Start-Process 'ms-settings:notifications'
  exit 0
}

$dashboardUrl = Decode-Base64Utf8 $DashboardUrlB64
if ([string]::IsNullOrWhiteSpace($dashboardUrl)) {
  $dashboardUrl = 'http://127.0.0.1:19946/dashboard'
}
$shortcutDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $shortcutDirectory 'Eric Task Master.lnk'

if (-not ('EricTaskMaster.NotificationShortcut' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace EricTaskMaster {
  [ComImport]
  [Guid("00021401-0000-0000-C000-000000000046")]
  internal class ShellLink { }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("000214F9-0000-0000-C000-000000000046")]
  internal interface IShellLinkW {
    [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int maximum, IntPtr findData, uint flags);
    [PreserveSig] int GetIDList(out IntPtr itemIdList);
    [PreserveSig] int SetIDList(IntPtr itemIdList);
    [PreserveSig] int GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int maximum);
    [PreserveSig] int SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int maximum);
    [PreserveSig] int SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
    [PreserveSig] int GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int maximum);
    [PreserveSig] int SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
    [PreserveSig] int GetHotkey(out short hotkey);
    [PreserveSig] int SetHotkey(short hotkey);
    [PreserveSig] int GetShowCmd(out int showCommand);
    [PreserveSig] int SetShowCmd(int showCommand);
    [PreserveSig] int GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int maximum, out int iconIndex);
    [PreserveSig] int SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
    [PreserveSig] int SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    [PreserveSig] int Resolve(IntPtr window, uint flags);
    [PreserveSig] int SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("0000010B-0000-0000-C000-000000000046")]
  internal interface IPersistFile {
    [PreserveSig] int GetClassID(out Guid classId);
    [PreserveSig] int IsDirty();
    [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
    [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
    [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
    [PreserveSig] int GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  internal struct PropertyKey {
    internal Guid formatId;
    internal uint propertyId;

    internal PropertyKey(Guid formatId, uint propertyId) {
      this.formatId = formatId;
      this.propertyId = propertyId;
    }
  }

  [StructLayout(LayoutKind.Explicit)]
  internal struct PropVariant {
    [FieldOffset(0)] internal ushort valueType;
    [FieldOffset(8)] internal IntPtr pointerValue;
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  internal interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }

  public static class NotificationShortcut {
    private const ushort StringValueType = 31;
    private static PropertyKey AppUserModelId = new PropertyKey(
      new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    private static void Check(int result) {
      if (result < 0) Marshal.ThrowExceptionForHR(result);
    }

    public static void Activate(string appId) {
      Check(SetCurrentProcessExplicitAppUserModelID(appId));
    }

    public static void Create(string shortcutPath, string targetPath, string arguments, string appId) {
      object instance = new ShellLink();
      try {
        IShellLinkW shellLink = (IShellLinkW)instance;
        Check(shellLink.SetPath(targetPath));
        Check(shellLink.SetArguments(arguments));
        Check(shellLink.SetDescription("Eric Task Master notification center"));
        IPropertyStore propertyStore = (IPropertyStore)instance;
        PropVariant value = new PropVariant {
          valueType = StringValueType,
          pointerValue = Marshal.StringToCoTaskMemUni(appId)
        };
        try {
          Check(propertyStore.SetValue(ref AppUserModelId, ref value));
          Check(propertyStore.Commit());
        } finally {
          Marshal.FreeCoTaskMem(value.pointerValue);
        }
        Check(((IPersistFile)instance).Save(shortcutPath, true));
      } finally {
        if (Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance);
      }
      SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
    }

    public static string ReadAppId(string shortcutPath) {
      object instance = new ShellLink();
      try {
        Check(((IPersistFile)instance).Load(shortcutPath, 0));
        IPropertyStore propertyStore = (IPropertyStore)instance;
        PropVariant value;
        Check(propertyStore.GetValue(ref AppUserModelId, out value));
        try {
          if (value.valueType != StringValueType || value.pointerValue == IntPtr.Zero) return null;
          return Marshal.PtrToStringUni(value.pointerValue);
        } finally {
          PropVariantClear(ref value);
        }
      } finally {
        if (Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance);
      }
    }
  }
}
"@
}

function Register-NotificationApp {
  New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
  $escapedDashboard = $dashboardUrl.Replace("'", "''")
  $arguments = "-NoLogo -NoProfile -WindowStyle Hidden -Command `"Start-Process '$escapedDashboard'`""
  [EricTaskMaster.NotificationShortcut]::Create(
    $shortcutPath,
    (Join-Path $PSHOME 'powershell.exe'),
    $arguments,
    $AppId
  )
  $registeredId = [EricTaskMaster.NotificationShortcut]::ReadAppId($shortcutPath)
  if ($registeredId -ne $AppId) { exit 20 }

  $registrationPath = "HKCU:\Software\Classes\AppUserModelId\$AppId"
  New-Item -Path $registrationPath -Force | Out-Null
  New-ItemProperty -Path $registrationPath -Name 'DisplayName' -Value 'Eric Task Master' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registrationPath -Name 'ShowInSettings' -Value 1 -PropertyType DWord -Force | Out-Null
}

function Get-Notifier {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
  [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
  [EricTaskMaster.NotificationShortcut]::Activate($AppId)
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
  try {
    if ($notifier.get_Setting().ToString() -ne 'Enabled') { exit 21 }
  } catch [System.Management.Automation.MethodInvocationException] {
    # Some Windows 11 builds do not materialize a fresh desktop AppUserModelID
    # in Notification Settings until its first successful toast. Let Show()
    # perform that first registration; it still fails closed if Windows rejects it.
    if ($_.Exception.InnerException.HResult -ne -2147023728) { throw }
  }
  return $notifier
}

Register-NotificationApp
if ($Mode -eq 'setup') { exit 0 }
$notifier = Get-Notifier

$title = Decode-Base64Utf8 $TitleB64
$message = Decode-Base64Utf8 $MessageB64
$targetUrl = Decode-Base64Utf8 $TargetUrlB64
$activation = if ([string]::IsNullOrWhiteSpace($targetUrl)) { $dashboardUrl } else { $targetUrl }
$safeTitle = Escape-Xml $title
$safeMessage = Escape-Xml $message
$safeActivation = Escape-Xml $activation
$toastSource = "<toast activationType=`"protocol`" launch=`"$safeActivation`"><visual><binding template=`"ToastGeneric`"><text>$safeTitle</text><text>$safeMessage</text></binding></visual><actions><action content=`"Open Task`" arguments=`"$safeActivation`" activationType=`"protocol`" /></actions></toast>"
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($toastSource)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier.Show($toast)
exit 0
