const REQUEST_TIMEOUT_MS = 10_000;
const READ_RETRY_DELAY_MS = 300;
const TASK_PAGE_SIZE = 50;
const TASK_BATCH_CONCURRENCY = 4;
const LANGUAGE_STORAGE_KEY = 'eric-task-master-language';
const VIEWS = new Set(['tasks', 'profiles', 'assets', 'settings']);
const ACTIVE_TASK_STATES = new Set([
  'queued', 'acquiring_profile', 'starting_browser', 'running', 'cooling_down',
  'recovering', 'verifying', 'pause_requested', 'cancel_requested', 'cancelling'
]);
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled', 'terminated']);
const PAUSABLE_TASK_STATES = new Set(['running', 'cooling_down', 'recovering', 'verifying']);
const TASK_STATE_KEYS = Object.freeze({
  queued: 'state.queued', acquiring_profile: 'state.acquiringProfile', starting_browser: 'state.startingBrowser',
  running: 'state.running', pause_requested: 'state.pauseRequested', paused: 'state.paused',
  waiting_user: 'state.waitingUser', cooling_down: 'state.coolingDown', recovering: 'state.recovering',
  verifying: 'state.verifying', cancel_requested: 'state.cancelRequested', cancelling: 'state.cancelling',
  completed: 'state.completed', failed: 'state.failed', cancelled: 'state.cancelled', terminated: 'state.cancelled'
});
const ACTIVITY_KEYS = Object.freeze({
  queued: 'activity.queued', acquiring_profile: 'activity.acquiringProfile', starting_browser: 'activity.startingBrowser',
  navigating: 'activity.navigating', clicking: 'activity.clicking', typing: 'activity.typing', hovering: 'activity.hovering',
  scrolling: 'activity.scrolling', extracting: 'activity.extracting', analyzing: 'activity.analyzing', working: 'activity.working',
  running: 'activity.running', waiting_user: 'activity.waitingUser', cooling_down: 'activity.coolingDown',
  recovering: 'activity.recovering', verifying: 'activity.verifying', reporting: 'activity.reporting',
  cleaning_up: 'activity.cleaningUp', paused: 'activity.paused', completed: 'activity.completed', failed: 'activity.failed',
  cancel_requested: 'activity.cancelRequested', cancelling: 'activity.cancelling', cancelled: 'activity.cancelled'
});

const I18N = Object.freeze({
  'zh-CN': Object.freeze({
    'page.title': 'Eric Task Master · 本机任务面板', 'skip.main': '跳到主要内容', 'brand.home': 'Eric Task Master 任务面板首页',
    'nav.primary': '主要导航', 'nav.tasks': '任务', 'nav.profiles': 'Profiles', 'nav.assets': 'Task Packs', 'nav.settings': '设置',
    'common.loading': '读取中', 'common.close': '关闭', 'common.delete': '删除', 'common.status': '状态',
    'connection.connecting': '正在连接本机 Manager', 'connection.online': '本机 Manager 在线', 'connection.ownerRequired': '需要建立 Owner 会话',
    'connection.stale': '连接中断 · 自动重试', 'connection.never': '尚未刷新', 'connection.refreshed': '刷新于 {time}',
    'refresh.aria': '刷新任务、Profiles、执行器资产和通知', 'refresh.title': '刷新全部面板数据',
    'auth.logout': '退出', 'auth.requiredTitle': '此浏览器尚未建立 Owner 会话',
    'auth.requiredBody': '请从部署完成页打开一次面板。首次可信连接后，这个固定地址可以直接收藏使用。',
    'auth.retry': '重新检查连接', 'stale.title': '实时连接暂时中断',
    'stale.body': '正在保留上次成功状态并自动重试，不会中断后台任务。', 'stale.retry': '立即重试',
    'tasks.title': '任务进度', 'tasks.description': '查看 Agent 正在做什么，并可暂停、恢复、取消或删除已结束的任务记录。',
    'tasks.loading': '正在读取任务…', 'tasks.authEmpty': '建立 Owner 会话后即可查看任务。', 'tasks.empty': '当前还没有任务。',
    'tasks.active': '{active} 个进行中 · {total} 个任务', 'tasks.inProgress': '进行中', 'tasks.progressAria': '{title}进度',
    'tasks.progressUnknown': '正在执行，尚无总量', 'tasks.runTime': '运行时间', 'tasks.cooldownTime': '冷却时间',
    'tasks.totalTime': '总时间', 'tasks.report': '查看 Agent 最终报告', 'tasks.lastFeedback': '最近反馈 {time}',
    'tasks.targetMissing': '指定的任务记录不存在或已删除', 'task.untitled': '未命名任务', 'task.waitingFeedback': '等待反馈',
    'tasks.bulk': '任务批量管理', 'tasks.bulkActions': '任务批量操作', 'tasks.selectAll': '全选已加载任务',
    'tasks.selectAria': '选择任务 {title}', 'tasks.noneSelected': '尚未选择任务', 'tasks.selected': '已选择 {count} 个任务',
    'tasks.bulkPause': '批量暂停', 'tasks.bulkResume': '批量恢复', 'tasks.bulkCancel': '批量取消', 'tasks.bulkDelete': '批量删除记录',
    'tasks.loadMore': '加载更多任务', 'tasks.loadingMore': '正在加载更多任务…', 'tasks.pageLoaded': '已加载 {count} 个任务',
    'tasks.pageMore': '已加载 {count} 个任务 · 还有更多', 'tasks.batchRunning': '正在逐项执行 {action}…',
    'tasks.batchDone': '{success} 项成功 · {failed} 项失败 · {skipped} 项跳过',
    'tasks.batchSuccess': '已完成', 'tasks.batchSkipped': '当前状态不支持此操作', 'tasks.batchFailed': '失败：{message}',
    'tasks.actionPause': '暂停', 'tasks.actionResume': '恢复', 'tasks.actionCancel': '取消', 'tasks.actionDelete': '删除记录',
    'state.queued': '排队中', 'state.acquiringProfile': '准备 Profile', 'state.startingBrowser': '启动浏览器', 'state.running': '执行中',
    'state.pauseRequested': '正在暂停', 'state.paused': '已暂停', 'state.waitingUser': '等待处理', 'state.coolingDown': '限流冷却',
    'state.recovering': '恢复中', 'state.verifying': '验收中', 'state.cancelRequested': '正在取消', 'state.cancelling': '正在取消',
    'state.completed': '已完成', 'state.failed': '失败', 'state.cancelled': '已取消',
    'activity.queued': '等待调度', 'activity.acquiringProfile': '准备 Profile', 'activity.startingBrowser': '启动浏览器',
    'activity.navigating': '正在打开页面', 'activity.clicking': '正在点击', 'activity.typing': '正在输入', 'activity.hovering': '正在悬停',
    'activity.scrolling': '正在滚动页面', 'activity.extracting': '正在提取内容', 'activity.analyzing': '正在分析',
    'activity.working': '正在执行', 'activity.running': '正在执行任务', 'activity.waitingUser': '等待 Agent 处理',
    'activity.coolingDown': '正在等待限流恢复', 'activity.recovering': '正在从检查点恢复', 'activity.verifying': '正在验收结果',
    'activity.reporting': '正在收尾', 'activity.cleaningUp': '正在关闭任务窗口', 'activity.paused': '任务已暂停',
    'activity.completed': '任务已完成', 'activity.failed': '任务失败', 'activity.cancelRequested': '正在安全取消任务',
    'activity.cancelling': '正在安全取消任务', 'activity.cancelled': '任务已取消',
    'behavior.fast': '快速', 'behavior.auto': '自动', 'behavior.autoBalanced': '自动平衡', 'behavior.human': '深度拟人',
    'behavior.fastPace': '快速节奏', 'behavior.cautiousPace': '谨慎节奏', 'behavior.humanPace': '深度拟人节奏',
    'behavior.unassigned': '待分配', 'behavior.unapplied': '待应用', 'behavior.actual': '实际行为',
    'behavior.workerConfirmed': 'Worker 已确认 · {time}', 'behavior.workerWaiting': '等待 Worker 应用',
    'actions.pause': '暂停', 'actions.resume': '恢复', 'actions.cancel': '取消', 'actions.deleteRecord': '删除记录',
    'actions.cleanupFirst': '任务清理完成后才能删除记录',
    'profiles.title': '浏览器 Profiles', 'profiles.description': '管理独立浏览器环境。任务按 Profile 串行，彼此不会抢占登录状态。',
    'profiles.new': '新建 Profile', 'profiles.createTitle': '创建浏览器环境', 'profiles.name': 'Profile 名称',
    'profiles.namePlaceholder': '例如：工作账号', 'profiles.kind': '类型', 'profiles.persistent': '持久登录',
    'profiles.ephemeral': '临时无登录', 'profiles.browser': '浏览器', 'profiles.chrome': '本机稳定版 Chrome',
    'profiles.chromium': '项目锁定 Chromium', 'profiles.speed': '操作速度', 'profiles.background': '任务在后台运行',
    'profiles.extensions': '允许扩展运行', 'profiles.extensionsNextLaunch': '下次打开 Profile 或启动任务时生效',
    'profiles.extensionsDeferred': '当前窗口不会重启；关闭后再次打开或下次任务启动时生效',
    'profiles.extensionsVisibleOnly': '扩展需要可见浏览器；关闭扩展后可启用后台运行',
    'profiles.create': '创建 Profile', 'profiles.formNote': '持久 Profile 默认允许已安装扩展在可见浏览器中运行；临时 Profile 不加载扩展，并在任务结束后销毁浏览器状态。',
    'profiles.loading': '正在读取 Profiles…', 'profiles.authEmpty': '建立 Owner 会话后即可查看 Profiles。',
    'profiles.empty': '还没有 Profile。创建一个浏览器环境开始任务。', 'profiles.browserFact': '浏览器',
    'profiles.speedFact': '操作速度', 'profiles.recent': '最近使用', 'profiles.speedLive': '运行中切换会立即应用到当前任务，无需重启',
    'profiles.speedChoose': '为这个 Profile 选择快速、自动平衡或深度拟人', 'profiles.rename': '改名',
    'profiles.closeWindow': '关闭窗口', 'profiles.openWindow': '打开登录窗口', 'profiles.taskOnly': '仅任务启动',
    'profiles.openTitle': '打开独立可见 Chrome 窗口进行人工登录或检查', 'profiles.taskOnlyTitle': '临时 Profile 只在任务中启动',
    'profiles.cleanupResidual': '清理残留', 'profiles.cleanupResidualTitle': '任务清理未确认；Manager 会再次确认 Worker 已退出且临时目录为空后再清理',
    'profiles.deleteBusy': 'Profile 空闲后才能删除', 'profiles.deleteTitle': '删除这个 Profile',
    'profileState.idle': '空闲', 'profileState.closed': '已关闭', 'profileState.open': '人工打开', 'profileState.leased': '任务占用',
    'profileState.starting': '启动中', 'profileState.error': '需检查',
    'assets.title': '执行器资产', 'assets.description': '看清每个 Task Pack 或脚本能做什么、Agent 能否发现、使用情况与清理风险；支持备注和批量管理。',
    'assets.toolbar': '执行器资产筛选和批量操作', 'assets.search': '搜索资产', 'assets.searchPlaceholder': '名称、用途、备注或任务类型',
    'assets.all': '全部资产', 'assets.discoverable': 'Agent 可发现', 'assets.deprecated': '已废弃', 'assets.history': '历史与孤立文件',
    'assets.protected': '系统保护', 'assets.selectAll': '全选当前结果', 'assets.bulk': '批量管理', 'assets.note': '批量备注',
    'assets.deprecate': '废弃', 'assets.restore': '恢复', 'assets.noneSelected': '尚未选择资产', 'assets.loading': '正在读取执行器资产…',
    'assets.selected': '已选择 {count} 项 · 删除动作仍会由 Manager 重新检查任务与恢复状态',
    'assets.authEmpty': '建立 Owner 会话后即可查看执行器资产。', 'assets.empty': '当前筛选没有匹配的执行器资产。',
    'assets.selectAria': '选择 {title}', 'assets.agentVisible': 'Agent 可发现', 'assets.agentHidden': 'Agent 不可发现',
    'assets.active': '使用中', 'assets.retired': '仅历史', 'assets.purposeMissing': '未填写用途说明；建议通过资产备注补充给后续维护者。',
    'assets.version': '版本', 'assets.taskTypes': '任务类型', 'assets.runs': '运行次数', 'assets.successFailure': '成功 / 失败',
    'assets.lastUsed': '最后使用', 'assets.size': '文件体积', 'assets.fileCount': '{count} 个 · {size}', 'assets.assetNote': '资产备注',
    'assets.noNote': '暂无备注', 'assets.containsTypes': '包含 {count} 个任务类型', 'assets.blocked': '不可删除：{reasons}',
    'assets.viewTask': '查看关联任务', 'assets.moreBlockers': '另有 {count} 个关联任务',
    'assets.blocker.active_task': '任务仍在运行', 'assets.blocker.cleanup_pending': '任务清理尚未确认',
    'assets.blocker.resume_available': '任务仍可从检查点恢复', 'assets.blocker.protected': '系统保护',
    'assets.count': '{visible} / {total} 项资产',
    'notifications.open': '打开通知', 'notifications.close': '关闭通知', 'notifications.title': '通知', 'notifications.loading': '正在读取通知…',
    'notifications.markAll': '全部标为已读', 'notifications.none': '当前没有需要处理的通知。',
    'notifications.summary': '{unread} 条未读 · {total} 条通知', 'notifications.reminders': '已提醒 {count} 次',
    'notifications.takeOver': '我已接手', 'notifications.focus': '打开验证窗口', 'notifications.continue': '验证完成继续',
    'notifications.read': '标为已读', 'notifications.claimed': '已标记为人工接手', 'notifications.focused': '正在打开验证窗口',
    'notifications.continued': '已确认验证完成，原任务将继续', 'notifications.readDone': '通知已读',
    'notifications.syncDegraded': '主任务操作已成功，但通知状态暂时同步失败；Manager 会自动重试。',
    'notifications.allRead': '全部通知已标为已读', 'notifications.verification': '需要人工验证', 'notifications.notice': '任务通知',
    'notifications.defaultTitle': '任务需要处理', 'notifications.defaultMessage': '请打开任务窗口完成必要操作。',
    'settings.title': '通知设置', 'settings.description': '只管理需要人工验证时的三种通知方式。',
    'settings.system': '系统通知', 'settings.feishu': '飞书', 'settings.enable': '启用', 'settings.test': '发送测试',
    'settings.systemDescription': '通过本机系统弹窗提醒人工接手验证。',
    'settings.telegramDescription': '将人工验证提醒发送到指定 Telegram 会话。',
    'settings.feishuDescription': '通过飞书或 Lark Webhook 提醒人工接手验证。',
    'settings.telegramToken': 'Bot Token（留空保留原配置）', 'settings.telegramChat': 'Chat ID（留空保留原配置）',
    'settings.feishuWebhook': 'Webhook（留空保留原配置）', 'settings.feishuSigningSecret': '签名密钥（可选，留空保留原配置）', 'settings.secretPlaceholder': '不会回填已保存密钥',
    'settings.destinationPlaceholder': '不会回填已保存目标', 'settings.maskedNote': '已保存的密钥只显示掩码，面板永远不会回填原文。',
    'settings.save': '保存通知设置', 'settings.configured': '已配置 {target}', 'settings.notConfigured': '尚未配置',
    'settings.systemReady': '本机系统通知', 'settings.saved': '通知设置已保存', 'settings.testSent': '{channel} 测试通知已发送',
    'settings.clearCredentials': '清除凭据', 'settings.cleared': '{channel} 凭据已清除', 'settings.openSystem': '打开系统设置',
    'settings.systemOpened': '已打开系统通知设置', 'settings.status.ready': '已就绪', 'settings.status.needs_setup': '待配置或测试',
    'settings.status.permission_blocked': '系统通知权限已关闭', 'settings.status.unavailable': '当前系统不可用',
    'settings.status.test_failed': '最近测试失败', 'settings.signed': '已启用签名', 'settings.lastTestOk': '最近测试通过 {time}', 'settings.lastTestFailed': '最近测试失败 {time}',
    'error.request': '请求失败 ({status})', 'error.timeout': '本机 Manager 10 秒内没有响应', 'error.network': '无法连接本机 Manager',
    'error.read': '读取失败', 'error.operation': '操作失败', 'error.denied': '没有权限执行这项操作：{message}',
    'error.profileName': 'Profile 名称已存在，请换一个名称。', 'error.revision': '状态已变化，已刷新最新状态。请确认后重试。',
    'error.refreshed': '{message} 已刷新最新状态。', 'time.justNow': '刚刚', 'time.soon': '即将', 'time.days': '{days}天 {clock}',
    'toast.profileCreated': 'Profile 已创建', 'toast.speedApplied': '操作速度已生效，运行中的任务无需重启',
    'toast.extensionsSaved': '扩展设置已保存；下次启动生效', 'toast.extensionsDeferred': '扩展设置已保存；当前窗口不会重启，关闭后生效',
    'toast.profileSaved': 'Profile 设置已保存', 'toast.profileOpening': '正在打开独立登录窗口', 'toast.profileClosed': 'Profile 窗口已关闭',
    'toast.profileResidualCleaned': '残留临时 Profile 已清理', 'toast.profileDeleted': 'Profile 已删除',
    'toast.taskNotReady': '任务版本尚未就绪，正在刷新最新状态', 'toast.pauseSent': '暂停请求已发送',
    'toast.resumeSent': '恢复请求已发送', 'toast.cancelSent': '取消请求已发送', 'toast.taskDeleted': '任务记录已删除',
    'toast.noteSaved': '资产备注已保存', 'toast.assetsDeprecated': '所选资产已废弃，Agent 不再发现它们',
    'toast.assetsRestored': '所选资产已恢复为可发现', 'toast.assetsDeleted': '所选执行器资产已安全删除',
    'toast.loggedOut': '已退出；后台任务仍在继续', 'toast.logoutFailed': '退出失败', 'toast.ownerFailed': '无法建立 Owner 会话',
    'prompt.renameProfile': '新的 Profile 名称', 'prompt.assetNote': '填写资产备注（留空可清除备注）',
    'confirm.cleanupProfile': '确定清理异常临时 Profile“{name}”？Manager 只会在 Worker 已退出且目录为空时执行。',
    'confirm.deleteProfile': '确定删除 Profile“{name}”及其{description}？此操作无法撤销。',
    'confirm.ephemeralData': '临时任务设置', 'confirm.persistentData': '持久浏览器数据',
    'confirm.cancelTask': '确定取消任务“{title}”？Manager 会先关闭任务窗口并释放 Profile。',
    'confirm.deleteTask': '确定删除任务记录“{title}”？它会从面板消失且无法恢复，已生成的数据文件不会被删除。',
    'confirm.bulkCancelTasks': '确定取消选中的 {count} 个任务？Manager 会逐项安全关闭任务窗口并释放 Profile。',
    'confirm.bulkDeleteTasks': '确定删除选中的 {count} 个任务记录？只有已结束且完成清理的记录会被删除。',
    'confirm.assetSuffix': '等 {count} 项', 'confirm.deleteAssets': '确定删除 {names}{suffix}？Manager 会再次校验任务引用；删除后的执行器文件无法恢复。',
    'confirm.logout': '退出这台浏览器的 Owner 会话？后台任务不会停止。',
    'confirm.clearChannel': '确定清除 {channel} 的已保存凭据并关闭该通知通道？'
  }),
  en: Object.freeze({
    'page.title': 'Eric Task Master · Local Task Panel', 'skip.main': 'Skip to main content', 'brand.home': 'Eric Task Master dashboard home',
    'nav.primary': 'Primary navigation', 'nav.tasks': 'Tasks', 'nav.profiles': 'Profiles', 'nav.assets': 'Task Packs', 'nav.settings': 'Settings',
    'common.loading': 'Loading', 'common.close': 'Close', 'common.delete': 'Delete', 'common.status': 'Status',
    'connection.connecting': 'Connecting to local Manager', 'connection.online': 'Local Manager online', 'connection.ownerRequired': 'Owner session required',
    'connection.stale': 'Connection lost · retrying', 'connection.never': 'Not refreshed yet', 'connection.refreshed': 'Refreshed {time}',
    'refresh.aria': 'Refresh tasks, Profiles, Task Pack assets, and notifications', 'refresh.title': 'Refresh all dashboard data',
    'auth.logout': 'Sign out', 'auth.requiredTitle': 'This browser does not have an Owner session',
    'auth.requiredBody': 'Open the panel once from the deployment page. After the first trusted connection, this fixed address can be bookmarked.',
    'auth.retry': 'Check connection again', 'stale.title': 'Live connection is temporarily unavailable',
    'stale.body': 'The last successful state is preserved while automatic retries continue. Background tasks are not interrupted.', 'stale.retry': 'Retry now',
    'tasks.title': 'Task progress', 'tasks.description': 'See what each Agent is doing, and pause, resume, cancel, or remove completed task records.',
    'tasks.loading': 'Loading tasks…', 'tasks.authEmpty': 'Start an Owner session to view tasks.', 'tasks.empty': 'There are no tasks yet.',
    'tasks.active': '{active} active · {total} tasks', 'tasks.inProgress': 'In progress', 'tasks.progressAria': '{title} progress',
    'tasks.progressUnknown': 'Running without a known total', 'tasks.runTime': 'Run time', 'tasks.cooldownTime': 'Cooldown',
    'tasks.totalTime': 'Total time', 'tasks.report': 'View final Agent report', 'tasks.lastFeedback': 'Last update {time}',
    'tasks.targetMissing': 'The requested task record does not exist or was deleted', 'task.untitled': 'Untitled task', 'task.waitingFeedback': 'Waiting for feedback',
    'tasks.bulk': 'Task batch management', 'tasks.bulkActions': 'Task batch actions', 'tasks.selectAll': 'Select loaded tasks',
    'tasks.selectAria': 'Select task {title}', 'tasks.noneSelected': 'No tasks selected', 'tasks.selected': '{count} tasks selected',
    'tasks.bulkPause': 'Pause selected', 'tasks.bulkResume': 'Resume selected', 'tasks.bulkCancel': 'Cancel selected', 'tasks.bulkDelete': 'Delete records',
    'tasks.loadMore': 'Load more tasks', 'tasks.loadingMore': 'Loading more tasks…', 'tasks.pageLoaded': '{count} tasks loaded',
    'tasks.pageMore': '{count} tasks loaded · more available', 'tasks.batchRunning': 'Applying {action} to each task…',
    'tasks.batchDone': '{success} succeeded · {failed} failed · {skipped} skipped',
    'tasks.batchSuccess': 'Done', 'tasks.batchSkipped': 'This action is unavailable in the current state', 'tasks.batchFailed': 'Failed: {message}',
    'tasks.actionPause': 'pause', 'tasks.actionResume': 'resume', 'tasks.actionCancel': 'cancel', 'tasks.actionDelete': 'delete record',
    'state.queued': 'Queued', 'state.acquiringProfile': 'Preparing Profile', 'state.startingBrowser': 'Starting browser', 'state.running': 'Running',
    'state.pauseRequested': 'Pausing', 'state.paused': 'Paused', 'state.waitingUser': 'Action required', 'state.coolingDown': 'Cooling down',
    'state.recovering': 'Recovering', 'state.verifying': 'Verifying', 'state.cancelRequested': 'Cancelling', 'state.cancelling': 'Cancelling',
    'state.completed': 'Completed', 'state.failed': 'Failed', 'state.cancelled': 'Cancelled',
    'activity.queued': 'Waiting to be scheduled', 'activity.acquiringProfile': 'Preparing Profile', 'activity.startingBrowser': 'Starting browser',
    'activity.navigating': 'Opening page', 'activity.clicking': 'Clicking', 'activity.typing': 'Typing', 'activity.hovering': 'Hovering',
    'activity.scrolling': 'Scrolling page', 'activity.extracting': 'Extracting content', 'activity.analyzing': 'Analyzing',
    'activity.working': 'Working', 'activity.running': 'Running task', 'activity.waitingUser': 'Waiting for Agent action',
    'activity.coolingDown': 'Waiting for rate limit recovery', 'activity.recovering': 'Recovering from checkpoint', 'activity.verifying': 'Verifying results',
    'activity.reporting': 'Wrapping up', 'activity.cleaningUp': 'Closing task window', 'activity.paused': 'Task paused',
    'activity.completed': 'Task completed', 'activity.failed': 'Task failed', 'activity.cancelRequested': 'Cancelling task safely',
    'activity.cancelling': 'Cancelling task safely', 'activity.cancelled': 'Task cancelled',
    'behavior.fast': 'Fast', 'behavior.auto': 'Auto', 'behavior.autoBalanced': 'Auto balance', 'behavior.human': 'Deep human',
    'behavior.fastPace': 'Fast pace', 'behavior.cautiousPace': 'Cautious pace', 'behavior.humanPace': 'Deep-human pace',
    'behavior.unassigned': 'Unassigned', 'behavior.unapplied': 'Not applied', 'behavior.actual': 'Effective behavior',
    'behavior.workerConfirmed': 'Worker confirmed · {time}', 'behavior.workerWaiting': 'Waiting for Worker',
    'actions.pause': 'Pause', 'actions.resume': 'Resume', 'actions.cancel': 'Cancel', 'actions.deleteRecord': 'Delete record',
    'actions.cleanupFirst': 'The record can be deleted after task cleanup finishes',
    'profiles.title': 'Browser Profiles', 'profiles.description': 'Manage isolated browser environments. Tasks run serially per Profile and never compete for login state.',
    'profiles.new': 'New Profile', 'profiles.createTitle': 'Create browser environment', 'profiles.name': 'Profile name',
    'profiles.namePlaceholder': 'Example: Work account', 'profiles.kind': 'Type', 'profiles.persistent': 'Persistent login',
    'profiles.ephemeral': 'Temporary, no login', 'profiles.browser': 'Browser', 'profiles.chrome': 'Stable local Chrome',
    'profiles.chromium': 'Project-pinned Chromium', 'profiles.speed': 'Operation speed', 'profiles.background': 'Run tasks in background',
    'profiles.extensions': 'Allow extensions', 'profiles.extensionsNextLaunch': 'Applies the next time this Profile opens or a task starts',
    'profiles.extensionsDeferred': 'The current browser will not restart; this applies after it closes and launches again',
    'profiles.extensionsVisibleOnly': 'Extensions require a visible browser; disable extensions to use background mode',
    'profiles.create': 'Create Profile', 'profiles.formNote': 'Persistent Profiles allow installed extensions in a visible browser by default. Temporary Profiles never load extensions and destroy browser state after the task.',
    'profiles.loading': 'Loading Profiles…', 'profiles.authEmpty': 'Start an Owner session to view Profiles.',
    'profiles.empty': 'There are no Profiles. Create a browser environment to start.', 'profiles.browserFact': 'Browser',
    'profiles.speedFact': 'Operation speed', 'profiles.recent': 'Last used', 'profiles.speedLive': 'Changes apply to the running task immediately, without a restart',
    'profiles.speedChoose': 'Choose fast, auto balance, or deep human for this Profile', 'profiles.rename': 'Rename',
    'profiles.closeWindow': 'Close window', 'profiles.openWindow': 'Open login window', 'profiles.taskOnly': 'Task launch only',
    'profiles.openTitle': 'Open a separate visible Chrome window for manual login or inspection', 'profiles.taskOnlyTitle': 'Temporary Profiles only launch inside tasks',
    'profiles.cleanupResidual': 'Clean residue', 'profiles.cleanupResidualTitle': 'Cleanup is unconfirmed. Manager will verify that the Worker exited and the temporary directory is empty.',
    'profiles.deleteBusy': 'The Profile must be idle before deletion', 'profiles.deleteTitle': 'Delete this Profile',
    'profileState.idle': 'Idle', 'profileState.closed': 'Closed', 'profileState.open': 'Open manually', 'profileState.leased': 'In use',
    'profileState.starting': 'Starting', 'profileState.error': 'Needs attention',
    'assets.title': 'Task Pack assets', 'assets.description': 'See what each Task Pack or script does, whether Agents can discover it, usage history, cleanup risk, notes, and batch actions.',
    'assets.toolbar': 'Task Pack asset filters and batch actions', 'assets.search': 'Search assets', 'assets.searchPlaceholder': 'Name, purpose, note, or task type',
    'assets.all': 'All assets', 'assets.discoverable': 'Agent discoverable', 'assets.deprecated': 'Deprecated', 'assets.history': 'History and orphan files',
    'assets.protected': 'System protected', 'assets.selectAll': 'Select current results', 'assets.bulk': 'Batch management', 'assets.note': 'Batch note',
    'assets.deprecate': 'Deprecate', 'assets.restore': 'Restore', 'assets.noneSelected': 'No assets selected', 'assets.loading': 'Loading Task Pack assets…',
    'assets.selected': '{count} selected · Manager will recheck task and recovery references before deletion',
    'assets.authEmpty': 'Start an Owner session to view Task Pack assets.', 'assets.empty': 'No Task Pack assets match the current filters.',
    'assets.selectAria': 'Select {title}', 'assets.agentVisible': 'Agent discoverable', 'assets.agentHidden': 'Not Agent discoverable',
    'assets.active': 'Active', 'assets.retired': 'History only', 'assets.purposeMissing': 'No purpose is documented. Add an asset note for future maintainers.',
    'assets.version': 'Version', 'assets.taskTypes': 'Task types', 'assets.runs': 'Runs', 'assets.successFailure': 'Success / failure',
    'assets.lastUsed': 'Last used', 'assets.size': 'File size', 'assets.fileCount': '{count} files · {size}', 'assets.assetNote': 'Asset note',
    'assets.noNote': 'No note', 'assets.containsTypes': 'Contains {count} task types', 'assets.blocked': 'Cannot delete: {reasons}',
    'assets.viewTask': 'View related task', 'assets.moreBlockers': '{count} more related tasks',
    'assets.blocker.active_task': 'Task is still active', 'assets.blocker.cleanup_pending': 'Task cleanup is not confirmed',
    'assets.blocker.resume_available': 'Task can still resume from its checkpoint', 'assets.blocker.protected': 'System protected',
    'assets.count': '{visible} / {total} assets',
    'notifications.open': 'Open notifications', 'notifications.close': 'Close notifications', 'notifications.title': 'Notifications', 'notifications.loading': 'Loading notifications…',
    'notifications.markAll': 'Mark all as read', 'notifications.none': 'There are no notifications requiring attention.',
    'notifications.summary': '{unread} unread · {total} notifications', 'notifications.reminders': '{count} reminders',
    'notifications.takeOver': 'Take over', 'notifications.focus': 'Open verification window', 'notifications.continue': 'Verification complete',
    'notifications.read': 'Mark as read', 'notifications.claimed': 'Marked as taken over', 'notifications.focused': 'Opening verification window',
    'notifications.continued': 'Verification completed; the original task will continue', 'notifications.readDone': 'Notification marked as read',
    'notifications.syncDegraded': 'The task action succeeded, but notification-state sync is temporarily degraded. Manager will retry automatically.',
    'notifications.allRead': 'All notifications marked as read', 'notifications.verification': 'Manual verification required', 'notifications.notice': 'Task notification',
    'notifications.defaultTitle': 'Task action required', 'notifications.defaultMessage': 'Open the task window and complete the required action.',
    'settings.title': 'Notification settings', 'settings.description': 'Manage only the three channels used when human verification needs attention.',
    'settings.system': 'System notifications', 'settings.feishu': 'Feishu', 'settings.enable': 'Enable', 'settings.test': 'Send test',
    'settings.systemDescription': 'Show a local system alert when human verification needs attention.',
    'settings.telegramDescription': 'Send human-verification alerts to a Telegram conversation.',
    'settings.feishuDescription': 'Send human-verification alerts through a Feishu or Lark webhook.',
    'settings.telegramToken': 'Bot Token (leave blank to keep current)', 'settings.telegramChat': 'Chat ID (leave blank to keep current)',
    'settings.feishuWebhook': 'Webhook (leave blank to keep current)', 'settings.feishuSigningSecret': 'Signing secret (optional; leave blank to keep current)', 'settings.secretPlaceholder': 'Saved secrets are never repopulated',
    'settings.destinationPlaceholder': 'Saved destinations are never repopulated', 'settings.maskedNote': 'Saved secrets are shown only as masked values and are never repopulated in the panel.',
    'settings.save': 'Save notification settings', 'settings.configured': 'Configured {target}', 'settings.notConfigured': 'Not configured',
    'settings.systemReady': 'Local system notification', 'settings.saved': 'Notification settings saved', 'settings.testSent': '{channel} test notification sent',
    'settings.clearCredentials': 'Clear credentials', 'settings.cleared': '{channel} credentials cleared', 'settings.openSystem': 'Open system settings',
    'settings.systemOpened': 'System notification settings opened', 'settings.status.ready': 'Ready', 'settings.status.needs_setup': 'Setup or test required',
    'settings.status.permission_blocked': 'System notification permission is blocked', 'settings.status.unavailable': 'Unavailable on this system',
    'settings.status.test_failed': 'Latest test failed', 'settings.signed': 'Signing enabled', 'settings.lastTestOk': 'Last test passed {time}', 'settings.lastTestFailed': 'Last test failed {time}',
    'error.request': 'Request failed ({status})', 'error.timeout': 'Local Manager did not respond within 10 seconds', 'error.network': 'Cannot reach local Manager',
    'error.read': 'Unable to load', 'error.operation': 'Operation failed', 'error.denied': 'You do not have permission: {message}',
    'error.profileName': 'That Profile name already exists. Choose another name.', 'error.revision': 'State changed. The latest state was loaded; review it and retry.',
    'error.refreshed': '{message} The latest state was loaded.', 'time.justNow': 'just now', 'time.soon': 'soon', 'time.days': '{days}d {clock}',
    'toast.profileCreated': 'Profile created', 'toast.speedApplied': 'Operation speed applied to running tasks without a restart',
    'toast.extensionsSaved': 'Extension setting saved; it applies on the next launch', 'toast.extensionsDeferred': 'Extension setting saved; the current browser will not restart and the change applies after it closes',
    'toast.profileSaved': 'Profile settings saved', 'toast.profileOpening': 'Opening a separate login window', 'toast.profileClosed': 'Profile window closed',
    'toast.profileResidualCleaned': 'Temporary Profile residue cleaned', 'toast.profileDeleted': 'Profile deleted',
    'toast.taskNotReady': 'Task revision is not ready; loading the latest state', 'toast.pauseSent': 'Pause request sent',
    'toast.resumeSent': 'Resume request sent', 'toast.cancelSent': 'Cancel request sent', 'toast.taskDeleted': 'Task record deleted',
    'toast.noteSaved': 'Asset note saved', 'toast.assetsDeprecated': 'Selected assets deprecated and hidden from Agents',
    'toast.assetsRestored': 'Selected assets restored for Agent discovery', 'toast.assetsDeleted': 'Selected Task Pack assets safely deleted',
    'toast.loggedOut': 'Signed out; background tasks are still running', 'toast.logoutFailed': 'Sign-out failed', 'toast.ownerFailed': 'Unable to start Owner session',
    'prompt.renameProfile': 'New Profile name', 'prompt.assetNote': 'Asset note (leave blank to clear)',
    'confirm.cleanupProfile': 'Clean abnormal temporary Profile “{name}”? Manager will proceed only after the Worker exits and the directory is empty.',
    'confirm.deleteProfile': 'Delete Profile “{name}” and its {description}? This cannot be undone.',
    'confirm.ephemeralData': 'temporary task settings', 'confirm.persistentData': 'persistent browser data',
    'confirm.cancelTask': 'Cancel task “{title}”? Manager will close the task window and release the Profile first.',
    'confirm.deleteTask': 'Delete task record “{title}”? It will disappear permanently, but generated data files are preserved.',
    'confirm.bulkCancelTasks': 'Cancel the {count} selected tasks? Manager will safely close each task window and release its Profile.',
    'confirm.bulkDeleteTasks': 'Delete the {count} selected task records? Only terminal records with confirmed cleanup will be deleted.',
    'confirm.assetSuffix': ' and {count} total', 'confirm.deleteAssets': 'Delete {names}{suffix}? Manager will recheck task references. Deleted executor files cannot be recovered.',
    'confirm.logout': 'Sign out this browser Owner session? Background tasks will continue.',
    'confirm.clearChannel': 'Clear the saved {channel} credentials and disable this notification channel?'
  })
});

function savedLanguage() {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'en' ? 'en' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

function t(key, values = {}) {
  const language = state?.language || 'zh-CN';
  const template = I18N[language]?.[key] ?? I18N['zh-CN'][key] ?? key;
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
}

const ui = Object.freeze({
  skipLink: document.querySelector('.skip-link'),
  topbar: document.querySelector('.app-header'),
  workspace: document.querySelector('.workspace'),
  navLinks: [...document.querySelectorAll('[data-view]')],
  viewPanels: [...document.querySelectorAll('[data-view-panel]')],
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  lastRefresh: document.querySelector('#last-refresh'),
  languageToggle: document.querySelector('#language-toggle'),
  notificationButton: document.querySelector('#notification-button'),
  notificationBadge: document.querySelector('#notification-badge'),
  notificationBackdrop: document.querySelector('#notification-backdrop'),
  notificationDrawer: document.querySelector('#notification-drawer'),
  notificationClose: document.querySelector('#notification-close'),
  notificationSummary: document.querySelector('#notification-summary'),
  notificationMarkAll: document.querySelector('#notification-mark-all'),
  notifications: document.querySelector('#notifications'),
  notificationsError: document.querySelector('#notifications-error'),
  notificationSettingsForm: document.querySelector('#notification-settings-form'),
  notificationSystemEnabled: document.querySelector('#notification-system-enabled'),
  notificationTelegramEnabled: document.querySelector('#notification-telegram-enabled'),
  notificationFeishuEnabled: document.querySelector('#notification-feishu-enabled'),
  notificationSystemStatus: document.querySelector('#notification-system-status'),
  notificationTelegramStatus: document.querySelector('#notification-telegram-status'),
  notificationFeishuStatus: document.querySelector('#notification-feishu-status'),
  notificationTelegramToken: document.querySelector('#notification-telegram-token'),
  notificationTelegramChat: document.querySelector('#notification-telegram-chat'),
  notificationFeishuWebhook: document.querySelector('#notification-feishu-webhook'),
  notificationFeishuSigningSecret: document.querySelector('#notification-feishu-signing-secret'),
  notificationSystemSettings: document.querySelector('#notification-system-settings'),
  notificationSettingsSave: document.querySelector('#notification-settings-save'),
  settingsError: document.querySelector('#settings-error'),
  notificationChannelTests: [...document.querySelectorAll('.channel-test')],
  notificationChannelClears: [...document.querySelectorAll('.channel-clear')],
  refreshAll: document.querySelector('#refresh-all'),
  logoutButton: document.querySelector('#logout-button'),
  authBanner: document.querySelector('#auth-banner'),
  retryAuth: document.querySelector('#retry-auth'),
  staleBanner: document.querySelector('#stale-banner'),
  retryStale: document.querySelector('#retry-stale'),
  taskCountChip: document.querySelector('#task-count-chip'),
  taskSelectAll: document.querySelector('#task-select-all'),
  taskSelectionSummary: document.querySelector('#task-selection-summary'),
  taskBulkPause: document.querySelector('#task-bulk-pause'),
  taskBulkResume: document.querySelector('#task-bulk-resume'),
  taskBulkCancel: document.querySelector('#task-bulk-cancel'),
  taskBulkDelete: document.querySelector('#task-bulk-delete'),
  taskBatchFeedback: document.querySelector('#task-batch-feedback'),
  taskLoadMore: document.querySelector('#task-load-more'),
  taskPageStatus: document.querySelector('#task-page-status'),
  tasks: document.querySelector('#tasks'),
  tasksError: document.querySelector('#tasks-error'),
  profiles: document.querySelector('#profiles'),
  profilesError: document.querySelector('#profiles-error'),
  assets: document.querySelector('#assets'),
  assetsError: document.querySelector('#assets-error'),
  assetCountChip: document.querySelector('#asset-count-chip'),
  assetSearch: document.querySelector('#asset-search'),
  assetFilter: document.querySelector('#asset-filter'),
  assetSelectAll: document.querySelector('#asset-select-all'),
  assetSelectionSummary: document.querySelector('#asset-selection-summary'),
  assetNote: document.querySelector('#asset-note'),
  assetDeprecate: document.querySelector('#asset-deprecate'),
  assetRestore: document.querySelector('#asset-restore'),
  assetDelete: document.querySelector('#asset-delete'),
  toggleProfileCreate: document.querySelector('#toggle-profile-create'),
  closeProfileCreate: document.querySelector('#close-profile-create'),
  profileCreatePanel: document.querySelector('#profile-create-panel'),
  createProfileForm: document.querySelector('#create-profile-form'),
  profileName: document.querySelector('#profile-name'),
  profileKind: document.querySelector('#profile-kind'),
  profileEngine: document.querySelector('#profile-engine'),
  profileMode: document.querySelector('#profile-mode'),
  profileHeadless: document.querySelector('#profile-headless'),
  message: document.querySelector('#dashboard-message')
});

const state = {
  language: savedLanguage(),
  authenticated: null,
  stale: false,
  connectionMode: 'pending',
  lastRefreshAt: null,
  visibleView: 'tasks',
  profiles: [],
  tasks: [],
  assets: [],
  notifications: [],
  notificationSettings: null,
  notificationSettingsDirty: false,
  notificationSettingsEpoch: 0,
  notificationDrawerOpen: false,
  selectedTaskIds: new Set(),
  taskBatchResults: [],
  taskNextCursor: null,
  taskPageCount: 1,
  taskLoadingMore: false,
  targetedTaskId: new URL(location.href).searchParams.get('task') || '',
  selectedAssetIds: new Set(),
  openReportTaskIds: new Set(),
  taskReceivedAt: new Map(),
  sectionErrors: {},
  mutationErrors: {},
  renderSignatures: new Map(),
  pendingMutations: new Set(),
  pendingFocusKey: '',
  focusIntentSequence: 0,
  refreshSequence: 0,
  refreshPromise: null,
  refreshAgain: false,
  refreshTimer: null,
  durationTimer: null,
  toastTimer: null,
  stopped: false,
  initialTaskId: new URL(location.href).searchParams.get('task') || '',
  initialTaskHandled: false,
  taskFocusLoading: false
};

function applyStaticLanguage() {
  document.documentElement.lang = state.language;
  document.title = t('page.title');
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-aria-label]')) node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  const switchToEnglish = state.language === 'zh-CN';
  ui.languageToggle.textContent = switchToEnglish ? 'EN' : '中';
  ui.languageToggle.setAttribute('aria-label', switchToEnglish ? 'Switch to English' : '切换到中文');
  ui.languageToggle.title = ui.languageToggle.getAttribute('aria-label');
}

function setLanguage(language) {
  state.language = language === 'en' ? 'en' : 'zh-CN';
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, state.language);
  } catch {}
  applyStaticLanguage();
  setConnectionState(state.connectionMode);
  if (state.lastRefreshAt) ui.lastRefresh.textContent = t('connection.refreshed', { time: formatTime(state.lastRefreshAt) });
  state.renderSignatures.clear();
  renderAll(true);
  renderNotifications(true);
  renderNotificationSettings();
}

class HttpError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function button(label, className, action) {
  const node = element('button', `npc-btn ${className}`.trim(), label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dataFrom(payload) {
  if (payload?.ok === true && payload.data !== undefined) return payload.data;
  return payload?.data !== undefined ? payload.data : payload;
}

function listFrom(payload, key) {
  const data = dataFrom(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function errorMessage(payload, fallback) {
  return payload?.error?.message || payload?.message || payload?.error || fallback;
}

async function request(path, { method = 'GET', body } = {}) {
  const upperMethod = method.toUpperCase();
  const mayRetry = upperMethod === 'GET';
  const attempts = mayRetry ? 2 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(path, {
        method: upperMethod,
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
      if (response.ok) return payload;
      const error = new HttpError(
        errorMessage(payload, t('error.request', { status: response.status })),
        response.status,
        payload?.error?.code || payload?.code || ''
      );
      if (response.status === 401) markAuthorizationRequired();
      if (mayRetry && attempt === 0 && response.status >= 500) {
        lastError = error;
        await sleep(READ_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    } catch (error) {
      const normalized = error?.name === 'AbortError'
        ? new HttpError(t('error.timeout'), 0, 'REQUEST_TIMEOUT')
        : error instanceof HttpError
          ? error
          : new HttpError(t('error.network'), 0, 'NETWORK_ERROR');
      lastError = normalized;
      if (mayRetry && attempt === 0 && normalized.status === 0) {
        await sleep(READ_RETRY_DELAY_MS);
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function bootstrapOwnerSession() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const code = hash.get('code') || '';
  if (!code) return;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(code)) return;
  try {
    await request('/v1/dashboard/session', { method: 'POST', body: { code } });
  } catch (error) {
    if (error.status !== 401) throw error;
  }
}

function markAuthorizationRequired() {
  state.authenticated = false;
  state.stale = false;
  state.refreshSequence += 1;
  state.profiles = [];
  state.tasks = [];
  state.assets = [];
  state.notifications = [];
  state.notificationSettings = null;
  state.selectedTaskIds.clear();
  state.taskBatchResults = [];
  state.taskNextCursor = null;
  state.taskPageCount = 1;
  state.taskLoadingMore = false;
  state.selectedAssetIds.clear();
  state.taskReceivedAt.clear();
  state.sectionErrors = {};
  state.mutationErrors = {};
  state.notificationSettingsDirty = false;
  state.pendingMutations.clear();
  state.renderSignatures.clear();
  state.pendingFocusKey = '';
  ui.authBanner.classList.remove('hidden');
  ui.staleBanner.classList.add('hidden');
  ui.logoutButton.classList.add('hidden');
  setNotificationDrawer(false, { focus: false });
  setConnectionState('unauthorized');
  renderAll(true);
}

function markConnected() {
  state.authenticated = true;
  state.stale = false;
  ui.authBanner.classList.add('hidden');
  ui.staleBanner.classList.add('hidden');
  ui.logoutButton.classList.remove('hidden');
  setConnectionState('connected');
}

function markStale() {
  if (state.authenticated === false) return;
  state.stale = true;
  ui.staleBanner.classList.remove('hidden');
  setConnectionState('stale');
}

function setConnectionState(mode) {
  state.connectionMode = mode;
  const dotClasses = ['npc-signal-dot'];
  let label = t('connection.connecting');
  if (mode === 'connected') {
    dotClasses.push('is-online');
    label = t('connection.online');
  } else if (mode === 'unauthorized') {
    dotClasses.push('is-offline');
    label = t('connection.ownerRequired');
  } else if (mode === 'stale') {
    dotClasses.push('is-warning');
    label = t('connection.stale');
  } else {
    dotClasses.push('is-pending');
  }
  ui.connectionDot.className = dotClasses.join(' ');
  ui.connectionLabel.textContent = label;
}

function setToast(message, kind = 'info') {
  clearTimeout(state.toastTimer);
  ui.message.textContent = message;
  ui.message.className = `toast ${kind}`;
  ui.message.classList.remove('hidden');
  state.toastTimer = setTimeout(() => ui.message.classList.add('hidden'), 6_000);
}

function setInlineError(node, message = '') {
  node.textContent = message;
  node.classList.toggle('hidden', !message);
}

function formatTime(value, { relative = false } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  if (relative) {
    const seconds = Math.round((date.valueOf() - Date.now()) / 1000);
    const absolute = Math.abs(seconds);
    if (absolute < 60) return seconds <= 0 ? t('time.justNow') : t('time.soon');
    const formatter = new Intl.RelativeTimeFormat(state.language, { numeric: 'auto' });
    if (absolute < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
    if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
    return formatter.format(Math.round(seconds / 86400), 'day');
  }
  return new Intl.DateTimeFormat(state.language, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value / 1_000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  const clock = [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
  return days ? t('time.days', { days, clock }) : clock;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function taskState(task) {
  return task?.state || task?.status || 'queued';
}

function taskStateLabel(task) {
  const value = taskState(task);
  return TASK_STATE_KEYS[value] ? t(TASK_STATE_KEYS[value]) : value;
}

function taskTitle(task) {
  return task?.displayName || task?.name || task?.taskLabel || task?.title || task?.taskType || task?.id || t('task.untitled');
}

function taskActivity(task) {
  const phase = task?.currentActivity?.phase || task?.activity?.phase || taskState(task);
  const label = task?.currentActivity?.label || (ACTIVITY_KEYS[phase] ? t(ACTIVITY_KEYS[phase]) : '') || (ACTIVITY_KEYS[taskState(task)] ? t(ACTIVITY_KEYS[taskState(task)]) : '') || t('task.waitingFeedback');
  const message = task?.progress?.message || task?.currentActivity?.message || task?.message || label;
  return { label, message, updatedAt: task?.progress?.updatedAt || task?.currentActivity?.updatedAt || task?.updatedAt };
}

function taskProgress(task) {
  const current = Number(task?.progress?.current ?? task?.progress?.completed);
  const total = Number(task?.progress?.total);
  const explicit = Number(task?.progress?.percent);
  const percent = Number.isFinite(explicit)
    ? Math.max(0, Math.min(100, explicit))
    : Number.isFinite(current) && Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(100, Math.round((current / total) * 100)))
      : TERMINAL_TASK_STATES.has(taskState(task)) && taskState(task) === 'completed'
        ? 100
        : null;
  const amount = Number.isFinite(current) && Number.isFinite(total) && total > 0 ? `${current}/${total}` : '';
  return { percent, amount };
}

function finiteDuration(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function elapsedBetween(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = typeof end === 'number' ? end : Date.parse(end || '');
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
}

function taskDurations(task, at = Date.now()) {
  const timing = task?.timing && typeof task.timing === 'object' ? task.timing : {};
  const terminal = TERMINAL_TASK_STATES.has(taskState(task));
  const receivedAt = state.taskReceivedAt.get(task.id) || at;
  const liveDelta = terminal ? 0 : Math.max(0, at - receivedAt);
  const endAt = terminal && task.finishedAt ? Date.parse(task.finishedAt) : at;

  let total = finiteDuration(timing.totalDurationMs, timing.totalMs, timing.elapsedMs);
  if (total !== null) total += liveDelta;
  else total = elapsedBetween(task.createdAt, endAt);

  let run = finiteDuration(timing.runDurationMs, timing.runMs, timing.runningMs, timing.activeMs);
  if (run !== null) {
    const isActiveTime = timing.runDurationMs !== undefined || (
      timing.runMs === undefined && timing.runningMs === undefined && timing.activeMs !== undefined
    );
    const shouldTick = isActiveTime
      ? ACTIVE_TASK_STATES.has(taskState(task)) && taskState(task) !== 'cooling_down'
      : Boolean(task.startedAt) && !terminal;
    if (shouldTick) run += liveDelta;
  } else if (timing.recorded === false) {
    run = null;
  } else {
    run = task.startedAt ? elapsedBetween(task.startedAt, endAt) : 0;
  }

  let cooldown = finiteDuration(timing.cooldownDurationMs, timing.cooldownMs, timing.coolingDownMs);
  if (cooldown !== null && taskState(task) === 'cooling_down') cooldown += liveDelta;
  if (cooldown === null && timing.recorded === false) {
    cooldown = null;
  } else if (cooldown === null) {
    const activeCooldownStart = task?.cooldown?.startedAt || (taskState(task) === 'cooling_down' ? task?.updatedAt : null);
    cooldown = activeCooldownStart ? elapsedBetween(activeCooldownStart, endAt) : 0;
  }
  return { run, cooldown, total };
}

function profileState(profile) {
  return profile?.runtime?.state || profile?.state || (profile?.leased ? 'leased' : 'idle');
}

function profileMode(profile) {
  const mode = profile?.defaultBehavior || profile?.behaviorMode;
  if (mode === 'adaptive') return 'auto';
  return mode || (profile?.kind === 'persistent' ? 'human' : 'auto');
}

function taskBehaviorValue(task) {
  const configured = ['fast', 'auto', 'human'].includes(task?.behaviorState?.configured)
    ? task.behaviorState.configured
    : ['fast', 'auto', 'human'].includes(task?.behavior)
      ? task.behavior
      : null;
  const effective = ['fast', 'cautious', 'human'].includes(task?.behaviorState?.effective)
    ? task.behaviorState.effective
    : configured === 'auto' ? 'fast' : configured;
  const configuredLabel = ({ fast: t('behavior.fast'), auto: t('behavior.auto'), human: t('behavior.human') })[configured] || t('behavior.unassigned');
  const effectiveLabel = ({ fast: t('behavior.fastPace'), cautious: t('behavior.cautiousPace'), human: t('behavior.humanPace') })[effective] || t('behavior.unapplied');
  const confirmed = task?.behaviorState?.source === 'worker' && task?.behaviorState?.confirmed === true;
  return {
    configured,
    effective,
    confirmed,
    label: configured === 'auto' ? `${configuredLabel} · ${effectiveLabel}` : configuredLabel,
    receipt: confirmed
      ? t('behavior.workerConfirmed', { time: formatTime(task.behaviorState.at, { relative: true }) })
      : t('behavior.workerWaiting')
  };
}

function profileEngine(profile) {
  return profile?.browserEngine === 'chromium' ? 'Chromium' : 'Chrome';
}

function containsInteractiveFocus(container) {
  const active = document.activeElement;
  return Boolean(active && container.contains(active) && active.matches('input, select, textarea, button'));
}

function focusKey(node, value) {
  node.dataset.focusKey = value;
  return node;
}

function restoreFocus(value) {
  if (!value) return false;
  const target = document.querySelector(`[data-focus-key="${CSS.escape(value)}"]`) || document.querySelector(`#${CSS.escape(value)}`);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

function renderWhenChanged(key, value, container, renderer, force = false) {
  const signature = JSON.stringify(value);
  if (!force && state.renderSignatures.get(key) === signature) return;
  if (!force && containsInteractiveFocus(container)) return;
  state.renderSignatures.set(key, signature);
  renderer();
}

function setView(requested, { updateHistory = true, focus = true } = {}) {
  const view = VIEWS.has(requested) ? requested : 'tasks';
  if (state.notificationDrawerOpen) setNotificationDrawer(false, { focus: false });
  state.visibleView = view;
  for (const link of ui.navLinks) {
    const active = link.dataset.view === view;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const panel of ui.viewPanels) {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  }
  if (updateHistory) {
    const url = new URL(location.href);
    if (view === 'tasks') url.searchParams.delete('view');
    else url.searchParams.set('view', view);
    history.pushState(null, '', `${url.pathname}${url.search}`);
  }
  if (focus) document.querySelector(`#${view}-title`)?.focus();
}

function labelledValue(label, value, className = '') {
  const group = element('span', `labelled-value ${className}`.trim());
  group.append(element('small', '', label), element('strong', '', value));
  return group;
}

function durationValue(task, kind, label) {
  const group = labelledValue(label, '—', 'duration-value');
  const value = group.querySelector('strong');
  value.dataset.taskDuration = kind;
  value.dataset.taskId = task.id;
  value.textContent = formatDuration(taskDurations(task)[kind]);
  return group;
}

function behaviorValue(task) {
  const behavior = taskBehaviorValue(task);
  const group = labelledValue(t('behavior.actual'), behavior.label, 'behavior-value');
  group.dataset.taskBehavior = behavior.configured || '';
  group.dataset.taskBehaviorEffective = behavior.effective || '';
  group.dataset.taskBehaviorConfirmed = String(behavior.confirmed);
  group.append(element('small', 'behavior-receipt', behavior.receipt));
  return group;
}

function profileNameFor(task) {
  return task.profileName || state.profiles.find((profile) => profile.id === task.profileId)?.name || task.profileId || '—';
}

function commandId() {
  return `dashboard:${crypto.randomUUID()}`;
}

function taskActionEligible(task, action) {
  const status = taskState(task);
  if (action === 'pause') return PAUSABLE_TASK_STATES.has(status);
  if (action === 'resume') return status === 'paused';
  if (action === 'cancel') return !TERMINAL_TASK_STATES.has(status) && !['cancel_requested', 'cancelling'].includes(status);
  if (action === 'delete') return TERMINAL_TASK_STATES.has(status) && task.cleanup?.settled === true;
  return false;
}

function selectedTasks() {
  const selected = state.selectedTaskIds;
  return state.tasks.filter((task) => selected.has(task.id));
}

function syncTaskBulkControls() {
  const selected = selectedTasks();
  const loadedIds = state.tasks.map((task) => task.id);
  const selectedLoaded = loadedIds.filter((id) => state.selectedTaskIds.has(id)).length;
  const pending = state.pendingMutations.has('task:batch');
  ui.taskSelectAll.checked = loadedIds.length > 0 && selectedLoaded === loadedIds.length;
  ui.taskSelectAll.indeterminate = selectedLoaded > 0 && selectedLoaded < loadedIds.length;
  ui.taskSelectAll.disabled = pending || loadedIds.length === 0;
  ui.taskSelectionSummary.textContent = selected.length
    ? t('tasks.selected', { count: selected.length })
    : t('tasks.noneSelected');
  ui.taskBulkPause.disabled = pending || !selected.some((task) => taskActionEligible(task, 'pause'));
  ui.taskBulkResume.disabled = pending || !selected.some((task) => taskActionEligible(task, 'resume'));
  ui.taskBulkCancel.disabled = pending || !selected.some((task) => taskActionEligible(task, 'cancel'));
  ui.taskBulkDelete.disabled = pending || !selected.some((task) => taskActionEligible(task, 'delete'));
}

function renderTaskBatchFeedback() {
  ui.taskBatchFeedback.replaceChildren();
  const results = state.taskBatchResults;
  ui.taskBatchFeedback.classList.toggle('hidden', results.length === 0);
  if (!results.length) return;
  const list = element('ul');
  for (const result of results) {
    const item = element('li', `task-batch-result is-${result.status}`);
    const message = result.status === 'pending'
      ? t('tasks.batchRunning', { action: taskBatchActionLabel(result.action) })
      : result.status === 'success'
        ? t('tasks.batchSuccess')
        : result.status === 'skipped'
          ? t('tasks.batchSkipped')
          : t('tasks.batchFailed', { message: result.error || t('error.operation') });
    item.append(element('strong', '', result.title), element('span', '', message));
    list.append(item);
  }
  ui.taskBatchFeedback.append(list);
}

function taskActionButtons(task) {
  const actions = element('div', 'task-actions');
  const status = taskState(task);
  const key = `task:${task.id}`;
  const pending = state.pendingMutations.has(key) || state.pendingMutations.has('task:batch');
  if (PAUSABLE_TASK_STATES.has(status)) {
    const pause = focusKey(button(t('actions.pause'), 'npc-btn-secondary compact-button', () => void sendTaskAction(task, 'pause')), `${key}:pause`);
    pause.disabled = pending;
    actions.append(pause);
  }
  if (status === 'paused') {
    const resume = focusKey(button(t('actions.resume'), 'npc-btn-primary compact-button', () => void sendTaskAction(task, 'resume')), `${key}:resume`);
    resume.disabled = pending;
    actions.append(resume);
  }
  if (!TERMINAL_TASK_STATES.has(status)) {
    const cancel = focusKey(button(t('actions.cancel'), 'npc-btn-danger compact-button', () => void sendTaskAction(task, 'cancel')), `${key}:cancel`);
    cancel.disabled = pending || ['cancel_requested', 'cancelling'].includes(status);
    actions.append(cancel);
  } else {
    const remove = focusKey(button(t('actions.deleteRecord'), 'npc-btn-danger compact-button', () => void deleteTaskRecord(task)), `${key}:delete`);
    const settled = task.cleanup?.settled === true;
    remove.disabled = pending || !settled;
    if (!settled) remove.title = t('actions.cleanupFirst');
    actions.append(remove);
  }
  return actions;
}

function renderTasks(force = false) {
  const validTaskIds = new Set(state.tasks.map((task) => task.id));
  for (const id of state.selectedTaskIds) if (!validTaskIds.has(id)) state.selectedTaskIds.delete(id);
  const ordered = [...state.tasks].sort((left, right) => {
    const leftTerminal = TERMINAL_TASK_STATES.has(taskState(left));
    const rightTerminal = TERMINAL_TASK_STATES.has(taskState(right));
    if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
    return Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0);
  });
  const reportTaskIds = new Set(ordered
    .filter((task) => task.report?.status === 'final' && task.report.summary)
    .map((task) => task.id));
  for (const id of state.openReportTaskIds) {
    if (!reportTaskIds.has(id)) state.openReportTaskIds.delete(id);
  }
  renderWhenChanged('tasks', {
    ordered,
    selected: [...state.selectedTaskIds].sort(),
    targetedTaskId: state.targetedTaskId,
    pending: [...state.pendingMutations].filter((key) => key.startsWith('task:'))
  }, ui.tasks, () => {
    ui.tasks.replaceChildren();
    if (!ordered.length) {
      ui.tasks.append(element('p', 'empty-state', state.authenticated === false ? t('tasks.authEmpty') : t('tasks.empty')));
      return;
    }
    for (const task of ordered) {
      const status = taskState(task);
      const progress = taskProgress(task);
      const activity = taskActivity(task);
      const card = focusKey(element('article', `task-card task-${status}`), `task:${task.id}:card`);
      card.tabIndex = -1;
      card.dataset.taskId = task.id;
      if (state.targetedTaskId === task.id) card.classList.add('is-targeted');

      const heading = element('div', 'task-card-heading');
      const selector = element('label', 'task-selector');
      const checkbox = focusKey(element('input'), `task:${task.id}:select`);
      checkbox.type = 'checkbox';
      checkbox.checked = state.selectedTaskIds.has(task.id);
      checkbox.disabled = state.pendingMutations.has('task:batch');
      checkbox.setAttribute('aria-label', t('tasks.selectAria', { title: taskTitle(task) }));
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selectedTaskIds.add(task.id);
        else state.selectedTaskIds.delete(task.id);
        syncTaskBulkControls();
      });
      selector.append(checkbox);
      const headingCopy = element('div');
      headingCopy.append(element('h2', '', taskTitle(task)), element('p', 'task-activity', activity.label));
      heading.append(selector, headingCopy, element('span', `npc-chip task-state-chip task-state-${status}`, taskStateLabel(task)));

      const progressBlock = element('div', 'task-progress-block');
      const progressCopy = element('div', 'progress-copy');
      progressCopy.append(element('strong', '', activity.message), element('span', 'npc-number', progress.amount || (progress.percent === null ? t('tasks.inProgress') : `${progress.percent}%`)));
      const track = element('div', 'progress-track');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', t('tasks.progressAria', { title: taskTitle(task) }));
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      if (progress.percent === null) track.setAttribute('aria-valuetext', t('tasks.progressUnknown'));
      else track.setAttribute('aria-valuenow', String(progress.percent));
      const bar = element('span', 'progress-bar');
      bar.style.width = `${progress.percent ?? (TERMINAL_TASK_STATES.has(status) ? 100 : 4)}%`;
      track.append(bar);
      progressBlock.append(progressCopy, track);

      const metadata = element('div', 'task-meta-row');
      metadata.append(
        labelledValue('Profile', profileNameFor(task)),
        behaviorValue(task),
        durationValue(task, 'run', t('tasks.runTime')),
        durationValue(task, 'cooldown', t('tasks.cooldownTime')),
        durationValue(task, 'total', t('tasks.totalTime'))
      );

      let reportPanel = null;
      if (task.report?.status === 'final' && task.report.summary) {
        reportPanel = element('details', 'task-report');
        reportPanel.open = state.openReportTaskIds.has(task.id);
        reportPanel.addEventListener('toggle', () => {
          if (reportPanel.open) state.openReportTaskIds.add(task.id);
          else state.openReportTaskIds.delete(task.id);
        });
        const reportSummary = element('summary', '', t('tasks.report'));
        const reportBody = element('div', 'task-report-body');
        if (task.report.title) reportBody.append(element('strong', '', task.report.title));
        reportBody.append(element('p', '', task.report.summary));
        for (const section of Array.isArray(task.report.sections) ? task.report.sections.slice(0, 8) : []) {
          if (typeof section === 'string') reportBody.append(element('p', '', section));
          else if (section && typeof section === 'object') {
            if (section.heading) reportBody.append(element('h3', '', section.heading));
            if (section.body) reportBody.append(element('p', '', section.body));
          }
        }
        reportPanel.append(reportSummary, reportBody);
      }

      const footer = element('div', 'task-card-footer');
      footer.append(
        element('span', 'task-updated', t('tasks.lastFeedback', { time: formatTime(activity.updatedAt, { relative: true }) })),
        taskActionButtons(task)
      );
      card.append(heading, progressBlock, metadata);
      if (reportPanel) card.append(reportPanel);
      card.append(footer);
      ui.tasks.append(card);
    }
  }, force);
  const active = state.tasks.filter((task) => !TERMINAL_TASK_STATES.has(taskState(task))).length;
  ui.taskCountChip.textContent = t('tasks.active', { active, total: state.tasks.length });
  ui.taskLoadMore.hidden = !state.taskNextCursor;
  ui.taskLoadMore.disabled = state.taskLoadingMore || state.authenticated === false;
  ui.taskLoadMore.textContent = state.taskLoadingMore ? t('tasks.loadingMore') : t('tasks.loadMore');
  ui.taskPageStatus.textContent = t(state.taskNextCursor ? 'tasks.pageMore' : 'tasks.pageLoaded', { count: state.tasks.length });
  syncTaskBulkControls();
  renderTaskBatchFeedback();
  setInlineError(ui.tasksError, state.mutationErrors.tasks || state.sectionErrors.tasks || '');
}

function renderProfiles(force = false) {
  renderWhenChanged('profiles', { profiles: state.profiles, pending: [...state.pendingMutations].filter((key) => key.startsWith('profile:')) }, ui.profiles, () => {
    ui.profiles.replaceChildren();
    if (!state.profiles.length) {
      ui.profiles.append(element('p', 'empty-state span-all', state.authenticated === false ? t('profiles.authEmpty') : t('profiles.empty')));
      return;
    }
    for (const profile of state.profiles) {
      const id = profile.id;
      const currentState = profileState(profile);
      const persistent = profile.kind !== 'ephemeral';
      const busy = !['idle', 'closed'].includes(currentState);
      const quarantinedEphemeral = !persistent && currentState === 'error' && profile.cleanupRequired === true;
      const pending = state.pendingMutations.has(`profile:${id}`);
      const card = element('article', `profile-card profile-${profile.kind || 'persistent'}`);
      const heading = element('div', 'card-heading');
      const title = element('div');
      title.append(element('p', 'npc-eyebrow', persistent ? 'PERSISTENT' : 'EPHEMERAL'), element('h2', '', profile.name || id));
      const stateLabel = ({
        idle: t('profileState.idle'), closed: t('profileState.closed'), open: t('profileState.open'),
        leased: t('profileState.leased'), starting: t('profileState.starting'), error: t('profileState.error')
      })[currentState] || currentState;
      heading.append(title, element('span', `npc-chip profile-state-${currentState}`, stateLabel));

      const facts = element('div', 'profile-facts');
      facts.append(
        labelledValue(t('profiles.browserFact'), profileEngine(profile)),
        labelledValue(t('profiles.speedFact'), ({ human: t('behavior.human'), auto: t('behavior.autoBalanced'), fast: t('behavior.fast') })[profileMode(profile)] || profileMode(profile)),
        labelledValue(t('profiles.recent'), formatTime(profile.lastUsedAt, { relative: true }))
      );

      const settings = element('div', 'profile-settings');
      const modeLabel = element('label');
      modeLabel.append(element('span', '', t('profiles.speed')));
      const mode = focusKey(element('select', 'npc-field compact-field'), `profile:${id}:mode`);
      for (const value of ['fast', 'auto', 'human']) {
        const option = element('option', '', ({ fast: t('behavior.fast'), auto: t('behavior.autoBalanced'), human: t('behavior.human') })[value]);
        option.value = value;
        mode.append(option);
      }
      mode.value = profileMode(profile);
      mode.disabled = pending;
      mode.title = busy
        ? t('profiles.speedLive')
        : t('profiles.speedChoose');
      mode.addEventListener('change', () => void updateProfile(profile, { defaultBehavior: mode.value }));
      modeLabel.append(mode);
      const toggleStack = element('div', 'profile-toggle-stack');
      if (persistent) {
        const extensionControl = element('div', 'profile-extension-control');
        const extensionLabel = element('label', 'switch-field');
        const extensionsEnabled = focusKey(element('input'), `profile:${id}:extensions`);
        extensionsEnabled.type = 'checkbox';
        extensionsEnabled.checked = profile.extensionsEnabled !== false;
        extensionsEnabled.disabled = pending;
        extensionsEnabled.title = busy ? t('profiles.extensionsDeferred') : t('profiles.extensionsNextLaunch');
        extensionsEnabled.addEventListener('change', () => void updateProfile(profile, extensionsEnabled.checked
          ? { extensionsEnabled: true, headless: false }
          : { extensionsEnabled: false }));
        extensionLabel.append(extensionsEnabled, element('span', '', t('profiles.extensions')));
        extensionControl.append(
          extensionLabel,
          element('p', 'profile-setting-note', busy ? t('profiles.extensionsDeferred') : t('profiles.extensionsNextLaunch'))
        );
        toggleStack.append(extensionControl);
      }
      const headlessLabel = element('label', 'switch-field');
      const headless = focusKey(element('input'), `profile:${id}:headless`);
      headless.type = 'checkbox';
      headless.checked = Boolean(profile.headless);
      headless.disabled = pending || (persistent && profile.extensionsEnabled !== false);
      headless.title = persistent && profile.extensionsEnabled !== false
        ? t('profiles.extensionsVisibleOnly')
        : t('profiles.background');
      headless.addEventListener('change', () => void updateProfile(profile, { headless: headless.checked }));
      headlessLabel.append(headless, element('span', '', t('profiles.background')));
      toggleStack.append(headlessLabel);
      settings.append(modeLabel, toggleStack);

      const actions = element('div', 'profile-actions');
      const rename = focusKey(button(t('profiles.rename'), 'npc-btn-ghost compact-button', () => void renameProfile(profile)), `profile:${id}:rename`);
      const toggleLabel = persistent ? (busy ? t('profiles.closeWindow') : t('profiles.openWindow')) : t('profiles.taskOnly');
      const toggle = focusKey(button(toggleLabel, 'npc-btn-secondary compact-button', () => void setProfileOpen(profile, !busy)), `profile:${id}:toggle`);
      toggle.disabled = !persistent || pending || currentState === 'starting';
      toggle.title = persistent ? t('profiles.openTitle') : t('profiles.taskOnlyTitle');
      const remove = focusKey(button(quarantinedEphemeral ? t('profiles.cleanupResidual') : t('common.delete'), 'npc-btn-danger compact-button', () => void deleteProfile(profile)), `profile:${id}:delete`);
      rename.disabled = pending;
      remove.disabled = (busy && !quarantinedEphemeral) || pending;
      remove.title = quarantinedEphemeral
        ? t('profiles.cleanupResidualTitle')
        : busy
          ? t('profiles.deleteBusy')
          : t('profiles.deleteTitle');
      actions.append(rename, toggle, remove);
      card.append(heading, facts, settings, actions);
      ui.profiles.append(card);
    }
  }, force);
  setInlineError(ui.profilesError, state.mutationErrors.profiles || state.sectionErrors.profiles || '');
}

function filteredAssets() {
  const query = ui.assetSearch.value.trim().toLocaleLowerCase(state.language);
  const filter = ui.assetFilter.value;
  return state.assets.filter((asset) => {
    if (filter === 'discoverable' && !asset.discoverable) return false;
    if (filter === 'deprecated' && asset.lifecycle !== 'deprecated') return false;
    if (filter === 'history' && !['history', 'orphan'].includes(asset.kind)) return false;
    if (filter === 'protected' && !asset.protected) return false;
    if (!query) return true;
    const haystack = [
      asset.name, asset.title, asset.description, asset.note, asset.version,
      ...(asset.taskTypes || []).flatMap((item) => [item.name, item.title])
    ].filter(Boolean).join(' ').toLocaleLowerCase(state.language);
    return haystack.includes(query);
  });
}

function assetBlockingTasks(asset) {
  return Array.isArray(asset?.blockingTasks)
    ? asset.blockingTasks.slice(0, 8).filter((item) => typeof item?.taskId === 'string' && item.taskId)
    : [];
}

function assetBlockerLabel(blocker) {
  const key = `assets.blocker.${blocker?.blockerCode || blocker?.code || ''}`;
  const translated = t(key);
  return translated === key ? blocker?.reason || blocker?.message || blocker?.state || t('assets.blocked', { reasons: '—' }) : translated;
}

function syncAssetBulkControls(visible = filteredAssets()) {
  const selected = state.assets.filter((asset) => state.selectedAssetIds.has(asset.id));
  const visibleIds = visible.map((asset) => asset.id);
  const selectedVisible = visibleIds.filter((id) => state.selectedAssetIds.has(id)).length;
  ui.assetSelectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  ui.assetSelectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  ui.assetSelectionSummary.textContent = selected.length
    ? t('assets.selected', { count: selected.length })
    : t('assets.noneSelected');
  ui.assetNote.disabled = !selected.length || selected.some((asset) => !asset.canEditNote);
  ui.assetDeprecate.disabled = !selected.length || selected.some((asset) => !asset.canChangeLifecycle || asset.lifecycle !== 'active');
  ui.assetRestore.disabled = !selected.length || selected.some((asset) => !asset.canChangeLifecycle || asset.lifecycle !== 'deprecated');
  ui.assetDelete.disabled = !selected.length || selected.some((asset) => !asset.deletable);
}

function renderAssets(force = false) {
  const visible = filteredAssets();
  const validIds = new Set(state.assets.map((asset) => asset.id));
  for (const id of state.selectedAssetIds) if (!validIds.has(id)) state.selectedAssetIds.delete(id);
  renderWhenChanged('assets', {
    assets: visible,
    selected: [...state.selectedAssetIds].sort(),
    pending: [...state.pendingMutations].filter((key) => key.startsWith('asset:'))
  }, ui.assets, () => {
    ui.assets.replaceChildren();
    if (!visible.length) {
      ui.assets.append(element('p', 'empty-state', state.authenticated === false
        ? t('assets.authEmpty')
        : t('assets.empty')));
      return;
    }
    for (const asset of visible) {
      const card = element('article', `asset-card asset-${asset.kind}`);
      card.dataset.assetId = asset.id;
      const heading = element('div', 'asset-card-heading');
      const selector = element('label', 'asset-selector');
      const checkbox = focusKey(element('input'), `asset:${asset.id}:select`);
      checkbox.type = 'checkbox';
      checkbox.checked = state.selectedAssetIds.has(asset.id);
      checkbox.setAttribute('aria-label', t('assets.selectAria', { title: asset.title }));
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selectedAssetIds.add(asset.id);
        else state.selectedAssetIds.delete(asset.id);
        syncAssetBulkControls();
      });
      selector.append(checkbox);
      const copy = element('div', 'asset-title-copy');
      copy.append(
        element('p', 'npc-eyebrow', ({
          pack: 'TASK PACK', standalone: asset.transient ? 'TRANSIENT MODULE' : 'STANDALONE MODULE',
          system: 'SYSTEM', history: 'TASK HISTORY', orphan: 'ORPHAN FILE'
        })[asset.kind] || asset.kind),
        element('h2', '', asset.title || asset.name)
      );
      const chips = element('div', 'asset-chips');
      chips.append(element('span', `npc-chip ${asset.discoverable ? 'npc-chip-success' : ''}`, asset.discoverable ? t('assets.agentVisible') : t('assets.agentHidden')));
      chips.append(element('span', `npc-chip ${asset.lifecycle === 'deprecated' ? 'npc-chip-warning' : ''}`, ({ active: t('assets.active'), deprecated: t('assets.deprecated'), retired: t('assets.retired') })[asset.lifecycle] || asset.lifecycle));
      if (asset.protected) chips.append(element('span', 'npc-chip', t('assets.protected')));
      heading.append(selector, copy, chips);

      const purpose = element('p', 'asset-purpose', asset.description || t('assets.purposeMissing'));
      const facts = element('div', 'asset-facts');
      facts.append(
        labelledValue(t('assets.version'), asset.version || '—'),
        labelledValue(t('assets.taskTypes'), String(asset.taskTypes?.length || 0)),
        labelledValue(t('assets.runs'), String(asset.usage?.runCount || 0)),
        labelledValue(t('assets.successFailure'), `${asset.usage?.successCount || 0} / ${asset.usage?.failureCount || 0}`),
        labelledValue(t('assets.lastUsed'), formatTime(asset.usage?.lastUsedAt, { relative: true })),
        labelledValue(t('assets.size'), t('assets.fileCount', { count: asset.fileCount || 0, size: formatBytes(asset.sizeBytes) }))
      );
      const note = element('div', 'asset-note');
      note.append(element('strong', '', t('assets.assetNote')), element('p', '', asset.note || t('assets.noNote')));
      const details = element('details', 'asset-task-types');
      details.append(element('summary', '', t('assets.containsTypes', { count: asset.taskTypes?.length || 0 })));
      const typeList = element('ul');
      for (const item of asset.taskTypes || []) {
        typeList.append(element('li', '', `${item.name}${item.title && item.title !== item.name ? ` · ${item.title}` : ''}`));
      }
      details.append(typeList);
      card.append(heading, purpose, facts, note, details);
      if (!asset.deletable && (asset.deleteBlockers?.length || assetBlockingTasks(asset).length)) {
        const blockerPanel = element('div', 'asset-blocker');
        const blockingTasks = assetBlockingTasks(asset);
        const reasons = Array.isArray(asset.deleteBlockers) && asset.deleteBlockers.length
          ? asset.deleteBlockers.join(state.language === 'en' ? '; ' : '；')
          : blockingTasks.map(assetBlockerLabel).join(state.language === 'en' ? '; ' : '；');
        blockerPanel.append(element('p', '', t('assets.blocked', { reasons })));
        if (blockingTasks.length) {
          const list = element('div', 'asset-blocking-tasks');
          for (const blocker of blockingTasks) {
            const row = element('div', 'asset-blocking-task');
            const copy = element('span');
            copy.append(
              element('strong', '', blocker.title || blocker.displayName || blocker.taskId),
              element('small', '', assetBlockerLabel(blocker))
            );
            const viewTask = button(t('assets.viewTask'), 'npc-btn-secondary compact-button', () => void focusTaskById(blocker.taskId));
            row.append(copy, viewTask);
            list.append(row);
          }
          const total = Number(asset.blockingTaskCount) || blockingTasks.length;
          if (total > blockingTasks.length) list.append(element('p', 'asset-more-blockers', t('assets.moreBlockers', { count: total - blockingTasks.length })));
          blockerPanel.append(list);
        }
        card.append(blockerPanel);
      }
      ui.assets.append(card);
    }
  }, force);
  ui.assetCountChip.textContent = t('assets.count', { visible: visible.length, total: state.assets.length });
  syncAssetBulkControls(visible);
  setInlineError(ui.assetsError, state.mutationErrors.assets || state.sectionErrors.assets || '');
}

function notificationUnread(notification) {
  return notification?.read !== true && !notification?.readAt && !['read', 'resolved', 'dismissed'].includes(notification?.status);
}

function notificationActive(notification) {
  if (notification?.state) return notification.state === 'active';
  return !notification?.resolvedAt && !['resolved', 'dismissed'].includes(notification?.status);
}

function verificationNotification(notification) {
  return ['human_verification', 'waiting_user', 'verification', 'user_handoff', 'challenge'].includes(notification?.kind || notification?.type || notification?.eventType);
}

function notificationTaskTitle(notification) {
  const task = state.tasks.find((item) => item.id === notification.taskId);
  if (verificationNotification(notification)) return task ? taskTitle(task) : notification.taskTitle || t('notifications.defaultTitle');
  return notification.taskTitle || notification.title || (task ? taskTitle(task) : t('notifications.defaultTitle'));
}

function notificationMessage(notification) {
  if (verificationNotification(notification)) return t('notifications.defaultMessage');
  return notification.message || notification.summary || notification.body || t('notifications.defaultMessage');
}

function notificationReminderCount(notification) {
  const value = Number(notification.reminderCount ?? notification.reminders ?? notification.deliveryCount ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function renderNotifications(force = false) {
  const ordered = [...state.notifications].sort((left, right) => {
    const activeDifference = Number(notificationActive(right)) - Number(notificationActive(left));
    if (activeDifference) return activeDifference;
    return Date.parse(right.createdAt || right.updatedAt || 0) - Date.parse(left.createdAt || left.updatedAt || 0);
  });
  const unread = ordered.filter(notificationUnread).length;
  ui.notificationBadge.textContent = unread > 99 ? '99+' : String(unread);
  ui.notificationBadge.classList.toggle('hidden', unread === 0);
  ui.notificationButton.classList.toggle('has-unread', unread > 0);
  ui.notificationSummary.textContent = t('notifications.summary', { unread, total: ordered.length });
  ui.notificationMarkAll.disabled = unread === 0 || state.pendingMutations.has('notification:all');
  renderWhenChanged('notifications', {
    language: state.language,
    ordered,
    pending: [...state.pendingMutations].filter((key) => key.startsWith('notification:'))
  }, ui.notifications, () => {
    ui.notifications.replaceChildren();
    if (!ordered.length) {
      ui.notifications.append(element('p', 'empty-state notification-empty', t('notifications.none')));
      return;
    }
    for (const notification of ordered.slice(0, 30)) {
      const isVerification = verificationNotification(notification);
      const active = notificationActive(notification);
      const card = element('article', `notification-card${isVerification ? ' is-verification' : ''}${notificationUnread(notification) ? ' is-unread' : ''}`);
      card.dataset.notificationId = notification.id;
      const heading = element('div', 'notification-card-heading');
      const copy = element('div');
      copy.append(
        element('p', 'npc-eyebrow', isVerification ? t('notifications.verification') : t('notifications.notice')),
        element('h3', '', notificationTaskTitle(notification))
      );
      const reminderCount = notificationReminderCount(notification);
      heading.append(copy, reminderCount ? element('span', 'npc-chip npc-chip-warning', t('notifications.reminders', { count: reminderCount })) : element('span', 'npc-chip', formatTime(notification.createdAt || notification.updatedAt, { relative: true })));
      card.append(heading, element('p', 'notification-message', notificationMessage(notification)));
      const actions = element('div', 'notification-actions');
      const pending = state.pendingMutations.has(`notification:${notification.id}`);
      const claimed = notification.state === 'claimed' || Boolean(notification.claimedAt) || notification.claimed === true;
      if (isVerification && (active || claimed)) {
        if (active) {
          const claim = button(t('notifications.takeOver'), 'npc-btn-secondary compact-button', () => void runNotificationAction(notification, 'claim'));
          claim.disabled = pending;
          actions.append(claim);
        }
        if (claimed) {
          const focus = button(t('notifications.focus'), 'npc-btn-secondary compact-button', () => void runNotificationAction(notification, 'focus'));
          focus.disabled = pending;
          const continueTask = button(t('notifications.continue'), 'npc-btn-primary compact-button', () => void runNotificationAction(notification, 'continue'));
          continueTask.disabled = pending;
          actions.append(focus, continueTask);
        }
      }
      if (notificationUnread(notification)) {
        const read = button(t('notifications.read'), 'npc-btn-ghost compact-button', () => void runNotificationAction(notification, 'read'));
        read.disabled = pending;
        actions.append(read);
      }
      if (actions.childElementCount) card.append(actions);
      ui.notifications.append(card);
    }
  }, force);
  setInlineError(ui.notificationsError, state.mutationErrors.notifications || state.sectionErrors.notifications || '');
}

function normalizeNotificationSettings(payload) {
  const value = dataFrom(payload)?.settings || dataFrom(payload) || {};
  const channels = value.channels || value;
  const statuses = new Set(['ready', 'needs_setup', 'permission_blocked', 'unavailable', 'test_failed']);
  const normalize = (channel) => {
    const source = channels?.[channel] || {};
    const lastTest = source.lastTest && typeof source.lastTest === 'object' && typeof source.lastTest.testedAt === 'string'
      ? {
          ok: source.lastTest.ok === true,
          testedAt: source.lastTest.testedAt,
          attempts: Number(source.lastTest.attempts) || 0,
          ...(typeof source.lastTest.code === 'string' ? { code: source.lastTest.code } : {}),
          ...(Number.isInteger(source.lastTest.statusCode) ? { statusCode: source.lastTest.statusCode } : {})
        }
      : null;
    return {
      enabled: source.enabled === true,
      configured: source.configured === true,
      status: statuses.has(source.status) ? source.status : source.configured === true ? 'ready' : 'needs_setup',
      canOpenSettings: source.canOpenSettings === true,
      signingConfigured: source.signingConfigured === true,
      lastTest,
      maskedTarget: source.maskedTarget || source.maskedDestination || ''
    };
  };
  return { channels: { system: normalize('system'), telegram: normalize('telegram'), feishu: normalize('feishu') } };
}

function channelStatus(channel, label) {
  if (!channel) return t('settings.notConfigured');
  const statusKey = `settings.status.${channel.status || (channel.configured ? 'ready' : 'needs_setup')}`;
  const parts = [t(statusKey)];
  if (channel.maskedTarget) parts.push(channel.maskedTarget);
  else if (label && channel.configured) parts.push(label);
  if (channel.signingConfigured) parts.push(t('settings.signed'));
  if (channel.lastTest?.testedAt) {
    parts.push(t(channel.lastTest.ok ? 'settings.lastTestOk' : 'settings.lastTestFailed', {
      time: formatTime(channel.lastTest.testedAt)
    }));
  }
  return parts.join(' · ');
}

function notificationSettingsMutationPending() {
  return [...state.pendingMutations].some((key) => key.startsWith('settings:'));
}

function notificationSettingsSnapshotIsCurrent(epoch) {
  return epoch === state.notificationSettingsEpoch &&
    !state.notificationSettingsDirty &&
    !notificationSettingsMutationPending();
}

function advanceNotificationSettingsEpoch() {
  state.notificationSettingsEpoch += 1;
}

function renderNotificationSettings() {
  const settings = state.notificationSettings;
  const pending = [...state.pendingMutations].some((key) => key.startsWith('settings:'));
  const controls = [
    ui.notificationSystemEnabled, ui.notificationTelegramEnabled, ui.notificationFeishuEnabled,
    ui.notificationTelegramToken, ui.notificationTelegramChat, ui.notificationFeishuWebhook, ui.notificationFeishuSigningSecret,
    ui.notificationSettingsSave
  ];
  for (const control of controls) control.disabled = !settings || pending;
  setInlineError(ui.settingsError, state.sectionErrors.notificationSettings || state.mutationErrors.settings || '');
  if (!settings) {
    ui.notificationSystemStatus.textContent = t('common.loading');
    ui.notificationTelegramStatus.textContent = t('common.loading');
    ui.notificationFeishuStatus.textContent = t('common.loading');
    for (const buttonNode of [...ui.notificationChannelTests, ...ui.notificationChannelClears]) buttonNode.disabled = true;
    ui.notificationSystemSettings.disabled = true;
    return;
  }
  const { system, telegram, feishu } = settings.channels;
  if (!state.notificationSettingsDirty) {
    ui.notificationSystemEnabled.checked = system.enabled;
    ui.notificationTelegramEnabled.checked = telegram.enabled;
    ui.notificationFeishuEnabled.checked = feishu.enabled;
  }
  ui.notificationSystemStatus.textContent = channelStatus(system, '');
  ui.notificationTelegramStatus.textContent = channelStatus(telegram, 'Telegram');
  ui.notificationFeishuStatus.textContent = channelStatus(feishu, t('settings.feishu'));
  for (const buttonNode of ui.notificationChannelTests) {
    buttonNode.disabled = pending || state.notificationSettingsDirty || settings.channels[buttonNode.dataset.channel]?.configured !== true;
  }
  for (const buttonNode of ui.notificationChannelClears) {
    buttonNode.disabled = pending || state.notificationSettingsDirty || settings.channels[buttonNode.dataset.channel]?.configured !== true;
  }
  ui.notificationSystemSettings.disabled = pending || system.canOpenSettings !== true;
  for (const [name, channel] of Object.entries({ system, telegram, feishu })) {
    const card = document.querySelector(`[data-channel-card="${name}"]`);
    if (card) card.dataset.channelState = channel.enabled ? 'enabled' : channel.configured ? 'configured' : 'unconfigured';
  }
}

function setNotificationDrawer(open, { focus = true } = {}) {
  state.notificationDrawerOpen = Boolean(open);
  ui.notificationDrawer.classList.toggle('hidden', !open);
  ui.notificationBackdrop.classList.toggle('hidden', !open);
  ui.notificationDrawer.setAttribute('aria-hidden', String(!open));
  ui.notificationButton.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('notification-open', Boolean(open));
  ui.skipLink.inert = Boolean(open);
  ui.topbar.inert = Boolean(open);
  ui.authBanner.inert = Boolean(open);
  ui.staleBanner.inert = Boolean(open);
  ui.workspace.inert = Boolean(open);
  if (focus) (open ? ui.notificationClose : ui.notificationButton).focus();
}

function trapNotificationDrawerFocus(event) {
  if (!state.notificationDrawerOpen || event.key !== 'Tab') return;
  const focusable = [...ui.notificationDrawer.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  )].filter((node) => !node.hidden && node.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    ui.notificationDrawer.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!ui.notificationDrawer.contains(document.activeElement) || !focusable.includes(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function runNotificationAction(notification, action) {
  const key = `notification:${notification.id}`;
  if (state.pendingMutations.has(key)) return;
  state.pendingMutations.add(key);
  renderNotifications(true);
  try {
    const result = await request(`/v1/notifications/${encodeURIComponent(notification.id)}/actions`, { method: 'POST', body: { action } });
    const messages = {
      read: t('notifications.readDone'), claim: t('notifications.claimed'), focus: t('notifications.focused'), continue: t('notifications.continued')
    };
    setToast(
      result?.notificationSync?.ok === false ? t('notifications.syncDegraded') : messages[action],
      result?.notificationSync?.ok === false ? 'warning' : 'success'
    );
    if (action === 'focus') setNotificationDrawer(false);
    await refreshNotifications();
  } catch (error) {
    if (error.status !== 401) {
      state.mutationErrors.notifications = error.message || t('error.operation');
      setToast(state.mutationErrors.notifications, 'error');
    }
  } finally {
    state.pendingMutations.delete(key);
    renderNotifications(true);
  }
}

async function markAllNotificationsRead() {
  const unread = state.notifications.filter(notificationUnread);
  if (!unread.length || state.pendingMutations.has('notification:all')) return;
  state.pendingMutations.add('notification:all');
  renderNotifications(true);
  try {
    await request('/v1/notifications/actions', { method: 'POST', body: { action: 'read_all' } });
    setToast(t('notifications.allRead'), 'success');
    await refreshNotifications();
  } catch (error) {
    if (error.status !== 401) setToast(error.message || t('error.operation'), 'error');
  } finally {
    state.pendingMutations.delete('notification:all');
    renderNotifications(true);
  }
}

async function refreshNotifications({ settings = false } = {}) {
  const settingsEpoch = state.notificationSettingsEpoch;
  const requests = [request('/v1/notifications')];
  if ((settings || !state.notificationSettings) && !state.notificationSettingsDirty) {
    requests.push(request('/v1/notification-settings'));
  }
  const results = await Promise.allSettled(requests);
  if (results[0].status === 'fulfilled') {
    state.notifications = listFrom(results[0].value, 'notifications');
    state.sectionErrors.notifications = '';
  } else if (results[0].reason?.status !== 401) state.sectionErrors.notifications = results[0].reason?.message || t('error.read');
  if (results[1]?.status === 'fulfilled' && notificationSettingsSnapshotIsCurrent(settingsEpoch)) {
    state.notificationSettings = normalizeNotificationSettings(results[1].value);
    state.sectionErrors.notificationSettings = '';
  } else if (results[1]?.status === 'rejected' &&
    notificationSettingsSnapshotIsCurrent(settingsEpoch) &&
    results[1].reason?.status !== 401) {
    state.sectionErrors.notificationSettings = results[1].reason?.message || t('error.read');
  }
  renderNotifications(true);
  renderNotificationSettings();
}

function pendingChannelSecrets(channel) {
  if (channel === 'telegram') {
    return {
      ...(ui.notificationTelegramToken.value.trim() ? { botToken: ui.notificationTelegramToken.value.trim() } : {}),
      ...(ui.notificationTelegramChat.value.trim() ? { chatId: ui.notificationTelegramChat.value.trim() } : {})
    };
  }
  if (channel === 'feishu') return {
    ...(ui.notificationFeishuWebhook.value.trim() ? { webhookUrl: ui.notificationFeishuWebhook.value.trim() } : {}),
    ...(ui.notificationFeishuSigningSecret.value.trim() ? { signingSecret: ui.notificationFeishuSigningSecret.value.trim() } : {})
  };
  return {};
}

async function saveNotificationSettings(event) {
  event.preventDefault();
  if (state.pendingMutations.has('settings:save')) return;
  const body = { channels: {
    system: { enabled: ui.notificationSystemEnabled.checked },
    telegram: { enabled: ui.notificationTelegramEnabled.checked, ...pendingChannelSecrets('telegram') },
    feishu: { enabled: ui.notificationFeishuEnabled.checked, ...pendingChannelSecrets('feishu') }
  } };
  state.pendingMutations.add('settings:save');
  advanceNotificationSettingsEpoch();
  renderNotificationSettings();
  try {
    const result = await request('/v1/notification-settings', { method: 'PATCH', body });
    state.notificationSettings = normalizeNotificationSettings(result);
    state.notificationSettingsDirty = false;
    state.mutationErrors.settings = '';
    ui.notificationTelegramToken.value = '';
    ui.notificationTelegramChat.value = '';
    ui.notificationFeishuWebhook.value = '';
    ui.notificationFeishuSigningSecret.value = '';
    renderNotificationSettings();
    setToast(t('settings.saved'), 'success');
  } catch (error) {
    if (error.status !== 401) {
      state.mutationErrors.settings = error.message || t('error.operation');
      setToast(state.mutationErrors.settings, 'error');
    }
  } finally {
    state.pendingMutations.delete('settings:save');
    advanceNotificationSettingsEpoch();
    renderNotificationSettings();
  }
}

async function testNotificationChannel(channel, buttonNode) {
  const pendingKey = `settings:test:${channel}`;
  if (buttonNode.disabled || state.pendingMutations.has(pendingKey)) return;
  state.pendingMutations.add(pendingKey);
  advanceNotificationSettingsEpoch();
  renderNotificationSettings();
  try {
    await request('/v1/notification-settings/test', { method: 'POST', body: { channel } });
    setToast(t('settings.testSent', { channel: channel === 'feishu' ? t('settings.feishu') : channel === 'system' ? t('settings.system') : 'Telegram' }), 'success');
  } catch (error) {
    if (error.status !== 401) setToast(error.message || t('error.operation'), 'error');
  } finally {
    state.pendingMutations.delete(pendingKey);
    advanceNotificationSettingsEpoch();
    await refreshNotifications({ settings: true });
    renderNotificationSettings();
  }
}

async function clearNotificationChannel(channel, buttonNode) {
  const label = channel === 'feishu' ? t('settings.feishu') : 'Telegram';
  if (!confirm(t('confirm.clearChannel', { channel: label }))) return;
  const pendingKey = `settings:clear:${channel}`;
  if (buttonNode.disabled || state.pendingMutations.has(pendingKey)) return;
  state.pendingMutations.add(pendingKey);
  advanceNotificationSettingsEpoch();
  renderNotificationSettings();
  const channels = channel === 'telegram'
    ? { telegram: { enabled: false, botToken: null, chatId: null } }
    : { feishu: { enabled: false, webhookUrl: null, signingSecret: null } };
  try {
    const result = await request('/v1/notification-settings', { method: 'PATCH', body: { channels } });
    state.notificationSettings = normalizeNotificationSettings(result);
    state.notificationSettingsDirty = false;
    ui.notificationTelegramToken.value = '';
    ui.notificationTelegramChat.value = '';
    ui.notificationFeishuWebhook.value = '';
    ui.notificationFeishuSigningSecret.value = '';
    renderNotificationSettings();
    setToast(t('settings.cleared', { channel: label }), 'success');
  } catch (error) {
    if (error.status !== 401) setToast(error.message || t('error.operation'), 'error');
  } finally {
    state.pendingMutations.delete(pendingKey);
    advanceNotificationSettingsEpoch();
    renderNotificationSettings();
  }
}

async function openSystemNotificationSettings() {
  const pendingKey = 'settings:open-system';
  if (ui.notificationSystemSettings.disabled || state.pendingMutations.has(pendingKey)) return;
  state.pendingMutations.add(pendingKey);
  advanceNotificationSettingsEpoch();
  renderNotificationSettings();
  try {
    const result = await request('/v1/notification-settings/open-system-settings', { method: 'POST' });
    state.notificationSettings = normalizeNotificationSettings(result);
    state.mutationErrors.settings = '';
    setToast(t('settings.systemOpened'), 'success');
  } catch (error) {
    if (error.status !== 401) {
      state.mutationErrors.settings = error.message || t('error.operation');
      setToast(state.mutationErrors.settings, 'error');
    }
  } finally {
    state.pendingMutations.delete(pendingKey);
    advanceNotificationSettingsEpoch();
    renderNotificationSettings();
  }
}

function renderAll(force = false) {
  const activeFocusKey = document.activeElement?.dataset?.focusKey || state.pendingFocusKey || '';
  renderTasks(force);
  renderProfiles(force);
  renderAssets(force);
  renderNotifications(force);
  renderNotificationSettings();
  if (activeFocusKey && restoreFocus(activeFocusKey)) state.pendingFocusKey = '';
  focusInitialTask();
}

function taskPageFrom(payload) {
  const data = dataFrom(payload) || {};
  return {
    tasks: listFrom(payload, 'tasks'),
    nextCursor: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null
  };
}

function taskPagePath(cursor = null) {
  const query = new URLSearchParams({ limit: String(TASK_PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  return `/v1/tasks?${query}`;
}

async function readTaskPages(pageCount = 1, { incremental = true } = {}) {
  if (incremental && pageCount > 1 && state.tasks.length) {
    const firstPage = taskPageFrom(await request(taskPagePath()));
    const merged = new Map(state.tasks.map((task) => [task.id, task]));
    for (const task of firstPage.tasks) merged.set(task.id, task);
    const firstPageIds = new Set(firstPage.tasks.map((task) => task.id));
    const watchedIds = state.tasks
      .filter((task) => (
        !TERMINAL_TASK_STATES.has(taskState(task)) ||
        state.selectedTaskIds.has(task.id) ||
        state.targetedTaskId === task.id
      ))
      .map((task) => task.id)
      .filter((id) => !firstPageIds.has(id))
      .slice(0, 16);
    const watched = await Promise.allSettled(watchedIds.map((id) => (
      request(`/v1/tasks/${encodeURIComponent(id)}`)
    )));
    for (const [index, result] of watched.entries()) {
      const id = watchedIds[index];
      if (result.status === 'fulfilled') {
        const task = dataFrom(result.value)?.task || result.value?.task || dataFrom(result.value);
        if (task?.id === id) merged.set(id, task);
      } else if (result.reason?.status === 404) {
        merged.delete(id);
        state.selectedTaskIds.delete(id);
        if (state.targetedTaskId === id) state.targetedTaskId = '';
      }
    }
    return {
      tasks: [...merged.values()],
      nextCursor: state.taskNextCursor,
      pageCount: state.taskPageCount,
      incremental: true
    };
  }
  const tasks = [];
  const seen = new Set();
  let cursor = null;
  let pagesRead = 0;
  while (pagesRead < Math.max(1, pageCount)) {
    const page = taskPageFrom(await request(taskPagePath(cursor)));
    for (const task of page.tasks) {
      if (!task?.id || seen.has(task.id)) continue;
      seen.add(task.id);
      tasks.push(task);
    }
    pagesRead += 1;
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  if (state.targetedTaskId && !seen.has(state.targetedTaskId)) {
    try {
      const payload = await request(`/v1/tasks/${encodeURIComponent(state.targetedTaskId)}`);
      const task = dataFrom(payload)?.task || payload?.task || dataFrom(payload);
      if (task?.id === state.targetedTaskId) tasks.push(task);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return { tasks, nextCursor: cursor, pageCount: pagesRead };
}

function mergeTask(task) {
  if (!task?.id) return;
  const index = state.tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.push(task);
  state.taskReceivedAt.set(task.id, Date.now());
}

function applyRefreshResult(key, result, receivedAt, notificationSettingsEpoch) {
  if (key === 'notificationSettings' && !notificationSettingsSnapshotIsCurrent(notificationSettingsEpoch)) {
    return result.status === 'fulfilled';
  }
  if (result.status === 'fulfilled') {
    state.sectionErrors[key] = '';
    if (key === 'profiles') state.profiles = listFrom(result.value, 'profiles');
    if (key === 'assets') state.assets = listFrom(result.value, 'assets');
    if (key === 'notifications') state.notifications = listFrom(result.value, 'notifications');
    if (key === 'notificationSettings') {
      state.notificationSettings = normalizeNotificationSettings(result.value);
    }
    if (key === 'tasks') {
      const page = taskPageFrom(result.value);
      state.tasks = page.tasks;
      state.taskNextCursor = page.nextCursor;
      state.taskPageCount = Number.isSafeInteger(result.value?.pageCount) ? Math.max(1, result.value.pageCount) : 1;
      state.taskReceivedAt = new Map(state.tasks.map((task) => [task.id, receivedAt]));
    }
    return true;
  }
  const error = result.reason;
  if (error?.status !== 401) state.sectionErrors[key] = error?.message || t('error.read');
  return false;
}

async function refreshAll({ force = false } = {}) {
  if (state.refreshPromise) {
    state.refreshAgain = true;
    return state.refreshPromise;
  }
  const sequence = ++state.refreshSequence;
  const notificationSettingsEpoch = state.notificationSettingsEpoch;
  ui.refreshAll.disabled = true;
  ui.refreshAll.classList.add('is-loading');
  state.refreshPromise = (async () => {
    const results = await Promise.allSettled([
      request('/v1/profiles'),
      readTaskPages(state.taskPageCount, { incremental: !force }),
      request('/v1/task-assets'),
      request('/v1/notifications'),
      (force || !state.notificationSettings) && !state.notificationSettingsDirty
        ? request('/v1/notification-settings')
        : Promise.resolve(state.notificationSettings)
    ]);
    if (sequence !== state.refreshSequence) return;
    const receivedAt = Date.now();
    const keys = ['profiles', 'tasks', 'assets', 'notifications', 'notificationSettings'];
    const successCount = results.reduce((count, result, index) => count + Number(
      applyRefreshResult(keys[index], result, receivedAt, notificationSettingsEpoch) && index < 4
    ), 0);
    const unauthorized = results.some((result) => result.status === 'rejected' && result.reason?.status === 401);
    const connectivityFailure = results.slice(0, 4).every((result) => result.status === 'rejected' && (result.reason?.status === 0 || result.reason?.status >= 500));
    if (unauthorized) markAuthorizationRequired();
    else if (successCount > 0) markConnected();
    else if (connectivityFailure) markStale();
    if (successCount > 0) {
      state.lastRefreshAt = receivedAt;
      ui.lastRefresh.textContent = t('connection.refreshed', { time: formatTime(receivedAt) });
    }
    renderAll(force);
  })();
  try {
    await state.refreshPromise;
  } finally {
    state.refreshPromise = null;
    ui.refreshAll.disabled = false;
    ui.refreshAll.classList.remove('is-loading');
    if (state.refreshAgain) {
      state.refreshAgain = false;
      void refreshAll({ force: true });
    }
  }
}

function pollingDelay() {
  if (document.visibilityState === 'hidden') return 15_000;
  return state.tasks.some((task) => !TERMINAL_TASK_STATES.has(taskState(task))) ? 2_000 : 6_000;
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (state.stopped) return;
  state.refreshTimer = setTimeout(async () => {
    await refreshAll();
    scheduleRefresh();
  }, pollingDelay());
}

function updateDurationDisplays() {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const at = Date.now();
  for (const node of document.querySelectorAll('[data-task-duration]')) {
    const task = byId.get(node.dataset.taskId);
    const kind = node.dataset.taskDuration;
    if (task && ['run', 'cooldown', 'total'].includes(kind)) node.textContent = formatDuration(taskDurations(task, at)[kind]);
  }
}

function scheduleDurationTick() {
  clearTimeout(state.durationTimer);
  if (state.stopped) return;
  state.durationTimer = setTimeout(() => {
    updateDurationDisplays();
    scheduleDurationTick();
  }, document.visibilityState === 'hidden' ? 5_000 : 1_000);
}

function focusTaskCard(taskId) {
  const card = ui.tasks.querySelector(`.task-card[data-task-id="${CSS.escape(taskId)}"]`);
  if (!card) return false;
  card.classList.add('is-targeted');
  card.focus();
  card.scrollIntoView({ block: 'center' });
  return true;
}

async function focusTaskById(taskId, { updateHistory = true, missingToast = true } = {}) {
  if (!taskId || state.taskFocusLoading) return false;
  state.taskFocusLoading = true;
  state.targetedTaskId = taskId;
  setView('tasks', { updateHistory: false, focus: false });
  try {
    if (!state.tasks.some((task) => task.id === taskId)) {
      const payload = await request(`/v1/tasks/${encodeURIComponent(taskId)}`);
      mergeTask(dataFrom(payload)?.task || payload?.task || dataFrom(payload));
    }
    renderTasks(true);
    const found = focusTaskCard(taskId);
    if (!found) throw new HttpError(t('tasks.targetMissing'), 404, 'TASK_NOT_FOUND');
    if (updateHistory) {
      const url = new URL(location.href);
      url.searchParams.delete('view');
      url.searchParams.set('task', taskId);
      history.pushState(null, '', `${url.pathname}${url.search}`);
    }
    return true;
  } catch (error) {
    if (missingToast && error.status !== 401) setToast(t('tasks.targetMissing'), 'error');
    if (state.targetedTaskId === taskId) state.targetedTaskId = '';
    const url = new URL(location.href);
    url.searchParams.delete('task');
    history.replaceState(null, '', `${url.pathname}${url.search}`);
    renderTasks(true);
    return false;
  } finally {
    state.taskFocusLoading = false;
  }
}

function focusInitialTask() {
  if (state.initialTaskHandled || !state.initialTaskId || state.authenticated !== true || state.sectionErrors.tasks) return;
  state.initialTaskHandled = true;
  void focusTaskById(state.initialTaskId, { updateHistory: false });
}

async function loadMoreTasks() {
  if (!state.taskNextCursor || state.taskLoadingMore) return;
  if (state.refreshPromise) await state.refreshPromise;
  if (!state.taskNextCursor) return;
  const cursor = state.taskNextCursor;
  state.taskLoadingMore = true;
  renderTasks(true);
  try {
    const page = taskPageFrom(await request(taskPagePath(cursor)));
    for (const task of page.tasks) mergeTask(task);
    state.taskNextCursor = page.nextCursor;
    state.taskPageCount += 1;
    state.sectionErrors.tasks = '';
  } catch (error) {
    if (error.code === 'INVALID_TASK_CURSOR' || error.status === 400) {
      state.taskPageCount = 1;
      await refreshAll({ force: true });
    } else if (error.status !== 401) {
      state.sectionErrors.tasks = error.message || t('error.read');
    }
  } finally {
    state.taskLoadingMore = false;
    renderTasks(true);
  }
}

function profileCreateVisible(visible) {
  ui.profileCreatePanel.classList.toggle('hidden', !visible);
  ui.toggleProfileCreate.setAttribute('aria-expanded', String(visible));
  if (visible) ui.profileName.focus();
  else ui.toggleProfileCreate.focus();
}

function syncCreatePolicy() {
  const persistent = ui.profileKind.value === 'persistent';
  ui.profileEngine.value = persistent ? 'chrome' : 'chromium';
  ui.profileMode.value = persistent ? 'human' : 'auto';
  ui.profileEngine.disabled = persistent;
  ui.profileMode.disabled = false;
  ui.profileEngine.title = persistent ? t('profiles.chrome') : t('profiles.chromium');
  ui.profileMode.title = persistent ? t('behavior.human') : t('behavior.autoBalanced');
}

function mutationSection(key) {
  if (key.startsWith('profile:')) return 'profiles';
  if (key.startsWith('task:')) return 'tasks';
  if (key.startsWith('asset:')) return 'assets';
  return '';
}

async function runMutation(key, operation, successMessage, { focusAfter = '' } = {}) {
  if (state.pendingMutations.has(key)) return null;
  const activeFocusKey = document.activeElement?.dataset?.focusKey || '';
  const focusIntentSequence = ++state.focusIntentSequence;
  state.pendingFocusKey = activeFocusKey;
  state.pendingMutations.add(key);
  renderAll(true);
  try {
    const result = await operation();
    const section = mutationSection(key);
    if (section) state.mutationErrors[section] = '';
    if (successMessage) setToast(successMessage, 'success');
    return result;
  } catch (error) {
    const section = mutationSection(key);
    let message = error.message || t('error.operation');
    if (error.status === 403) message = t('error.denied', { message });
    if (error.status === 409) {
      message = error.code === 'PROFILE_NAME_EXISTS'
        ? t('error.profileName')
        : error.code === 'TASK_REVISION_CONFLICT'
          ? t('error.revision')
          : t('error.refreshed', { message });
    }
    if (error.status !== 401) {
      if (section) state.mutationErrors[section] = message;
      setToast(message, 'error');
    }
    return null;
  } finally {
    state.pendingMutations.delete(key);
    await refreshAll({ force: true });
    if (focusIntentSequence === state.focusIntentSequence) {
      const target = focusAfter || activeFocusKey;
      if (target && restoreFocus(target)) state.pendingFocusKey = '';
      else if (focusAfter) document.querySelector('#tasks-title')?.focus();
    }
  }
}

async function createProfile(event) {
  event.preventDefault();
  const name = ui.profileName.value.trim();
  if (!name) return;
  const result = await runMutation('profile:create', () => request('/v1/profiles', {
    method: 'POST',
    body: {
      name,
      kind: ui.profileKind.value,
      browserEngine: ui.profileEngine.value,
      defaultBehavior: ui.profileMode.value,
      headless: ui.profileHeadless.checked
    }
  }), t('toast.profileCreated'));
  if (result) {
    ui.createProfileForm.reset();
    syncCreatePolicy();
    profileCreateVisible(false);
  }
}

async function updateProfile(profile, patch) {
  const extensionChange = Object.hasOwn(patch, 'extensionsEnabled');
  const extensionDeferred = extensionChange && !['idle', 'closed'].includes(profileState(profile));
  await runMutation(`profile:${profile.id}`, () => request(`/v1/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'PATCH', body: patch
  }), Object.hasOwn(patch, 'defaultBehavior')
    ? t('toast.speedApplied')
    : extensionChange
      ? t(extensionDeferred ? 'toast.extensionsDeferred' : 'toast.extensionsSaved')
    : t('toast.profileSaved'));
}

async function renameProfile(profile) {
  const value = prompt(t('prompt.renameProfile'), profile.name || '')?.trim();
  if (value && value !== profile.name) await updateProfile(profile, { name: value });
}

async function setProfileOpen(profile, shouldOpen) {
  const action = shouldOpen ? 'open' : 'close';
  await runMutation(`profile:${profile.id}`, () => request(`/v1/profiles/${encodeURIComponent(profile.id)}/${action}`, {
    method: 'POST'
  }), shouldOpen ? t('toast.profileOpening') : t('toast.profileClosed'));
}

async function deleteProfile(profile) {
  const quarantinedEphemeral = profile.kind === 'ephemeral' && profileState(profile) === 'error' && profile.cleanupRequired === true;
  const description = profile.kind === 'ephemeral' ? t('confirm.ephemeralData') : t('confirm.persistentData');
  const question = quarantinedEphemeral
    ? t('confirm.cleanupProfile', { name: profile.name || profile.id })
    : t('confirm.deleteProfile', { name: profile.name || profile.id, description });
  if (!confirm(question)) return;
  await runMutation(`profile:${profile.id}`, () => request(`/v1/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'DELETE'
  }), quarantinedEphemeral ? t('toast.profileResidualCleaned') : t('toast.profileDeleted'), { focusAfter: 'profiles-title' });
}

async function sendTaskAction(task, action) {
  if (state.pendingMutations.has(`task:${task.id}`)) return;
  if (action === 'cancel' && !confirm(t('confirm.cancelTask', { title: taskTitle(task) }))) return;
  if (!Number.isSafeInteger(task.revision) || task.revision < 1) {
    setToast(t('toast.taskNotReady'), 'error');
    await refreshAll({ force: true });
    return;
  }
  const labels = { pause: t('toast.pauseSent'), resume: t('toast.resumeSent'), cancel: t('toast.cancelSent') };
  await runMutation(`task:${task.id}`, () => request(`/v1/tasks/${encodeURIComponent(task.id)}/actions`, {
    method: 'POST',
    body: { action, commandId: commandId(), expectedRevision: task.revision }
  }), labels[action]);
}

async function deleteTaskRecord(task) {
  if (state.pendingMutations.has(`task:${task.id}`)) return;
  if (!confirm(t('confirm.deleteTask', { title: taskTitle(task) }))) return;
  if (!Number.isSafeInteger(task.revision) || task.revision < 1) {
    setToast(t('toast.taskNotReady'), 'error');
    await refreshAll({ force: true });
    return;
  }
  const orderedIds = [...ui.tasks.querySelectorAll('.task-card[data-task-id]')].map((node) => node.dataset.taskId);
  const index = orderedIds.indexOf(task.id);
  const nextId = orderedIds[index + 1] || orderedIds[index - 1] || '';
  const focusAfter = nextId ? `task:${nextId}:card` : 'tasks-title';
  const deleted = await runMutation(`task:${task.id}`, () => request(`/v1/tasks/${encodeURIComponent(task.id)}`, {
    method: 'DELETE',
    body: { commandId: commandId(), expectedRevision: task.revision }
  }), t('toast.taskDeleted'), { focusAfter });
  if (deleted) {
    state.selectedTaskIds.delete(task.id);
    if (state.targetedTaskId === task.id) {
      state.targetedTaskId = '';
      const url = new URL(location.href);
      url.searchParams.delete('task');
      history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
  }
}

function taskBatchActionLabel(action) {
  return t(({
    pause: 'tasks.actionPause', resume: 'tasks.actionResume', cancel: 'tasks.actionCancel', delete: 'tasks.actionDelete'
  })[action]);
}

async function executeTaskBatchItem(task, action) {
  if (!Number.isSafeInteger(task.revision) || task.revision < 1) {
    throw new HttpError(t('toast.taskNotReady'), 409, 'TASK_REVISION_CONFLICT');
  }
  if (action === 'delete') {
    return request(`/v1/tasks/${encodeURIComponent(task.id)}`, {
      method: 'DELETE',
      body: { commandId: commandId(), expectedRevision: task.revision }
    });
  }
  return request(`/v1/tasks/${encodeURIComponent(task.id)}/actions`, {
    method: 'POST',
    body: { action, commandId: commandId(), expectedRevision: task.revision }
  });
}

async function runTaskBatch(action) {
  if (state.pendingMutations.has('task:batch')) return;
  const tasks = selectedTasks();
  if (!tasks.length) return;
  if (action === 'cancel' && !confirm(t('confirm.bulkCancelTasks', { count: tasks.length }))) return;
  if (action === 'delete' && !confirm(t('confirm.bulkDeleteTasks', { count: tasks.length }))) return;

  state.pendingMutations.add('task:batch');
  state.taskBatchResults = tasks.map((task) => ({
    taskId: task.id,
    title: taskTitle(task),
    action,
    status: taskActionEligible(task, action) ? 'pending' : 'skipped',
    error: ''
  }));
  renderTasks(true);

  let cursor = 0;
  const runNext = async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      const result = state.taskBatchResults[index];
      if (result.status === 'skipped') continue;
      try {
        await executeTaskBatchItem(task, action);
        result.status = 'success';
        if (action === 'delete') {
          state.selectedTaskIds.delete(task.id);
          if (state.targetedTaskId === task.id) {
            state.targetedTaskId = '';
            const url = new URL(location.href);
            url.searchParams.delete('task');
            history.replaceState(null, '', `${url.pathname}${url.search}`);
          }
        }
      } catch (error) {
        result.status = 'failed';
        result.error = error.message || t('error.operation');
      }
      renderTaskBatchFeedback();
    }
  };

  await Promise.all(Array.from({ length: Math.min(TASK_BATCH_CONCURRENCY, tasks.length) }, () => runNext()));
  state.pendingMutations.delete('task:batch');
  const counts = state.taskBatchResults.reduce((summary, result) => {
    summary[result.status] = (summary[result.status] || 0) + 1;
    return summary;
  }, {});
  const message = t('tasks.batchDone', {
    success: counts.success || 0,
    failed: counts.failed || 0,
    skipped: counts.skipped || 0
  });
  setToast(message, counts.failed || counts.skipped ? 'warning' : 'success');
  state.mutationErrors.tasks = '';
  await refreshAll({ force: true });
  restoreFocus(`task-bulk-${action}`);
}

async function runAssetAction(action) {
  const assetIds = [...state.selectedAssetIds];
  if (!assetIds.length) return;
  const selected = state.assets.filter((asset) => state.selectedAssetIds.has(asset.id));
  let note;
  if (action === 'note') {
    const existing = selected.length === 1 ? selected[0].note || '' : '';
    const value = prompt(t('prompt.assetNote'), existing);
    if (value === null) return;
    note = value;
  }
  if (action === 'delete') {
    const names = selected.slice(0, 5).map((asset) => `“${asset.title}”`).join('、');
    const suffix = selected.length > 5 ? t('confirm.assetSuffix', { count: selected.length }) : '';
    if (!confirm(t('confirm.deleteAssets', { names, suffix }))) return;
  }
  const labels = {
    note: t('toast.noteSaved'),
    deprecate: t('toast.assetsDeprecated'),
    restore: t('toast.assetsRestored'),
    delete: t('toast.assetsDeleted')
  };
  const result = await runMutation('asset:batch', () => request('/v1/task-assets/actions', {
    method: 'POST',
    body: { action, assetIds, ...(note !== undefined ? { note } : {}) }
  }), labels[action], { focusAfter: 'assets-title' });
  if (result) {
    state.selectedAssetIds.clear();
    renderAssets(true);
  }
}

async function logout() {
  if (!confirm(t('confirm.logout'))) return;
  try {
    await request('/v1/dashboard/logout', { method: 'POST' });
    markAuthorizationRequired();
    setToast(t('toast.loggedOut'), 'success');
  } catch (error) {
    if (error.status !== 401) setToast(error.message || t('toast.logoutFailed'), 'error');
  }
}

for (const link of ui.navLinks) link.addEventListener('click', () => setView(link.dataset.view));
ui.languageToggle.addEventListener('click', () => setLanguage(state.language === 'zh-CN' ? 'en' : 'zh-CN'));
ui.notificationButton.addEventListener('click', () => setNotificationDrawer(!state.notificationDrawerOpen));
ui.notificationClose.addEventListener('click', () => setNotificationDrawer(false));
ui.notificationBackdrop.addEventListener('click', () => setNotificationDrawer(false));
ui.notificationMarkAll.addEventListener('click', () => void markAllNotificationsRead());
ui.notificationSettingsForm.addEventListener('submit', saveNotificationSettings);
for (const input of [
  ui.notificationSystemEnabled,
  ui.notificationTelegramEnabled,
  ui.notificationFeishuEnabled,
  ui.notificationTelegramToken,
  ui.notificationTelegramChat,
  ui.notificationFeishuWebhook,
  ui.notificationFeishuSigningSecret
]) {
  input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
    state.notificationSettingsDirty = true;
    renderNotificationSettings();
  });
}
ui.notificationSystemSettings.addEventListener('click', () => void openSystemNotificationSettings());
for (const testButton of ui.notificationChannelTests) {
  testButton.addEventListener('click', () => void testNotificationChannel(testButton.dataset.channel, testButton));
}
for (const clearButton of ui.notificationChannelClears) {
  clearButton.addEventListener('click', () => void clearNotificationChannel(clearButton.dataset.channel, clearButton));
}
ui.refreshAll.addEventListener('click', () => void refreshAll({ force: true }));
ui.retryAuth.addEventListener('click', () => void refreshAll({ force: true }));
ui.retryStale.addEventListener('click', () => void refreshAll({ force: true }));
ui.logoutButton.addEventListener('click', () => void logout());
ui.toggleProfileCreate.addEventListener('click', () => profileCreateVisible(true));
ui.closeProfileCreate.addEventListener('click', () => profileCreateVisible(false));
ui.profileKind.addEventListener('change', syncCreatePolicy);
ui.createProfileForm.addEventListener('submit', createProfile);
ui.taskSelectAll.addEventListener('change', () => {
  for (const task of state.tasks) {
    if (ui.taskSelectAll.checked) state.selectedTaskIds.add(task.id);
    else state.selectedTaskIds.delete(task.id);
  }
  renderTasks(true);
});
ui.taskBulkPause.addEventListener('click', () => void runTaskBatch('pause'));
ui.taskBulkResume.addEventListener('click', () => void runTaskBatch('resume'));
ui.taskBulkCancel.addEventListener('click', () => void runTaskBatch('cancel'));
ui.taskBulkDelete.addEventListener('click', () => void runTaskBatch('delete'));
ui.taskLoadMore.addEventListener('click', () => void loadMoreTasks());
ui.assetSearch.addEventListener('input', () => renderAssets(true));
ui.assetFilter.addEventListener('change', () => renderAssets(true));
ui.assetSelectAll.addEventListener('change', () => {
  for (const asset of filteredAssets()) {
    if (ui.assetSelectAll.checked) state.selectedAssetIds.add(asset.id);
    else state.selectedAssetIds.delete(asset.id);
  }
  renderAssets(true);
});
ui.assetNote.addEventListener('click', () => void runAssetAction('note'));
ui.assetDeprecate.addEventListener('click', () => void runAssetAction('deprecate'));
ui.assetRestore.addEventListener('click', () => void runAssetAction('restore'));
ui.assetDelete.addEventListener('click', () => void runAssetAction('delete'));
document.addEventListener('visibilitychange', () => {
  scheduleRefresh();
  scheduleDurationTick();
});
document.addEventListener('keydown', (event) => {
  trapNotificationDrawerFocus(event);
  if (event.key === 'Escape' && state.notificationDrawerOpen) setNotificationDrawer(false);
});
window.addEventListener('popstate', () => {
  const url = new URL(location.href);
  setView(url.searchParams.get('view') || 'tasks', { updateHistory: false, focus: false });
  const taskId = url.searchParams.get('task') || '';
  state.targetedTaskId = taskId;
  if (taskId) void focusTaskById(taskId, { updateHistory: false });
  else renderTasks(true);
});
window.addEventListener('pagehide', () => {
  state.stopped = true;
  clearTimeout(state.refreshTimer);
  clearTimeout(state.durationTimer);
});
window.addEventListener('pageshow', () => {
  if (!state.stopped) return;
  state.stopped = false;
  void refreshAll({ force: true });
  scheduleRefresh();
  scheduleDurationTick();
});

const initialUrl = new URL(location.href);
applyStaticLanguage();
setView(initialUrl.searchParams.get('view') || 'tasks', { updateHistory: false, focus: false });
syncCreatePolicy();
void bootstrapOwnerSession()
  .catch((error) => {
    if (error.status !== 401) setToast(error.message || t('toast.ownerFailed'), 'error');
  })
  .then(() => refreshAll({ force: true }))
  .finally(() => {
    scheduleRefresh();
    scheduleDurationTick();
  });
