package language

type Text int

const (
	Open Text = iota
	CheckingHealth
	Refresh
	Modules
	CheckingModules
	ServiceKeepsRunning
	RetryStart
	Restart
	InstallService
	BackgroundService
	Settings
	Quit
	Running
	Offline
	ModuleDetail
	Reason
	ModuleStatus
	Sessions
	Lark
	Agents
	Ready
	Disabled
	Connecting
	Reconnecting
	Failed
	Stopped
	Refreshing
	SignedOut
	Stale
	Error
	Idle
	StartService
	RestartService
	StartingService
	RestartingService
	InstallingService
	StartRequested
	RestartRequested
	AutoInstalled
	Installed
	ActionFailed
	CurrentVersion
	CheckUpdate
	InstallUpdate
	InstallVersion
	UpdateDetails
	SoftwareUpdates
	CheckingUpdate
	UpdateAvailable
	UpToDate
	CheckFailed
	Downloading
	DownloadPercent
	Installing
	InstallFailed
	Restarting
	About
	Services
	Hide
	HideOthers
	File
	CloseWindow
	Edit
	Undo
	Redo
	Cut
	Copy
	Paste
	SelectAll
	ViewMenu
	Fullscreen
	Window
	Minimize
	Zoom
	Help
)

var catalog = [][2]string{
	Open:                {"Open Nootify", "打开 Nootify"},
	CheckingHealth:      {"Nootify · Checking…", "Nootify · 检查中…"},
	Refresh:             {"Refresh Status", "刷新状态"},
	Modules:             {"Module Status", "模块状态"},
	CheckingModules:     {"Checking…", "正在检查…"},
	ServiceKeepsRunning: {"Service keeps running after quit", "退出后服务仍会运行"},
	RetryStart:          {"Retry Start", "重试启动"},
	Restart:             {"Restart", "重新启动"},
	InstallService:      {"Install Background Service", "安装后台服务"},
	BackgroundService:   {"Background Service", "后台服务"},
	Settings:            {"Settings…", "设置…"},
	Quit:                {"Quit Nootify", "退出 Nootify"},
	Running:             {"Nootify · Running", "Nootify · 运行中"},
	Offline:             {"Nootify · Not Connected", "Nootify · 未连接"},
	ModuleDetail:        {"Modules: {modules}", "模块：{modules}"},
	Reason:              {"Reason: {error}", "原因：{error}"},
	ModuleStatus:        {"{name}: {status}", "{name}：{status}"},
	Sessions:            {"Sessions", "会话"},
	Lark:                {"Feishu", "飞书"},
	Agents:              {"Agents", "Agents"},
	Ready:               {"Ready", "就绪"},
	Disabled:            {"Disabled", "未启用"},
	Connecting:          {"Connecting", "连接中"},
	Reconnecting:        {"Reconnecting", "重新连接中"},
	Failed:              {"Failed", "失败"},
	Stopped:             {"Stopped", "已停止"},
	Refreshing:          {"Refreshing", "刷新中"},
	SignedOut:           {"Signed Out", "未登录"},
	Stale:               {"Out of Date", "数据已过期"},
	Error:               {"Error", "出错"},
	Idle:                {"Idle", "空闲"},
	StartService:        {"Start service", "启动服务"},
	RestartService:      {"Restart service", "重启服务"},
	StartingService:     {"Starting background service…", "正在启动后台服务…"},
	RestartingService:   {"Restarting service…", "正在重启服务…"},
	InstallingService:   {"Installing background service…", "正在安装后台服务…"},
	StartRequested:      {"Background service start requested", "已请求启动后台服务"},
	RestartRequested:    {"Service restart requested", "已请求重启服务"},
	AutoInstalled:       {"Background service installed and running", "后台服务已自动安装并运行"},
	Installed:           {"Background service installed and running", "后台服务已安装并运行"},
	ActionFailed:        {"{action} failed: {error}", "{action}失败：{error}"},
	CurrentVersion:      {"Current version {version}", "当前版本 {version}"},
	CheckUpdate:         {"Check for Updates…", "检查更新…"},
	InstallUpdate:       {"Install Update", "安装更新"},
	InstallVersion:      {"Install Update {version}", "安装更新 {version}"},
	UpdateDetails:       {"Update Details…", "更新详情…"},
	SoftwareUpdates:     {"Software Updates", "软件更新"},
	CheckingUpdate:      {"Checking for updates…", "检查更新中…"},
	UpdateAvailable:     {"Update available: {version}", "可更新至 {version}"},
	UpToDate:            {"Up to date: {version}", "已是最新 {version}"},
	CheckFailed:         {"Check failed. Try again.", "检查失败，请重试"},
	Downloading:         {"Downloading…", "下载中…"},
	DownloadPercent:     {"Downloading {percent}%", "下载中 {percent}%"},
	Installing:          {"Installing…", "安装中…"},
	InstallFailed:       {"Install failed. Try again.", "安装失败，请重试"},
	Restarting:          {"Restarting…", "重启中…"},
	About:               {"About Nootify", "关于 Nootify"},
	Services:            {"Services", "服务"},
	Hide:                {"Hide Nootify", "隐藏 Nootify"},
	HideOthers:          {"Hide Others", "隐藏其他"},
	File:                {"File", "文件"},
	CloseWindow:         {"Close Window", "关闭窗口"},
	Edit:                {"Edit", "编辑"},
	Undo:                {"Undo", "撤销"},
	Redo:                {"Redo", "重做"},
	Cut:                 {"Cut", "剪切"},
	Copy:                {"Copy", "复制"},
	Paste:               {"Paste", "粘贴"},
	SelectAll:           {"Select All", "全选"},
	ViewMenu:            {"View", "显示"},
	Fullscreen:          {"Enter Full Screen", "进入全屏幕"},
	Window:              {"Window", "窗口"},
	Minimize:            {"Minimize", "最小化"},
	Zoom:                {"Zoom", "缩放"},
	Help:                {"Help", "帮助"},
}

func (l Locale) Text(key Text) string {
	if int(key) < 0 || int(key) >= len(catalog) {
		return ""
	}
	if l == ZH {
		return catalog[key][1]
	}
	return catalog[key][0]
}
