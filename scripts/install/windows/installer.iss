#ifndef SourceRoot
  #error SourceRoot is required
#endif
#ifndef ProductVersion
  #error ProductVersion is required
#endif
#ifndef OutputDirectory
  #error OutputDirectory is required
#endif

[Setup]
AppId={{2DE24E8C-971F-4E00-9E32-9F66822B9CB7}
AppName=Eric Task Master
AppVersion={#ProductVersion}
AppPublisher=NPC Workspace
DefaultDirName={localappdata}\Programs\Eric Task Master
DefaultGroupName=Eric Task Master
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDirectory}
OutputBaseFilename=eric-task-master-v{#ProductVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
UninstallDisplayName=Eric Task Master
CloseApplications=no
RestartApplications=no

[InstallDelete]
Type: filesandordirs; Name: "{app}\app"; Check: IsManagedUpgradeRoot
Type: filesandordirs; Name: "{app}\bin"; Check: IsManagedUpgradeRoot
Type: filesandordirs; Name: "{app}\runtime"; Check: IsManagedUpgradeRoot
Type: files; Name: "{app}\release-manifest.json"; Check: IsManagedUpgradeRoot
Type: files; Name: "{app}\sbom.spdx.json"; Check: IsManagedUpgradeRoot
Type: files; Name: "{app}\THIRD_PARTY_NOTICES.txt"; Check: IsManagedUpgradeRoot

[Files]
Source: "{#SourceRoot}\app\src\lib\assert-runtime-idle.ps1"; Flags: dontcopy
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Eric Task Master Panel"; Filename: "{app}\bin\taskmaster.cmd"; Parameters: "panel"; WorkingDir: "{app}"; IconFilename: "{cmd}"; AppUserModelID: "NPCWorkspace.EricTaskMaster"

[Registry]
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\NPCWorkspace.EricTaskMaster"; ValueType: string; ValueName: "DisplayName"; ValueData: "Eric Task Master"; Flags: uninsdeletekey

[UninstallDelete]
Type: files; Name: "{userprograms}\Eric Task Master\Eric Task Master Notifications.lnk"

[Code]
const
  UserEnvironmentKey = 'Environment';

function NormalizedPath(Value: string): string;
begin
  Result := Lowercase(RemoveBackslashUnlessRoot(Trim(Value)));
end;

function IsManagedUpgradeRoot(): Boolean;
var
  PreviousRoot: string;
begin
  Result :=
    RegQueryStringValue(
      HKEY_CURRENT_USER,
      'Software\Microsoft\Windows\CurrentVersion\Uninstall\{2DE24E8C-971F-4E00-9E32-9F66822B9CB7}_is1',
      'InstallLocation',
      PreviousRoot
    ) and
    (NormalizedPath(PreviousRoot) = NormalizedPath(ExpandConstant('{app}')));
end;

function CheckRuntimeIdle(GuardPath: string): Boolean;
var
  ResultCode: Integer;
begin
  Result := FileExists(GuardPath) and Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + GuardPath +
      '" -AppRoot "' + ExpandConstant('{app}') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode
  ) and (ResultCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  ExtractTemporaryFile('assert-runtime-idle.ps1');
  if not CheckRuntimeIdle(ExpandConstant('{tmp}\assert-runtime-idle.ps1')) then
    Result := 'Eric Task Master runtime is still in use or could not be inspected. No Agent was stopped. Finish tasks, close Profiles, explicitly stop the idle Manager, then retry.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := CheckRuntimeIdle(ExpandConstant('{app}\app\src\lib\assert-runtime-idle.ps1'));
  if not Result and not UninstallSilent then
    MsgBox('Eric Task Master runtime is still in use or could not be inspected. Finish tasks and explicitly stop the idle Manager before uninstalling.', mbError, MB_OK);
end;

function RemovePathEntry(Value, Wanted: string): string;
var
  Remaining: string;
  Part: string;
  Updated: string;
  Split: Integer;
begin
  Remaining := Value;
  Updated := '';
  while Remaining <> '' do
  begin
    Split := Pos(';', Remaining);
    if Split = 0 then
    begin
      Part := Remaining;
      Remaining := '';
    end
    else
    begin
      Part := Copy(Remaining, 1, Split - 1);
      Delete(Remaining, 1, Split);
    end;
    if (Part <> '') and (NormalizedPath(Part) <> NormalizedPath(Wanted)) then
    begin
      if Updated <> '' then Updated := Updated + ';';
      Updated := Updated + Part;
    end;
  end;
  Result := Updated;
end;

procedure AddUserPath(Wanted: string);
var
  Current: string;
  Remaining: string;
  Updated: string;
begin
  RegQueryStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', Current);
  Remaining := RemovePathEntry(Current, Wanted);
  Updated := Wanted;
  if Remaining <> '' then Updated := Updated + ';' + Remaining;
  RegWriteExpandStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', Updated);
end;

procedure RemoveUserPath(Wanted: string);
var
  Current: string;
  Updated: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', Current) then Exit;
  Updated := RemovePathEntry(Current, Wanted);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', Updated);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then AddUserPath(ExpandConstant('{app}\bin'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then RemoveUserPath(ExpandConstant('{app}\bin'));
end;
