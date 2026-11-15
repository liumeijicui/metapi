import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import CenteredModal from '../components/CenteredModal.js';
import ModernSelect from '../components/ModernSelect.js';
import { useToast } from '../components/Toast.js';

type InstaboxConfig = {
  configured: boolean;
  keyReadable: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
};

type Machine = {
  id: string;
  name: string;
  state: string;
  desiredState?: string;
  operationId?: string | null;
  template?: { id?: string; version?: string };
  spec?: { vcpus?: number; memMiB?: number; persistentDiskGiB?: number };
  storage?: { synced?: boolean; sizeGiB?: number };
  runtime?: { ready?: boolean; processesPreserved?: boolean };
  autoSuspendAfterSeconds?: number | null;
  maxRunMinutes?: number | null;
  runStartedAt?: string | null;
  cooldownUntil?: string | null;
  free?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastError?: { message?: string; code?: string } | null;
};

type InstaboxPort = {
  id?: string;
  port: number;
  name?: string;
  url?: string;
  tokenUrl?: string;
  access?: string;
  protocol?: string;
  createdAt?: string;
};

type InstaboxUsage = {
  storedBytes?: number;
  logicalBytes?: number;
  machines?: number;
  snapshots?: number;
  computedAt?: string | null;
  limits?: { maxMachines?: number; maxSnapshots?: number; maxStoredGiB?: number };
  cost?: {
    costUSD?: number;
    creditRemainingUSD?: number;
    allowanceUSD?: number;
    overageUSD?: number;
  };
};

type InstaboxTemplate = {
  id: string;
  version?: string;
  description?: string;
  creatable?: boolean;
  default?: boolean;
  latest?: boolean;
  hidden?: boolean;
  defaultSpec?: { vcpus?: number; memMiB?: number };
};

type InstaboxOrg = {
  id?: string;
  name?: string;
  tier?: string;
  personal?: boolean;
  limits?: { maxMachines?: number; maxRunning?: number; maxSnapshots?: number; maxStoredGiB?: number; freeSandboxHours?: number };
};

type Overview = {
  config: InstaboxConfig;
  machines: Machine[];
  usage: InstaboxUsage | null;
  templates: InstaboxTemplate[];
  org: InstaboxOrg | null;
  keepalive: KeepaliveStatus | null;
};

type KeepaliveStatus = {
  enabled: boolean;
  windows: { start: string; end: string }[];
  intervalMinutes: number;
  inWindow: boolean;
  currentWindow: { start: string; end: string } | null;
  nextWindowStart: string | null;
  lastTickAt: string | null;
  lastAttemptAt: string | null;
  lastKeepaliveAt: string | null;
  nextKeepaliveAt: string | null;
  machine: { id: string; name: string; state: string } | null;
  lastResult: 'idle' | 'kept_alive' | 'suspended' | 'skipped' | 'limit_reached' | 'error' | 'disabled';
  message: string;
  lastError: string | null;
};

type InstaboxSshAccess = {
  machineId: string;
  available: boolean;
  command: string | null;
  expiresAt: string | null;
  remainingSeconds: number | null;
  expiringSoon: boolean;
  autoRenew: boolean;
  renewed: boolean;
  warning: string | null;
};

type InstaboxFileUpload = {
  path: string;
  size: number;
  sha256: string;
  mode: string;
  created: boolean;
  replaced: boolean;
};

const EMPTY_CONFIG: InstaboxConfig = {
  configured: false,
  keyReadable: false,
  maskedKey: null,
  updatedAt: null,
  lastVerifiedAt: null,
};

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

const inputStyle = {
  width: '100%',
  padding: '9px 12px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 13,
  outline: 'none',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
};

const panelStyle = {
  background: 'var(--color-bg-card)',
  border: '1px solid var(--color-border-light)',
  borderRadius: 'var(--radius-md)',
  boxShadow: 'var(--shadow-card)',
};

const stateLabelMap: Record<string, string> = {
  creating: '创建中',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  stopped: '已停止',
  suspending: '暂停中',
  suspended: '已暂停',
  resuming: '恢复中',
  deleting: '删除中',
  deleted: '已删除',
  error: '异常',
};

function stateTone(state: string): string {
  if (state === 'running') return 'badge-success';
  if (state === 'suspended' || state === 'stopped') return 'badge-warning';
  if (state === 'error' || state === 'deleted') return 'badge-error';
  if (['creating', 'starting', 'stopping', 'suspending', 'resuming', 'deleting'].includes(state)) return 'badge-info';
  return 'badge-muted';
}

function isTransitioning(state: string): boolean {
  return ['creating', 'starting', 'stopping', 'suspending', 'resuming', 'deleting'].includes(state);
}

function formatBytes(value: number | undefined | null): string {
  if (!Number.isFinite(Number(value))) return '-';
  const bytes = Math.max(0, Number(value));
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function formatMemory(memMiB: number | undefined): string {
  if (!Number.isFinite(Number(memMiB))) return '-';
  const value = Number(memMiB);
  return value >= 1024 ? `${(value / 1024).toFixed(0)} GiB` : `${value} MiB`;
}

function formatUsd(value: number | undefined | null): string {
  if (!Number.isFinite(Number(value))) return '-';
  return `$${Number(value).toFixed(2)}`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (!Number.isFinite(Number(seconds))) return '-';
  let remaining = Math.max(0, Math.floor(Number(seconds)));
  const days = Math.floor(remaining / 86_400);
  remaining %= 86_400;
  const hours = Math.floor(remaining / 3_600);
  remaining %= 3_600;
  const minutes = Math.floor(remaining / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function asError(error: any): string {
  return String(error?.message || error || '操作失败');
}

export default function InstaBox() {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview>({
    config: EMPTY_CONFIG,
    machines: [],
    usage: null,
    templates: [],
    org: null,
    keepalive: null,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Machine | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [portsTarget, setPortsTarget] = useState<Machine | null>(null);
  const [ports, setPorts] = useState<InstaboxPort[]>([]);
  const [portsEnabled, setPortsEnabled] = useState(true);
  const [portsLoading, setPortsLoading] = useState(false);
  const [portValue, setPortValue] = useState('');
  const [portName, setPortName] = useState('');
  const [portAccess, setPortAccess] = useState<'public' | 'private'>('public');
  const [publishingPort, setPublishingPort] = useState(false);
  const [removingPort, setRemovingPort] = useState<number | null>(null);
  const [togglingKeepalive, setTogglingKeepalive] = useState(false);
  const [connectionTarget, setConnectionTarget] = useState<Machine | null>(null);
  const [sshAccess, setSshAccess] = useState<InstaboxSshAccess | null>(null);
  const [sshLoading, setSshLoading] = useState(false);
  const [sshRefreshing, setSshRefreshing] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPath, setUploadPath] = useState('/data/workspace/');
  const [uploadLocalPath, setUploadLocalPath] = useState('');
  const [uploadCommandPath, setUploadCommandPath] = useState('/data/home/jar/');
  const [uploadCommand, setUploadCommand] = useState('');
  const [generatingUploadCommand, setGeneratingUploadCommand] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<InstaboxFileUpload | null>(null);
  const [uploadDragOver, setUploadDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await api.getInstaboxOverview();
      setOverview({
        config: result?.config ?? EMPTY_CONFIG,
        machines: Array.isArray(result?.machines) ? result.machines : [],
        usage: result?.usage ?? null,
        templates: Array.isArray(result?.templates) ? result.templates : [],
        org: result?.org ?? null,
        keepalive: result?.keepalive ?? null,
      });
    } catch (error: any) {
      setLoadError(asError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const machines = overview.machines;
  const config = overview.config;
  const usage = overview.usage;
  const org = overview.org;
  const keepalive = overview.keepalive;
  const runningCount = machines.filter((machine) => machine.state === 'running').length;
  const pausedCount = machines.filter((machine) => machine.state === 'suspended').length;
  const stoppedCount = machines.filter((machine) => ['stopped', 'error'].includes(machine.state)).length;
  const maxMachines = usage?.limits?.maxMachines ?? org?.limits?.maxMachines ?? 0;
  const maxStoredGiB = usage?.limits?.maxStoredGiB ?? org?.limits?.maxStoredGiB ?? 0;
  const storedGiB = Number(usage?.storedBytes || 0) / (1024 ** 3);
  const monthCost = usage?.cost?.costUSD;
  const creditRemaining = usage?.cost?.creditRemainingUSD;

  const loadKeepalive = useCallback(async () => {
    if (!config.configured) return;
    try {
      const result = await api.getInstaboxKeepalive();
      setOverview((current) => ({ ...current, keepalive: result?.keepalive ?? current.keepalive }));
    } catch {
      // The main refresh still surfaces connection errors; a transient keepalive
      // poll must not replace the page with an error banner.
    }
  }, [config.configured]);

  useEffect(() => {
    if (!config.configured) return;
    const timer = window.setInterval(() => { void loadKeepalive(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [config.configured, loadKeepalive]);

  const templateOptions = useMemo(() => {
    const visible = overview.templates.filter((template) => template.creatable !== false && template.hidden !== true);
    const ordered = [...visible].sort((left, right) => {
      if (left.default !== right.default) return left.default ? -1 : 1;
      if (left.id === 'agent-browser' && right.id !== 'agent-browser') return -1;
      if (right.id === 'agent-browser' && left.id !== 'agent-browser') return 1;
      return left.id.localeCompare(right.id);
    });
    return ordered.map((template) => ({
      value: template.id,
      label: `${template.id}${template.version ? ` · ${template.version}` : ''}${template.default ? '（默认）' : ''}`,
      description: template.description,
    }));
  }, [overview.templates]);

  const openCreate = () => {
    setCreateName('');
    const fallback = overview.templates.find((template) => template.default)
      ?? overview.templates.find((template) => template.id === 'agent-browser')
      ?? overview.templates.find((template) => template.creatable !== false && template.hidden !== true);
    setTemplateId(fallback?.id || '');
    setCreateOpen(true);
  };

  const openConfig = () => {
    setApiKeyInput('');
    setConfigOpen(true);
  };

  const handleSaveConfig = async () => {
    const value = apiKeyInput.trim();
    if (!value) {
      toast.info('请输入 InstaBox API Key');
      return;
    }
    setSavingKey(true);
    try {
      const result = await api.saveInstaboxConfig(value);
      setOverview((current) => ({ ...current, config: result?.config ?? current.config }));
      setApiKeyInput('');
      setConfigOpen(false);
      toast.success('InstaBox API Key 已验证并加密保存');
      await load();
    } catch (error: any) {
      toast.error(asError(error));
    } finally {
      setSavingKey(false);
    }
  };

  const handleTestConfig = async () => {
    setTestingKey(true);
    try {
      await api.testInstaboxConfig();
      toast.success('InstaBox 连接正常');
      await load();
    } catch (error: any) {
      toast.error(asError(error));
    } finally {
      setTestingKey(false);
    }
  };

  const handleClearConfig = async () => {
    if (!window.confirm('确认移除 InstaBox API Key？移除后将无法管理云机器，但不会删除 InstaBox 上的机器。')) return;
    try {
      await api.clearInstaboxConfig();
      setOverview({ config: EMPTY_CONFIG, machines: [], usage: null, templates: [], org: null, keepalive: null });
      toast.success('已移除 InstaBox API Key');
    } catch (error: any) {
      toast.error(asError(error));
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      await api.createInstaboxMachine({
        name: createName.trim() || undefined,
        templateId: templateId || undefined,
        desiredState: 'running',
      });
      setCreateOpen(false);
      toast.success('机器创建任务已提交，正在启动');
      window.setTimeout(() => void load(), 1800);
    } catch (error: any) {
      toast.error(asError(error));
    } finally {
      setCreating(false);
    }
  };

  const handleToggleKeepalive = async (enabled: boolean) => {
    setTogglingKeepalive(true);
    try {
      const result = await api.setInstaboxKeepalive(enabled);
      setOverview((current) => ({ ...current, keepalive: result?.keepalive ?? current.keepalive }));
      toast.success(enabled ? '自动保活已开启' : '自动保活已关闭');
    } catch (error: any) {
      toast.error(`设置保活失败：${asError(error)}`);
    } finally {
      setTogglingKeepalive(false);
    }
  };

  const handleMachineAction = async (machine: Machine, action: 'start' | 'stop' | 'suspend' | 'resume') => {
    const key = `${machine.id}:${action}`;
    setBusyAction(key);
    try {
      await api.instaboxMachineAction(machine.id, action);
      const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : action === 'suspend' ? '暂停' : '恢复';
      toast.success(`${machine.name} ${label}任务已提交`);
      window.setTimeout(() => void load(), 1200);
    } catch (error: any) {
      toast.error(asError(error));
    } finally {
      setBusyAction('');
    }
  };

  const handleRestart = async (machine: Machine) => {
    if (!window.confirm(`确认重启 ${machine.name}？会先停止再启动，未落盘的写入可能丢失。`)) return;
    setBusyAction(`${machine.id}:restart`);
    try {
      await api.restartInstaboxMachine(machine.id);
      toast.success(`${machine.name} 已重启`);
      await load();
    } catch (error: any) {
      toast.error(asError(error));
    } finally {
      setBusyAction('');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteInstaboxMachine(deleteTarget.id);
      setDeleteTarget(null);
      toast.success(`${deleteTarget.name} 删除任务已提交`);
      window.setTimeout(() => void load(), 1600);
    } catch (error: any) {
      toast.error(asError(error));
    } finally {
      setDeleting(false);
    }
  };

  const loadPorts = async (machine: Machine) => {
    setPortsLoading(true);
    try {
      const result = await api.getInstaboxPorts(machine.id);
      setPortsEnabled(result?.enabled !== false);
      setPorts(Array.isArray(result?.ports) ? result.ports : []);
    } catch (error: any) {
      toast.error(asError(error));
      setPorts([]);
    } finally {
      setPortsLoading(false);
    }
  };

  const openPorts = (machine: Machine) => {
    setPortsTarget(machine);
    setPorts([]);
    setPortValue('');
    setPortName('');
    setPortAccess('public');
    void loadPorts(machine);
  };

  const handlePublishPort = async () => {
    if (!portsTarget) return;
    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      toast.info('请输入 1024 到 65535 之间的端口');
      return;
    }
    setPublishingPort(true);
    try {
      await api.publishInstaboxPort(portsTarget.id, {
        port,
        name: portName.trim() || undefined,
        access: portAccess,
        protocol: 'http',
      });
      setPortValue('');
      setPortName('');
      toast.success('端口已发布');
      await loadPorts(portsTarget);
    } catch (error: any) {
      toast.error(asError(error));
    } finally {
      setPublishingPort(false);
    }
  };

  const handleUnpublishPort = async (port: InstaboxPort) => {
    if (!portsTarget) return;
    if (!window.confirm(`确认取消发布端口 ${port.port}？`)) return;
    setRemovingPort(port.port);
    try {
      await api.unpublishInstaboxPort(portsTarget.id, port.port);
      toast.success('端口已取消发布');
      await loadPorts(portsTarget);
    } catch (error: any) {
      toast.error(asError(error));
    } finally {
      setRemovingPort(null);
    }
  };

  const loadSshAccess = async (machine: Machine, refresh = false) => {
    if (refresh) setSshRefreshing(true);
    else setSshLoading(true);
    try {
      const result = refresh
        ? await api.refreshInstaboxSsh(machine.id)
        : await api.getInstaboxSsh(machine.id);
      setSshAccess(result?.ssh ?? null);
      if (refresh) toast.success('SSH token 已续期，旧 token 仍可继续使用');
    } catch (error: any) {
      toast.error(asError(error));
      if (!refresh) setSshAccess(null);
    } finally {
      if (refresh) setSshRefreshing(false);
      else setSshLoading(false);
    }
  };

  const openConnection = (machine: Machine) => {
    setConnectionTarget(machine);
    setSshAccess(null);
    setUploadFile(null);
    setUploadPath('/data/workspace/');
    setUploadLocalPath('');
    setUploadCommandPath('/data/home/jar/');
    setUploadCommand('');
    setGeneratingUploadCommand(false);
    setUploadResult(null);
    setUploadDragOver(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    void loadSshAccess(machine);
  };

  const closeConnection = () => {
    setConnectionTarget(null);
    setSshAccess(null);
    setUploadFile(null);
    setUploadLocalPath('');
    setUploadCommand('');
    setGeneratingUploadCommand(false);
    setUploadResult(null);
    setUploading(false);
    setUploadDragOver(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePickUploadFile = (file: File | null) => {
    setUploadResult(null);
    if (!file) {
      setUploadFile(null);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('单个文件不能超过 5 GiB');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setUploadFile(file);
    setUploadPath(`/data/workspace/${file.name}`);
  };

  const handleUploadFile = async () => {
    if (!connectionTarget || !uploadFile) {
      toast.info('请先选择要上传的文件');
      return;
    }
    const targetPath = uploadPath.trim();
    if (!targetPath.startsWith('/data/') || targetPath.endsWith('/')) {
      toast.info('请输入 /data/ 下的完整文件路径');
      return;
    }
    setUploading(true);
    setUploadResult(null);
    try {
      let result;
      try {
        result = await api.uploadInstaboxFile(connectionTarget.id, targetPath, uploadFile, false);
      } catch (error: any) {
        const message = asError(error);
        if (!message.includes('目标文件已存在')) throw error;
        if (!window.confirm(`文件 ${targetPath} 已存在，确认覆盖？`)) return;
        result = await api.uploadInstaboxFile(connectionTarget.id, targetPath, uploadFile, true);
      }
      const file = result?.file as InstaboxFileUpload;
      setUploadResult(file);
      toast.success(`已上传到 ${file?.path || targetPath}`);
    } catch (error: any) {
      toast.error(`上传失败：${asError(error)}`);
    } finally {
      setUploading(false);
    }
  };

  const handleGenerateUploadCommand = async () => {
    if (!connectionTarget) return;
    const localPath = uploadLocalPath.trim();
    if (!localPath) {
      toast.info('请先填写本地文件路径');
      return;
    }
    const fileName = localPath.split(/[\\/]/).pop() || '';
    // 从资源管理器复制路径时常带外层引号；原样拼进去会变成文件名的一部分
    // （URL 里的 %22），上传后 jar 名字不对，后续启动就找不到文件。
    // 双引号可能只残留一侧；单引号只在成对时剥，文件名里的撇号要保留。
    let targetInput = uploadCommandPath.trim().replace(/^"+|"+$/g, '').trim();
    if (targetInput.length >= 2 && targetInput.startsWith("'") && targetInput.endsWith("'")) {
      targetInput = targetInput.slice(1, -1).trim();
    }
    const targetPath = targetInput.endsWith('/') ? `${targetInput}${fileName}` : targetInput;
    if (!targetPath.startsWith('/data/') || targetPath.endsWith('/')) {
      toast.info('目标路径必须是 /data/ 下的完整文件路径');
      return;
    }
    setGeneratingUploadCommand(true);
    try {
      const result = await api.createInstaboxUploadCommand(connectionTarget.id, targetPath, localPath);
      setUploadCommand(String(result?.command || ''));
      if (!targetInput) setUploadCommandPath(String(result?.path || targetPath));
      toast.success('上传命令已生成');
    } catch (error: any) {
      toast.error(`生成失败：${asError(error)}`);
    } finally {
      setGeneratingUploadCommand(false);
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label}已复制`);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };

  const renderMachineActions = (machine: Machine) => {
    const disabled = isTransitioning(machine.state);
    const busy = (action: string) => busyAction === `${machine.id}:${action}`;
    const startAction = machine.state === 'suspended' ? 'resume' : 'start';
    const startLabel = machine.state === 'suspended' ? '恢复' : '启动';

    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {machine.state === 'stopped' || machine.state === 'suspended' || machine.state === 'error' ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={disabled || !!busyAction}
            onClick={() => void handleMachineAction(machine, startAction)}
          >
            {busy(startAction) ? '提交中…' : startLabel}
          </button>
        ) : null}
        {machine.state === 'running' || machine.state === 'starting' ? (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={disabled || !!busyAction}
              onClick={() => void handleMachineAction(machine, 'suspend')}
            >
              {busy('suspend') ? '提交中…' : '暂停'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={disabled || !!busyAction}
              onClick={() => void handleMachineAction(machine, 'stop')}
            >
              {busy('stop') ? '提交中…' : '停止'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={disabled || !!busyAction}
              onClick={() => void handleRestart(machine)}
            >
              {busy('restart') ? '重启中…' : '重启'}
            </button>
          </>
        ) : null}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => openConnection(machine)}>
          连接与文件
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openPorts(machine)}>
          端口
        </button>
        <button type="button" className="btn btn-danger btn-sm" onClick={() => setDeleteTarget(machine)}>
          删除
        </button>
      </div>
    );
  };

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>InstaBox 云机器</h1>
          <div style={{ marginTop: 5, fontSize: 12, color: 'var(--color-text-muted)' }}>
            管理云端沙箱的启动、暂停、停止、端口和用量。API Key 只保存在服务器端并加密存储。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={() => void load()}>
            {loading ? '刷新中…' : '立即刷新'}
          </button>
          {config.configured ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={openCreate} disabled={!config.keyReadable}>
              新建机器
            </button>
          ) : null}
        </div>
      </div>

      {!config.configured ? (
        <div style={{ ...panelStyle, padding: 18 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>先配置 InstaBox API Key</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7, marginBottom: 12 }}>
            在 InstaBox 控制台创建 API Key 后填入这里。保存时会先验证连接，成功后才写入数据库；前端之后只会看到脱敏后的值。
          </div>
          <button type="button" className="btn btn-primary" onClick={openConfig}>配置 API Key</button>
        </div>
      ) : (
        <div style={{ ...panelStyle, padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className={`badge ${config.keyReadable ? 'badge-success' : 'badge-error'}`}>
              {config.keyReadable ? '密钥已配置' : '密钥不可读'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>{config.maskedKey || '-'}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>上次验证：{formatTime(config.lastVerifiedAt)}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={testingKey} onClick={() => void handleTestConfig()}>
              {testingKey ? '验证中…' : '验证连接'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={openConfig}>更新密钥</button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void handleClearConfig()}>移除密钥</button>
          </div>
        </div>
      )}

      {loadError ? (
        <div className="alert alert-error" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <span>{loadError}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>重试</button>
        </div>
      ) : null}

      {config.configured ? (
        <>
          <div style={{ ...panelStyle, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>自动保活</span>
                  <span className={`badge ${keepalive?.enabled ? 'badge-success' : 'badge-muted'}`}>
                    {keepalive?.enabled ? '已开启' : '已关闭'}
                  </span>
                  {keepalive ? (
                    <span className={`badge ${keepalive.inWindow ? 'badge-success' : 'badge-muted'}`}>
                      {keepalive.inWindow ? '保活时段内' : '当前不在保活时段'}
                    </span>
                  ) : null}
                </div>
                <div style={{ marginTop: 5, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.65 }}>
                  每 {keepalive?.intervalMinutes ?? 20} 分钟记录一次活动；空闲自动暂停后会直接唤醒。只处理空闲暂停，不覆盖你手动暂停或停止的机器。
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: keepalive ? 'pointer' : 'default', fontSize: 12 }}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={keepalive?.enabled ?? true}
                  disabled={!keepalive || togglingKeepalive}
                  onChange={(event) => void handleToggleKeepalive(event.target.checked)}
                />
                <span>{togglingKeepalive ? '设置中…' : keepalive?.enabled ? '默认开启' : '已关闭'}</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(keepalive?.windows ?? [{ start: '08:20', end: '12:45' }, { start: '13:55', end: '22:00' }]).map((window) => (
                <span key={`${window.start}-${window.end}`} className="badge badge-info" style={{ fontFamily: 'var(--font-mono)' }}>
                  {window.start}–{window.end}
                </span>
              ))}
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                按计划自动开机/关机：时段开始唤醒，时段结束主动暂停（磁盘与数据保留）。免费套餐连续运行上限 480 分钟，达到上限会被平台提前暂停并进入冷却。
              </span>
            </div>

            {keepalive ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px 16px', fontSize: 11, color: 'var(--color-text-muted)' }}>
                  <div>当前机器<div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{keepalive.machine ? `${keepalive.machine.name} · ${keepalive.machine.state}` : '-'}</div></div>
                  <div>上次保活<div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{formatTime(keepalive.lastKeepaliveAt)}</div></div>
                  <div>下次唤醒<div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{keepalive.inWindow ? formatTime(keepalive.nextKeepaliveAt) : '-'}</div></div>
                  <div>下次开机<div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{formatTime(keepalive.nextWindowStart)}</div></div>
                </div>
                <div className={`alert ${keepalive.lastResult === 'error' ? 'alert-error' : keepalive.lastResult === 'limit_reached' ? 'alert-warning' : 'alert-info'}`}>
                  {keepalive.message}
                  {keepalive.lastError && !keepalive.message.includes(keepalive.lastError) ? `（${keepalive.lastError}）` : ''}
                </div>
              </>
            ) : (
              <div className="alert alert-info">正在读取保活状态…</div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {[
              { label: '机器总数', value: `${machines.length}${maxMachines ? ` / ${maxMachines}` : ''}`, hint: org?.tier ? `${org.tier} 套餐` : 'InstaBox' },
              { label: '运行中', value: String(runningCount), hint: `暂停 ${pausedCount} · 停止 ${stoppedCount}` },
              { label: '已用存储', value: storedGiB ? `${storedGiB.toFixed(2)} GiB` : formatBytes(usage?.storedBytes), hint: maxStoredGiB ? `限额 ${maxStoredGiB} GiB` : '按实际计费' },
              { label: '本月费用', value: formatUsd(monthCost), hint: creditRemaining != null ? `剩余额度 ${formatUsd(creditRemaining)}` : '按 InstaBox 账单' },
            ].map((item) => (
              <div key={item.label} style={{ ...panelStyle, padding: '12px 14px', minHeight: 70 }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{item.label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{item.value}</div>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>{item.hint}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>我的机器</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              空闲暂停会保留进程；停止后再启动会保留文件但进程需要重新启动。
            </div>
          </div>

          {loading && machines.length === 0 ? (
            <div className="skeleton" style={{ height: 160, borderRadius: 12 }} />
          ) : machines.length === 0 ? (
            <div style={{ ...panelStyle, padding: 28, textAlign: 'center', color: 'var(--color-text-muted)' }}>
              还没有机器。点击右上角“新建机器”创建一个云端沙箱。
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 12 }}>
              {machines.map((machine) => (
                <div key={machine.id} style={{ ...panelStyle, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <div style={{ fontSize: 15, fontWeight: 700 }}>{machine.name || machine.id}</div>
                        <span className={`badge ${stateTone(machine.state)}`}>{stateLabelMap[machine.state] || machine.state}</span>
                        {machine.free ? <span className="badge badge-info">免费额度</span> : null}
                      </div>
                      <button
                        type="button"
                        className="btn-link"
                        style={{ marginTop: 5, padding: 0, fontSize: 10, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}
                        onClick={() => void copyText(machine.id, '机器 ID')}
                        title="点击复制机器 ID"
                      >
                        {machine.id}
                      </button>
                    </div>
                    <div style={{ width: 8, height: 8, borderRadius: 999, flexShrink: 0, marginTop: 7, background: machine.state === 'running' ? '#16a34a' : machine.state === 'error' ? '#dc2626' : '#d97706' }} />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px 12px', fontSize: 11, color: 'var(--color-text-muted)' }}>
                    <div>模板<div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{machine.template?.id || '-'}{machine.template?.version ? `@${machine.template.version}` : ''}</div></div>
                    <div>规格<div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{machine.spec?.vcpus ?? '-'} vCPU · {formatMemory(machine.spec?.memMiB)}</div></div>
                    <div>数据盘<div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{machine.spec?.persistentDiskGiB ?? machine.storage?.sizeGiB ?? '-'} GiB</div></div>
                    <div>运行起始<div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{formatTime(machine.runStartedAt)}</div></div>
                    <div>空闲暂停<div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{machine.autoSuspendAfterSeconds ? `${Math.round(machine.autoSuspendAfterSeconds / 60)} 分钟` : '-'}</div></div>
                    <div>最长运行<div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{machine.maxRunMinutes === -1 ? '不限' : machine.maxRunMinutes ? `${machine.maxRunMinutes} 分钟` : '-'}</div></div>
                  </div>

                  {machine.cooldownUntil ? (
                    <div style={{ fontSize: 11, color: '#d97706' }}>冷却至 {formatTime(machine.cooldownUntil)}</div>
                  ) : null}
                  {machine.lastError?.message ? (
                    <div style={{ fontSize: 11, color: '#dc2626', lineHeight: 1.5 }}>{machine.lastError.message}</div>
                  ) : null}

                  {renderMachineActions(machine)}
                </div>
              ))}
            </div>
          )}

          <div style={{ ...panelStyle, padding: 14, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--color-text-muted)' }}>
            <span>快照：{usage?.snapshots ?? 0}{usage?.limits?.maxSnapshots ? ` / ${usage.limits.maxSnapshots}` : ''}</span>
            <span>存储测量：{formatTime(usage?.computedAt)}</span>
            <span>本月额度：{formatUsd(usage?.cost?.allowanceUSD)}</span>
            <span>超额：{formatUsd(usage?.cost?.overageUSD)}</span>
          </div>
        </>
      ) : null}

      <CenteredModal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        title={config.configured ? '更新 InstaBox API Key' : '配置 InstaBox API Key'}
        maxWidth={620}
        footer={(
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setConfigOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={savingKey} onClick={() => void handleSaveConfig()}>
              {savingKey ? '验证并保存中…' : '验证并保存'}
            </button>
          </div>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
            API Key 会先请求 InstaBox 验证，成功后使用本机独立密钥加密写入数据库。页面和接口都不会返回完整 Key。
          </div>
          {config.maskedKey ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>当前：<code>{config.maskedKey}</code></div>
          ) : null}
          <input
            type="password"
            autoComplete="new-password"
            style={inputStyle}
            placeholder="ibk_..."
            value={apiKeyInput}
            onChange={(event) => setApiKeyInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleSaveConfig();
            }}
          />
        </div>
      </CenteredModal>

      <CenteredModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建 InstaBox 机器"
        maxWidth={620}
        footer={(
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={creating} onClick={() => void handleCreate()}>
              {creating ? '提交中…' : '创建并启动'}
            </button>
          </div>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
            <span>机器名（可选，小写字母、数字和短横线）</span>
            <input
              style={inputStyle}
              value={createName}
              maxLength={63}
              placeholder="例如 my-box"
              onChange={(event) => setCreateName(event.target.value.toLowerCase())}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
            <span>模板</span>
            {templateOptions.length > 0 ? (
              <ModernSelect
                value={templateId}
                onChange={setTemplateId}
                options={templateOptions}
                placeholder="选择模板"
                searchable
                searchPlaceholder="搜索模板"
              />
            ) : (
              <input style={inputStyle} value="agent-browser（平台默认）" disabled />
            )}
          </label>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
            免费套餐默认 4 vCPU / 8 GiB、20 GiB 数据盘，空闲 30 分钟自动暂停，连续运行上限 480 分钟。
          </div>
        </div>
      </CenteredModal>

      <CenteredModal
        open={!!connectionTarget}
        onClose={closeConnection}
        title={`${connectionTarget?.name || '机器'} · 连接与文件`}
        maxWidth={820}
        footer={(
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={closeConnection}>关闭</button>
          </div>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>SSH 连接</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {sshAccess?.available ? <span className="badge badge-success">可用</span> : null}
                {sshAccess?.renewed ? <span className="badge badge-info">刚刚自动续期</span> : null}
                {sshAccess?.autoRenew ? <span className="badge badge-muted">自动续期</span> : null}
              </div>
            </div>

            {sshLoading ? (
              <div className="skeleton" style={{ height: 92, borderRadius: 8 }} />
            ) : sshAccess?.available && sshAccess.command ? (
              <>
                <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)', padding: '10px 12px' }}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.65 }}>
                    {sshAccess.command}
                  </pre>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
                    到期：{formatTime(sshAccess.expiresAt)} · 剩余 {formatDuration(sshAccess.remainingSeconds)}
                    {sshAccess.expiringSoon ? ' · 即将自动续期' : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void copyText(sshAccess.command!, 'SSH 命令')}>
                      复制 SSH 命令
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={sshRefreshing || !connectionTarget}
                      onClick={() => connectionTarget && void loadSshAccess(connectionTarget, true)}
                    >
                      {sshRefreshing ? '续期中…' : '立即续期'}
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
                  系统每小时检查一次，剩余不足 7 天时自动创建新的 30 天 token。续期不会撤销旧 token，因此正在使用的 Xshell / SSH 会话不会被断开；旧 token 会自然到期。
                </div>
                {sshAccess.warning ? <div className="alert alert-warning">{sshAccess.warning}</div> : null}
              </>
            ) : (
              <div className="alert alert-error">暂时无法生成 SSH 连接。请点击“立即续期”或检查 InstaBox API Key。</div>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--color-border-light)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>上传文件</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
              文件直接写入机器数据盘，重启后仍保留。单文件上限 5 GiB（InstaBox 官方上限），默认目录 <code>/data/workspace</code>。
            </div>
            <div style={{ border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-muted, var(--color-bg))', padding: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>生成一行上传命令</div>
                <span className="badge badge-muted">适合大文件 / 本机网络</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
                填入本机文件路径，生成可在 Windows PowerShell 直接粘贴执行的 <code>curl.exe</code> 命令。目标路径以 <code>/</code> 结尾时会自动拼接文件名。
              </div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                <span>本地文件路径</span>
                <input
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                  value={uploadLocalPath}
                  onChange={(event) => {
                    setUploadLocalPath(event.target.value);
                    setUploadCommand('');
                  }}
                  placeholder="D:\jar\daas-dpms.jar"
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                <span>目标路径</span>
                <input
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                  value={uploadCommandPath}
                  onChange={(event) => {
                    setUploadCommandPath(event.target.value);
                    setUploadCommand('');
                  }}
                  placeholder="/data/home/jar/"
                />
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={generatingUploadCommand || !uploadLocalPath.trim()} onClick={() => void handleGenerateUploadCommand()}>
                  {generatingUploadCommand ? '生成中…' : '生成上传命令'}
                </button>
              </div>
              {uploadCommand ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <textarea
                      readOnly
                      rows={1}
                      wrap="off"
                      value={uploadCommand}
                      onFocus={(event) => event.currentTarget.select()}
                      style={{ ...inputStyle, flex: 1, minWidth: 0, resize: 'none', overflowX: 'auto', whiteSpace: 'pre', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.8 }}
                    />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyText(uploadCommand, '上传命令')}>
                      复制
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
                    将上传到 <code>{uploadCommandPath}</code>。命令可直接粘贴到 CMD 或 PowerShell 执行；包含 InstaBox API Key，请勿分享给他人。
                  </div>
                </div>
              ) : null}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              onChange={(event) => handlePickUploadFile(event.target.files?.[0] ?? null)}
              style={{ display: 'none' }}
            />
            <div
              role="button"
              tabIndex={0}
              aria-label={uploadFile ? '重新选择上传文件' : '选择上传文件'}
              onClick={() => {
                if (!uploading) fileInputRef.current?.click();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  if (!uploading) fileInputRef.current?.click();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                if (!uploading) setUploadDragOver(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (!uploading) setUploadDragOver(true);
              }}
              onDragLeave={() => setUploadDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setUploadDragOver(false);
                if (!uploading) handlePickUploadFile(event.dataTransfer.files?.[0] ?? null);
              }}
              style={{
                border: `2px dashed ${uploadDragOver ? 'var(--color-primary)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-md)',
                padding: '24px 20px',
                textAlign: 'center',
                cursor: uploading ? 'default' : 'pointer',
                transition: 'all 0.2s ease',
                background: uploadDragOver ? 'var(--color-primary-light)' : 'var(--color-bg)',
                outline: 'none',
              }}
            >
              {uploadFile ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
                  <svg width="34" height="34" fill="none" viewBox="0 0 24 24" stroke="var(--color-success)">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>
                    {uploadFile.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                    {formatBytes(uploadFile.size)} · 点击或拖入其他文件可重新选择
                  </div>
                  <span className="btn btn-secondary btn-sm" style={{ pointerEvents: 'none' }}>重新选择文件</span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
                  <svg width="38" height="38" fill="none" viewBox="0 0 24 24" stroke={uploadDragOver ? 'var(--color-primary)' : 'var(--color-text-muted)'} style={{ transition: 'stroke 0.2s' }}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <div style={{ fontSize: 14, fontWeight: 700, color: uploadDragOver ? 'var(--color-primary)' : 'var(--color-text-primary)' }}>
                    {uploadDragOver ? '松开鼠标，选择这个文件' : '点击选择文件，或拖到这里'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                    文件会直接保存到机器数据盘
                  </div>
                  <span className="btn btn-primary btn-sm" style={{ pointerEvents: 'none' }}>选择文件</span>
                </div>
              )}
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
              <span>目标路径</span>
              <input
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                value={uploadPath}
                onChange={(event) => setUploadPath(event.target.value)}
                placeholder="/data/workspace/example.jar"
              />
            </label>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11, color: uploadFile ? 'var(--color-text-secondary)' : 'var(--color-text-muted)' }}>
                {uploadFile ? `已选择：${uploadFile.name}` : '请先选择要上传的文件'}
              </div>
              <button type="button" className="btn btn-primary btn-sm" disabled={!uploadFile || uploading} onClick={() => void handleUploadFile()}>
                {uploading ? `上传中${uploadFile ? ` · ${formatBytes(uploadFile.size)}` : ''}…` : '上传到机器'}
              </button>
            </div>
            {uploading ? (
              <div style={{ height: 4, overflow: 'hidden', borderRadius: 999, background: 'var(--color-border-light)' }}>
                <div style={{ width: '45%', height: '100%', borderRadius: 999, background: 'var(--color-primary)', animation: 'pulse 1.2s ease-in-out infinite' }} />
              </div>
            ) : null}
            {uploadResult ? (
              <div className="alert alert-info" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, lineHeight: 1.65 }}>
                <span>已保存：<code>{uploadResult.path}</code></span>
                <span>大小：{formatBytes(uploadResult.size)} · 权限：{uploadResult.mode} · {uploadResult.created ? '新建' : '覆盖'}</span>
                <span style={{ wordBreak: 'break-all' }}>SHA-256：{uploadResult.sha256 || '-'}</span>
              </div>
            ) : null}
          </div>
        </div>
      </CenteredModal>

      <CenteredModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="删除 InstaBox 机器"
        maxWidth={520}
        footer={(
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setDeleteTarget(null)}>取消</button>
            <button type="button" className="btn btn-danger" disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? '删除中…' : '确认删除'}
            </button>
          </div>
        )}
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          确认删除 <strong>{deleteTarget?.name || deleteTarget?.id}</strong>？
          <div style={{ marginTop: 8, color: '#dc2626', fontSize: 12 }}>机器、系统文件和数据盘都会被永久删除，无法恢复。</div>
        </div>
      </CenteredModal>

      <CenteredModal
        open={!!portsTarget}
        onClose={() => setPortsTarget(null)}
        title={`${portsTarget?.name || '机器'} · 端口`}
        maxWidth={760}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!portsEnabled ? (
            <div className="alert alert-error">当前 InstaBox 服务未启用公网端口。</div>
          ) : null}
          {portsLoading ? (
            <div className="skeleton" style={{ height: 80, borderRadius: 8 }} />
          ) : ports.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>还没有发布端口。</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ports.map((port) => {
                const accessUrl = port.tokenUrl || port.url || '';
                return (
                  <div key={`${port.id || port.port}`} style={{ border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {port.port} · {port.name || '未命名'}
                        <span className={`badge ${port.access === 'private' ? 'badge-warning' : 'badge-success'}`} style={{ marginLeft: 8 }}>
                          {port.access === 'private' ? '私有' : '公开'}
                        </span>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 10, color: 'var(--color-text-muted)', wordBreak: 'break-all' }}>{accessUrl || '-'}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {accessUrl ? (
                        <>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.open(accessUrl, '_blank', 'noopener,noreferrer')}>打开</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyText(accessUrl, '端口地址')}>复制</button>
                        </>
                      ) : null}
                      <button type="button" className="btn btn-danger btn-sm" disabled={removingPort === port.port} onClick={() => void handleUnpublishPort(port)}>
                        {removingPort === port.port ? '取消中…' : '取消发布'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--color-border-light)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>发布新端口</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
              <input style={inputStyle} inputMode="numeric" placeholder="端口，如 3000" value={portValue} onChange={(event) => setPortValue(event.target.value.replace(/[^0-9]/g, ''))} />
              <input style={inputStyle} placeholder="名称（可选）" value={portName} onChange={(event) => setPortName(event.target.value)} />
              <select style={inputStyle} value={portAccess} onChange={(event) => setPortAccess(event.target.value === 'private' ? 'private' : 'public')}>
                <option value="public">公开访问</option>
                <option value="private">私有访问</option>
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={publishingPort || !portsEnabled} onClick={() => void handlePublishPort()}>
                {publishingPort ? '发布中…' : '发布端口'}
              </button>
            </div>
          </div>
        </div>
      </CenteredModal>
    </div>
  );
}
