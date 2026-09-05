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

[InstallDelete]
Type: filesandordirs; Name: "{app}\app"; Check: IsManagedUpgradeRoot
Type: filesandordirs; Name: "{app}\bin"; Check: IsManagedUpgradeRoot
Type: filesandordirs; Name: "{app}\runtime"; Check: IsManagedUpgradeRoot
Type: files; Name: "{app}\release-manifest.json"; Check: IsManagedUpgradeRoot
Type: files; Name: "{app}\sbom.spdx.json"; Check: IsManagedUpgradeRoot
Type: files; Name: "{app}\THIRD_PARTY_NOTICES.txt"; Check: IsManagedUpgradeRoot

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Eric Task Master Panel"; Filename: "{app}\bin\taskmaster.cmd"; Parameters: "panel"; WorkingDir: "{app}"; IconFilename: "{cmd}"; AppUserModelID: "NPCWorkspace.EricTaskMaster"

[Registry]
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\NPCWorkspace.EricTaskMaster"; ValueType: string; ValueName: "DisplayName"; ValueData: "Eric Task Master"; Flags: uninsdeletekey

[UninstallRun]
Filename: "{app}\bin\taskmaster.cmd"; Parameters: "manager stop --json"; Flags: runhidden shellexec waituntilterminated skipifdoesntexist; RunOnceId: "StopManager"

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

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  OldCli: string;
  StopScript: string;
  StopScriptContent: string;
  StopStarted: Boolean;
  ResultCode: Integer;
begin
  Result := '';
  if not IsManagedUpgradeRoot() then Exit;

  OldCli := ExpandConstant('{app}\bin\taskmaster.cmd');
  if not FileExists(OldCli) then
  begin
    Result := 'The previous Eric Task Master launcher is missing. Stop the previous Manager and remove the damaged application installation before retrying.';
    Exit;
  end;
  StopScript := ExpandConstant('{tmp}\eric-task-master-stop-old.cmd');
  StopScriptContent :=
    '@echo off'#13#10 +
    'setlocal'#13#10 +
    'set "NODE_OPTIONS="'#13#10 +
    'set "NODE_PATH="'#13#10 +
    'call "' + OldCli + '" manager stop --json'#13#10 +
    'exit /b %errorlevel%'#13#10;
  if not SaveStringToFile(StopScript, StopScriptContent, False) then
  begin
    Result := 'The installer could not prepare the previous Manager shutdown helper.';
    Exit;
  end;
  StopStarted := Exec(
    ExpandConstant('{cmd}'),
    '/d /s /c ""' + StopScript + '""',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
  DeleteFile(StopScript);
  if not StopStarted or
     (ResultCode <> 0) then
  begin
    Result := 'The previous Eric Task Master Manager could not be stopped safely. Close running tasks and retry the upgrade.';
    Exit;
  end;
  { Older launchers can report the closed port just before their Node process
    releases node.exe. Give that bounded teardown a chance to finish; the
    Restart Manager remains fail-closed if any process still owns the files. }
  Sleep(1000);
end;

function PathContains(Value, Wanted: string): Boolean;
var
  Remaining: string;
  Part: string;
  Split: Integer;
begin
  Result := False;
  Remaining := Value;
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
    if NormalizedPath(Part) = NormalizedPath(Wanted) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

procedure AddUserPath(Wanted: string);
var
  Current: string;
begin
  RegQueryStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', Current);
  if not PathContains(Current, Wanted) then
  begin
    if Current <> '' then
    begin
      if Current[Length(Current)] <> ';' then Current := Current + ';';
    end;
    RegWriteExpandStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', Current + Wanted);
  end;
end;

procedure RemoveUserPath(Wanted: string);
var
  Current: string;
  Remaining: string;
  Part: string;
  Updated: string;
  Split: Integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', Current) then Exit;
  Remaining := Current;
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
