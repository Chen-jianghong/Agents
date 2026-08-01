; ZaoHua Code — Windows 安装包脚本（Inno Setup 6）
#define MyAppName "ZaoHua Code"
#define MyAppVersion "0.1.0"
#define MyAppExeName "ZaoHua Code.exe"

[Setup]
AppId={{8E6F3C5A-2B44-4D9E-9A07-ZC0011223344}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=ZaoHua
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=..\release
OutputBaseFilename=ZaoHua-Code-Setup-0.1.0
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
PrivilegesRequired=lowest
SetupLogging=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "package\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 ZaoHua Code"; Flags: nowait postinstall skipifsilent
