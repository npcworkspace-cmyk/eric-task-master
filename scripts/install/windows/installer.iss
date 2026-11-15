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
Source: "{#SourceRoot}\app\src\lib\replace-legacy-launcher.ps1"; Flags: dontcopy
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

var
  ActivateUpgrade: Boolean;
  ActivationFailed: Boolean;

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

function RuntimeInspectionStatus(GuardPath: string): Integer;
var
  ResultCode: Integer;
begin
  Result := 11;
  if FileExists(GuardPath) and Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + GuardPath +
      '" -AppRoot "' + ExpandConstant('{app}') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode
  ) then Result := ResultCode;
end;

function CheckRuntimeIdle(GuardPath: string): Boolean;
begin
  Result := RuntimeInspectionStatus(GuardPath) = 0;
end;

function StopSelectedManager(OnlyIfIdle: Boolean): Boolean;
var
  LauncherPath: string;
  Parameters: string;
  ResultCode: Integer;
begin
  LauncherPath := ExpandConstant('{app}\bin\taskmaster.cmd');
  if not FileExists(LauncherPath) then LauncherPath := ExpandConstant('{app} v3\bin\taskmaster.cmd');
  if not FileExists(LauncherPath) then begin Result := False; Exit; end;
  Parameters := '/D /S /C ""' + LauncherPath + '" manager stop';
  if OnlyIfIdle then Parameters := Parameters + ' --if-idle';
  Parameters := Parameters + ' --json"';
  Result := Exec(ExpandConstant('{cmd}'), Parameters, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function CheckLegacyLauncher(Mode: string): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\replace-legacy-launcher.ps1') +
      '" -AppRoot "' + ExpandConstant('{app}') + '" -NewVersion "{#ProductVersion}" -Mode ' + Mode,
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode
  ) and (ResultCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Inspection: Integer;
begin
  Result := '';
  ActivateUpgrade := IsManagedUpgradeRoot() or
    FileExists(ExpandConstant('{app}\release-manifest.json')) or
    FileExists(ExpandConstant('{app} v3\release-manifest.json')) or
    FileExists(ExpandConstant('{app} v3\.taskmaster-legacy.json'));
  ExtractTemporaryFile('assert-runtime-idle.ps1');
  ExtractTemporaryFile('replace-legacy-launcher.ps1');
  if not CheckLegacyLauncher('Validate') then
    Result := 'Existing Task Master installations could not be safely replaced or are newer. No legacy files were moved; inspect the installation before retrying.'
  else
  begin
    Inspection := RuntimeInspectionStatus(ExpandConstant('{tmp}\assert-runtime-idle.ps1'));
    if Inspection = 10 then
    begin
      if StopSelectedManager(True) then
        Inspection := RuntimeInspectionStatus(ExpandConstant('{tmp}\assert-runtime-idle.ps1'));
      if Inspection = 10 then
      begin
        if WizardSilent then
          Result := 'Task Master is busy. Ask the Owner to wait or explicitly stop the selected Manager and its work; no force stop was performed.'
        else if MsgBox('Task Master is still working. Stop the selected Manager and its tasks and Profile windows now to install the new version? Unconfirmed external actions may have an unknown result and must be checked before retrying. Choose No to leave the work running and cancel this upgrade.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        begin
          if StopSelectedManager(False) then
            Inspection := RuntimeInspectionStatus(ExpandConstant('{tmp}\assert-runtime-idle.ps1'))
          else
            Result := 'The selected Manager could not be stopped safely. Installation was not started.';
        end
        else
          Result := 'Upgrade cancelled. Existing work was not force-stopped.';
      end;
    end;
    if (Result = '') and (Inspection <> 0) then
      Result := 'Task Master runtime remains in use or could not be inspected. Installation was not started; retain existing work and data.';
    if (Result = '') and not CheckLegacyLauncher('Apply') then
      Result := 'The legacy Task Master launcher could not be safely replaced. Installation was not started; preserve user data and inspect the old path.';
  end;
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
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    AddUserPath(ExpandConstant('{app}\bin'));
    if ActivateUpgrade then
    begin
      ActivationFailed := not Exec(
        ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
        '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\app\src\lib\activate-upgrade.ps1') +
          '" -AppRoot "' + ExpandConstant('{app}') + '" -ExpectedVersion "{#ProductVersion}"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode
      ) or (ResultCode <> 0);
      if ActivationFailed then
      begin
        Log('Application files were installed but Manager/Skill activation failed. The upgrade is incomplete.');
        if not WizardSilent then
          MsgBox('Task Master files were installed, but Manager and Skill activation did not complete. Keep existing data and run the new launcher with manager start --upgrade --json after resolving the condition.', mbError, MB_OK);
      end;
    end;
  end;
end;

function GetCustomSetupExitCode(): Integer;
begin
  if ActivationFailed then Result := 20 else Result := 0;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then RemoveUserPath(ExpandConstant('{app}\bin'));
end;
