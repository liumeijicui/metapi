import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('默认测试提示词与使用日志清空', () => {
  const promptLibrary = readFileSync(resolve(process.cwd(), 'src/web/pages/PromptLibrary.tsx'), 'utf8');
  const proxyLogs = readFileSync(resolve(process.cwd(), 'src/web/pages/ProxyLogs.tsx'), 'utf8');

  it('提示词管理可以设置默认测试提示词，并高亮当前默认项', () => {
    expect(promptLibrary).toContain('const [defaultCaseId, setDefaultCaseId] = useState<number | null>(null);');
    expect(promptLibrary).toContain('api.getSimplePromptCases()');
    expect(promptLibrary).toContain('response?.defaultCaseId');
    expect(promptLibrary).toContain('api.setDefaultPromptCase(nextId)');
    // 页面顶部有独立的默认提示词区块，支持搜索选择，也能在行内一键设为默认。
    expect(promptLibrary).toContain("tr('默认测试提示词')");
    expect(promptLibrary).toContain('placeholder={tr(\'搜索并选择默认题目\')}');
    expect(promptLibrary).toContain("tr('设默认')");
    expect(promptLibrary).toContain("tr('清除')");
    expect(promptLibrary).toContain("tr('默认')");
    // 删除默认题目时同步清除默认值。
    expect(promptLibrary).toContain('if (deleteTarget.id === defaultCaseId) {');
    expect(promptLibrary).toContain('api.setDefaultPromptCase(null)');
  });

  it('使用日志提供带确认框的清空按钮', () => {
    expect(proxyLogs).toContain('const [clearConfirmOpen, setClearConfirmOpen] = useState(false);');
    expect(proxyLogs).toContain('const [clearingLogs, setClearingLogs] = useState(false);');
    expect(proxyLogs).toContain('await api.clearProxyLogs();');
    expect(proxyLogs).toContain('清空日志');
    expect(proxyLogs).toContain('清空使用日志');
    expect(proxyLogs).toContain('确认清空');
    expect(proxyLogs).toContain('删除后不可恢复');
    expect(proxyLogs).toContain('onClick={() => void handleClearLogs()}');
  });
});
